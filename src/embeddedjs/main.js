/*
 * main.js — Transit Glance watch app (runs ON THE WATCH, XS engine).
 *
 * Screens:
 *   LIST     — favorites (★) followed by nearby stops, scroll with Up/Down,
 *              Select opens arrivals for the highlighted stop.
 *   ARRIVALS — live predictions for one stop, auto-refreshes every 60 s.
 *              Select toggles ★ favorite. Back returns to the list.
 *
 * Rendering uses Poco (immediate-mode drawing) rather than Piu because a
 * scrolling list with full redraws is simpler and uses less RAM this way.
 * See CLAUDE.md for the reasoning and for how to swap in Piu if desired.
 *
 * All networking happens on the phone — see src/pkjs/. This file only talks
 * to protocol.js.
 */

import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Timer from "timer";
import Location from "embedded:sensor/Location";
import protocol from "./protocol";
import { loadFavorites, isFavorite, toggleFavorite } from "./favorites";

/* ---------------------------------------------------------------- render */

const render = new Poco(screen);
const fontHeader = new render.Font("Gothic-Bold", 18);
const fontRow = new render.Font("Gothic-Bold", 18);
const fontSub = new render.Font("Gothic-Regular", 14);
const fontBig = new render.Font("Leco-Bold", 26);
const fontNow = new render.Font("Leco-Bold", 20); // "Now" label — 2/3 of fontBig; 20 is the closest valid Leco-Bold size
const fontLine = new render.Font("Gothic-Bold", 24); // bus/route number, arrivals screen

const BLACK = render.makeColor(0, 0, 0);
const WHITE = render.makeColor(255, 255, 255);
const ACCENT = render.makeColor(0, 85, 255);   // header / selection
const GRAY = render.makeColor(120, 120, 120);
const DIR_GRAY = render.makeColor(60, 60, 60); // destination text — higher contrast than GRAY

// Distinguishable colors cycled across route lines so easily-confused
// numbers (e.g. "38" vs "38R") read apart at a glance.
const LINE_COLORS = [
  render.makeColor(0, 90, 200),
  render.makeColor(200, 30, 30),
  render.makeColor(0, 140, 60),
  render.makeColor(140, 40, 180),
  render.makeColor(210, 110, 0),
  render.makeColor(0, 130, 130)
];

function colorForLine(line) {
  let hash = 0;
  for (let i = 0; i < line.length; i++) hash = (hash * 31 + line.charCodeAt(i)) | 0;
  return LINE_COLORS[Math.abs(hash) % LINE_COLORS.length];
}

const HEADER_H = 28;
const ROW_H = 40;
const ARRIVAL_ROW_H = 44;
const VISIBLE_ROWS = Math.floor((render.height - HEADER_H) / ROW_H);

// draw() must stay ALLOCATION-FREE (docs/WATCH-DEBUGGING-PLAYBOOK.md §B):
// string churn in the render path fragments this watch's tiny heap until an
// allocation fails ("memory full") with plenty of total free space. All text
// is fitted/concatenated once when the underlying data changes, stored, and
// only *drawn* here. Layout metrics are hoisted for the same reason.
const LIST_TEXT_W = render.width - 12;
const ARRIVAL_TEXT_X = 6 + render.getTextWidth("88", fontBig) + 8;
const ARRIVAL_TEXT_W = render.width - ARRIVAL_TEXT_X - 4;
const HINT_IS_FAV = "★ favorited — Select to remove";
const HINT_NOT_FAV = "Select to ★ favorite";

// Favorites farther than this (or with nothing arriving) draw dimmed.
// 12 miles — keep in sync with ARRIVAL_CHECK_MAX_M in src/pkjs/transit511.js.
const FAR_METERS = 19312;

/* ----------------------------------------------------------------- state */

const MODE_LIST = 0;
const MODE_ARRIVALS = 1;

const state = {
  mode: MODE_LIST,
  status: "Locating…",        // status line when a screen has no rows yet
  favorites: loadFavorites(), // [{agency, code, name}]
  favStatus: new Map(),       // "agency:code" -> {dist, hasArr} from the phone
  nearby: [],                 // [{agency, code, name, dist}]
  rows: [],                   // flattened list rows currently shown
  sel: 0,                     // selected row index
  top: 0,                     // first visible row index (scroll window)
  stop: null,                 // stop shown on the ARRIVALS screen
  stopTitle: "",              // precomputed header text for the ARRIVALS screen
  stopIsFav: false,           // cached — reading favorites re-parses JSON, keep out of draw()
  arrivals: [],               // [{line, dest, min, + precomputed display fields}]
  arrivalsStatus: "Loading…",
  refreshTimer: null,
  lastFix: null,              // {lat, lon}
  locationPending: false      // true while a Location() request is in flight
};

/* ------------------------------------------------------------------ list */

function rebuildRows() {
  // Distance fallback for favorites toggled since the last nearby refresh:
  // they aren't in favStatus yet, but may be in the nearby results.
  const nearbyDist = new Map(state.nearby.map(s => [s.agency + ":" + s.code, s.dist]));

  const rows = state.favorites.map(f => {
    const key = f.agency + ":" + f.code;
    const st = state.favStatus.get(key);
    const row = { ...f, fav: true };
    if (st && st.dist >= 0) row.dist = st.dist;
    else if (nearbyDist.has(key)) row.dist = nearbyDist.get(key);
    row.noArr = !!st && st.hasArr === 0;
    row.dim = row.noArr || (row.dist !== undefined && row.dist > FAR_METERS);
    return row;
  });
  // Nearest favorites first; unknown distances sink to the bottom (sort is
  // stable, so those keep their saved order).
  rows.sort((x, y) =>
    (x.dist === undefined ? Infinity : x.dist) -
    (y.dist === undefined ? Infinity : y.dist));

  const favKeys = new Set(state.favorites.map(f => f.agency + ":" + f.code));
  for (const s of state.nearby) {
    if (!favKeys.has(s.agency + ":" + s.code)) rows.push({ ...s, fav: false });
  }
  // Fit all row text now, once — draw() only reads these (see comment at top).
  for (const row of rows) {
    row.title = ellipsize((row.fav ? "★ " : "") + row.name, fontRow, LIST_TEXT_W);
    row.subtitle = ellipsize(
      row.agency +
        (row.dist !== undefined ? "  ·  " + formatDist(row.dist) : "") +
        (row.noArr ? "  ·  no arrivals" : ""),
      fontSub, LIST_TEXT_W);
  }
  state.rows = rows;
  if (state.sel >= rows.length) state.sel = Math.max(0, rows.length - 1);
  clampScroll();
}

function clampScroll() {
  if (state.sel < state.top) state.top = state.sel;
  if (state.sel >= state.top + VISIBLE_ROWS) state.top = state.sel - VISIBLE_ROWS + 1;
  if (state.top < 0) state.top = 0;
}

/* ------------------------------------------------------------------ draw */

function drawHeader(title) {
  render.fillRectangle(ACCENT, 0, 0, render.width, HEADER_H);
  const w = render.getTextWidth(title, fontHeader);
  render.drawText(title, fontHeader, WHITE, (render.width - w) >> 1, 4);
}

// Binary search the cut point instead of trimming one character at a time:
// the naive loop did a fresh `str + "…"` concat AND a `str.slice()` on every
// single character trimmed (dozens of throwaway string allocations for a
// long name), called for every row on every draw(). On this watch's tiny
// heap, that churn adds up across a session (more scrolling/refreshing,
// busier stops with more text = more allocations) until an unrelated
// allocation fails from fragmentation despite free space existing elsewhere
// — a real "Alloy: Fatal Error / memory full" seen in testing. Binary search
// still allocates a substring per probe, but O(log n) instead of O(n).
// Even that wasn't enough when called from draw() (the crash recurred), so
// this now runs only when data changes (rebuildRows/prepareArrivals) — never
// call it from the render path.
function ellipsize(str, font, maxWidth) {
  if (render.getTextWidth(str, font) <= maxWidth) return str;
  const budget = maxWidth - render.getTextWidth("…", font);
  let lo = 1, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (render.getTextWidth(str.slice(0, mid), font) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo) + "…";
}

function draw() {
  render.begin();
  render.fillRectangle(WHITE, 0, 0, render.width, render.height);

  if (state.mode === MODE_LIST) {
    drawHeader("Transit Glance");
    if (!state.rows.length) {
      render.drawText(state.status, fontSub, GRAY, 8, HEADER_H + 12);
    } else {
      for (let i = 0; i < VISIBLE_ROWS; i++) {
        const idx = state.top + i;
        if (idx >= state.rows.length) break;
        const row = state.rows[idx];
        const y = HEADER_H + i * ROW_H;
        const selected = idx === state.sel;
        if (selected) render.fillRectangle(ACCENT, 0, y, render.width, ROW_H);
        // Dimmed rows (favorite too far away / nothing arriving) go gray;
        // selection stays white-on-accent so it's always readable.
        const fg = selected ? WHITE : row.dim ? GRAY : BLACK;
        const sub = selected ? WHITE : GRAY;
        render.drawText(row.title, fontRow, fg, 6, y + 2);
        render.drawText(row.subtitle, fontSub, sub, 6, y + 22);
      }
    }
  } else {
    drawHeader(state.stop ? state.stopTitle : "Arrivals");
    if (!state.arrivals.length) {
      render.drawText(state.arrivalsStatus, fontSub, GRAY, 8, HEADER_H + 12);
    } else {
      let y = HEADER_H + 4;
      for (const a of state.arrivals) {
        if (y + ARRIVAL_ROW_H > render.height) break;
        render.drawText(a.minStr, a.minFont, BLACK, 6, y);
        render.drawText(a.lineText, fontLine, a.lineColor, ARRIVAL_TEXT_X, y);
        render.drawText(a.destText, fontSub, DIR_GRAY, ARRIVAL_TEXT_X, y + 26);
        y += ARRIVAL_ROW_H;
      }
    }
    // Footer hint: favorite state (cached — never read storage from draw())
    if (state.stop) {
      render.drawText(state.stopIsFav ? HINT_IS_FAV : HINT_NOT_FAV,
                      fontSub, GRAY, 6, render.height - 18);
    }
  }
  render.end();
}

// Attach everything draw() needs to each arrival, once per response.
function prepareArrivals(list) {
  for (const a of list) {
    a.minStr = a.min <= 0 ? "Now" : String(a.min);
    a.minFont = a.min <= 0 ? fontNow : fontBig;
    a.lineColor = colorForLine(a.line);
    a.lineText = ellipsize(a.line, fontLine, ARRIVAL_TEXT_W);
    a.destText = ellipsize(a.dest, fontSub, ARRIVAL_TEXT_W);
  }
  return list;
}

function shortName(name) {
  return name.length > 18 ? name.slice(0, 17) + "…" : name;
}

function formatDist(meters) {
  if (meters < 1000) return Math.round(meters) + " m";
  return (meters / 1000).toFixed(1) + " km";
}

/* ------------------------------------------------------------- data flow */

function requestLocationAndNearby() {
  if (state.locationPending) return; // a request is already in flight
  state.status = "Locating…";
  draw();
  const location = new Location({
    onSample() {
      state.locationPending = false;
      const sample = this.sample();
      this.close();
      if (!sample) {
        state.status = "No location";
        draw();
        return;
      }
      state.lastFix = { lat: sample.latitude, lon: sample.longitude };
      fetchNearby();
    },
    onError() {
      state.locationPending = false;
      this.close();
      state.status = "No location";
      draw();
    }
  });
  state.locationPending = true;
  location.configure({ enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 });
}

function fetchNearby() {
  if (!state.lastFix) return requestLocationAndNearby();
  state.status = "Finding stops…";
  draw();
  const favKeys = state.favorites.map(f => f.agency + ":" + f.code);
  protocol.nearbyStops(state.lastFix.lat, state.lastFix.lon, favKeys)
    .then(resp => {
      state.nearby = resp.stops || [];
      state.favStatus = new Map();
      if (Array.isArray(resp.favs)) {
        for (const f of resp.favs) {
          state.favStatus.set(f.a + ":" + f.c, { dist: f.d, hasArr: f.h });
        }
      }
      state.status = state.nearby.length ? "" : "No stops nearby";
      rebuildRows();
      draw();
    })
    .catch(err => {
      console.log("nearby failed: " + err.message);
      state.status = "Error: " + err.message;
      draw();
    });
}

function openArrivals(stop) {
  state.mode = MODE_ARRIVALS;
  state.stop = stop;
  state.stopTitle = shortName(stop.name);
  state.stopIsFav = isFavorite(stop);
  state.arrivals = [];
  state.arrivalsStatus = "Loading…";
  draw();
  fetchArrivals();
  // Auto-refresh while this screen is open. 60 s keeps us well inside the
  // 511.org rate limit (60 requests/hour shared across the whole app).
  stopRefreshTimer();
  state.refreshTimer = Timer.repeat(fetchArrivals, 60000);
}

function fetchArrivals() {
  if (!state.stop) return;
  protocol.arrivals(state.stop.agency, state.stop.code)
    .then(resp => {
      if (state.mode !== MODE_ARRIVALS) return;
      state.arrivals = prepareArrivals(resp.arrivals || []);
      state.arrivalsStatus = state.arrivals.length ? "" : "No arrivals";
      draw();
    })
    .catch(err => {
      if (state.mode !== MODE_ARRIVALS) return;
      console.log("arrivals failed: " + err.message);
      if (!state.arrivals.length) {
        state.arrivalsStatus = "Error: " + err.message;
        draw();
      }
    });
}

function stopRefreshTimer() {
  if (state.refreshTimer) {
    Timer.clear(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function closeArrivals() {
  stopRefreshTimer();
  state.mode = MODE_LIST;
  state.stop = null;
  state.arrivals = [];
  state.favorites = loadFavorites();
  rebuildRows();
  draw();
}

/* --------------------------------------------------------------- buttons */

// NOTE: registering "back" replaces its single-tap auto-exit behavior with
// whatever we do below. We restore single-tap exit ourselves on the list
// (root) screen via watch.exit() — see the Alloy globals (CLAUDE.md section 2).
new Button({
  types: ["select", "up", "down", "back"],
  onPush(down, type) {
    if (!down) return; // act on press only
    if (state.mode === MODE_LIST) {
      if (type === "up") {
        if (state.sel > 0) { state.sel--; clampScroll(); draw(); }
        else requestLocationAndNearby(); // already at top: pull to refresh
      } else if (type === "down" && state.sel < state.rows.length - 1) {
        state.sel++; clampScroll(); draw();
      } else if (type === "select" && state.rows.length) {
        openArrivals(state.rows[state.sel]);
      } else if (type === "back") {
        watch.exit();
      }
    } else {
      if (type === "select" && state.stop) {
        state.stopIsFav = toggleFavorite(state.stop);
        draw(); // footer hint updates
      } else if (type === "back") {
        closeArrivals();
      } else if (type === "up" || type === "down") {
        fetchArrivals(); // manual refresh
      }
    }
  }
});

/* ----------------------------------------------------------------- start */

// Re-run nearby search when the phone-side settings change (e.g. the user
// enabled another agency or entered an API key).
protocol.onSettingsChanged = () => {
  if (state.mode === MODE_LIST) fetchNearby();
};

rebuildRows();
draw();

// Networking through the phone only works once PebbleKit JS is up.
if (watch.connected.pebblekit) {
  requestLocationAndNearby();
} else {
  state.status = "Waiting for phone…";
  draw();
  watch.addEventListener("connected", function onConn() {
    if (watch.connected.pebblekit) {
      requestLocationAndNearby();
    }
  });
}
