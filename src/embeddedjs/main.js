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
import protocol from "./protocol";

// NOTE ON CODE SIZE: this module's compiled bytecode loads into the same
// 32 KB XS arena as the runtime heap (playbook §B) — keep the watch side
// thin. Formatting, sorting, merging, and the favorites list live on the
// PHONE (src/pkjs); this file only draws rows, fits text to the screen,
// and handles buttons.

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

/* ----------------------------------------------------------------- state */

const MODE_LIST = 0;
const MODE_ARRIVALS = 1;

const state = {
  mode: MODE_LIST,
  status: "Loading…",         // status line when a screen has no rows yet
  rows: [],                   // display rows currently shown
  sel: 0,                     // selected row index
  top: 0,                     // first visible row index (scroll window)
  stop: null,                 // stop shown on the ARRIVALS screen
  stopTitle: "",              // precomputed header text for the ARRIVALS screen
  stopIsFav: false,           // cached — reading favorites re-parses JSON, keep out of draw()
  arrivals: [],               // [{line, dest, min, + display fields fitted in draw()}]
  arrivalsPending: false,     // in-flight guard — see fetchArrivals()
  arrivalsStatus: "Loading…",
  refreshTimer: null,
  nearbyPending: false,       // in-flight guard — see fetchNearby()
  favPending: false           // in-flight guard for the favorite toggle
};

/* ------------------------------------------------------------------ list */

// Rows arrive from the phone pre-merged (favorites first, nearest first),
// pre-sorted, flagged, and with subtitles already formatted. Convert the
// parsed response to display rows and let the payload tree be collected —
// an earlier design retained it (state.rowsSrc), which held ~2-3 KB of
// chunk heap hostage and made every warm refresh crash "memory full" while
// parsing the next response beside it (playbook §B). Text fitting happens
// lazily in draw() — fitVisibleRows().
function setRowsFromResponse(list) {
  state.rows = list.map(r => ({
    agency: r.a, code: r.c, name: r.n, sub: r.s, fav: !!r.f, dim: !!r.m
  }));
  if (state.sel >= state.rows.length) state.sel = Math.max(0, state.rows.length - 1);
  clampScroll();
}

// Fit a row's text once; cached on the row, so steady-state draws allocate
// nothing. Called only from draw(), inside begin()/end() — the only place
// text measurement has proven safe on this platform (playbook §B/§F).
function fitVisibleRows() {
  const end = Math.min(state.rows.length, state.top + VISIBLE_ROWS);
  for (let i = state.top; i < end; i++) {
    const row = state.rows[i];
    if (row.title === undefined) {
      row.title = ellipsize((row.fav ? "★ " : "") + row.name, fontRow, LIST_TEXT_W);
      row.subtitle = ellipsize(row.sub, fontSub, LIST_TEXT_W);
    }
  }
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
// Called only from draw(), inside begin()/end(), at most once per row —
// results are cached on the row (see fitVisibleRows / the arrivals loop).
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
    fitVisibleRows(); // no-op once the visible rows are fitted
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
        if (a.lineText === undefined) {
          // Fit lazily, in-frame, once per arrival (see fitVisibleRows()).
          a.lineText = ellipsize(a.line, fontLine, ARRIVAL_TEXT_W);
          a.destText = ellipsize(a.dest, fontSub, ARRIVAL_TEXT_W);
        }
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

// Cheap per-arrival display fields; text fitting happens in draw() (in-frame).
function prepareArrivals(list) {
  for (const a of list) {
    a.minStr = a.min <= 0 ? "Now" : String(a.min);
    a.minFont = a.min <= 0 ? fontNow : fontBig;
    a.lineColor = colorForLine(a.line);
  }
  return list;
}

function shortName(name) {
  return name.length > 18 ? name.slice(0, 17) + "…" : name;
}

/* ------------------------------------------------------------- data flow */

// One-time migration: favorites used to live in watch localStorage. Send the
// raw legacy JSON with nearby requests until one succeeds, then delete it —
// after that the phone is the only owner of the favorites list.
let migFavs = localStorage.getItem("favorites.v1");

// The phone takes the location fix itself (navigator.geolocation in pkjs)
// and answers with a display-ready rows list. In-flight guard: pull-to-
// refresh (Up at the top of the list) must be a no-op while a request is
// out — stacked cycles pin live memory (playbook §B).
function fetchNearby() {
  if (state.nearbyPending) return;
  state.nearbyPending = true;
  state.status = "Finding stops…";
  draw();
  protocol.nearbyStops(migFavs)
    .then(resp => {
      state.nearbyPending = false;
      if (migFavs) {
        migFavs = null;
        localStorage.removeItem("favorites.v1");
      }
      setRowsFromResponse(resp.rows || []);
      state.status = state.rows.length ? "" : "No stops nearby";
      draw();
    })
    .catch(err => {
      state.nearbyPending = false;
      console.log("nearby failed: " + err.message);
      state.status = "Error: " + err.message;
      draw();
    });
}

function openArrivals(stop) {
  state.mode = MODE_ARRIVALS;
  state.stop = stop;
  state.stopTitle = shortName(stop.name);
  state.stopIsFav = stop.fav; // rows arrive flagged from the phone
  // Release the list rows' fitted text while this screen's refresh cycles
  // own the heap — draw() refits the visible rows on return. Frees ~1 KB
  // of chunk space on a heap that crashes over less (playbook §B).
  for (const row of state.rows) {
    row.title = undefined;
    row.subtitle = undefined;
  }
  state.arrivals = [];
  // Reset the guard so a still-in-flight request for a previous stop can't
  // block this screen's first fetch (its late response is ignored by the
  // identity check in fetchArrivals).
  state.arrivalsPending = false;
  state.arrivalsStatus = "Loading…";
  draw();
  fetchArrivals();
  // Auto-refresh while this screen is open. 60 s keeps us well inside the
  // 511.org rate limit (60 requests/hour shared across the whole app).
  stopRefreshTimer();
  state.refreshTimer = Timer.repeat(fetchArrivals, 60000);
}

// In-flight guard: Up/Down on the arrivals screen (and the 60 s auto-refresh
// timer) land here, and WITHOUT the guard each press launched a whole
// concurrent request cycle — pending-map entry, timeout timer, ~1 KB response
// string, JSON.parse, prepareArrivals — all of it live (unreclaimable) until
// its round trip finished. Hammering the button stacked enough simultaneous
// cycles to abort the VM with "memory full" on real hardware. Extra presses
// while a refresh is in flight are now no-ops.
function fetchArrivals() {
  if (!state.stop || state.arrivalsPending) return;
  state.arrivalsPending = true;
  const requested = state.stop;
  protocol.arrivals(requested.agency, requested.code)
    .then(resp => {
      state.arrivalsPending = false;
      if (state.mode !== MODE_ARRIVALS || state.stop !== requested) return;
      state.arrivals = prepareArrivals(resp.arrivals || []);
      state.arrivalsStatus = state.arrivals.length ? "" : "No arrivals";
      draw();
    })
    .catch(err => {
      state.arrivalsPending = false;
      if (state.mode !== MODE_ARRIVALS || state.stop !== requested) return;
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
        else fetchNearby(); // already at top: pull to refresh
      } else if (type === "down" && state.sel < state.rows.length - 1) {
        state.sel++; clampScroll(); draw();
      } else if (type === "select" && state.rows.length) {
        openArrivals(state.rows[state.sel]);
      } else if (type === "back") {
        watch.exit();
      }
    } else {
      if (type === "select" && state.stop && !state.favPending) {
        // Favorites live on the phone; toggle there. In-flight guard so a
        // mashed Select can't stack request cycles (playbook §B).
        state.favPending = true;
        const stop = state.stop;
        protocol.toggleFav(stop.agency, stop.code, stop.name)
          .then(resp => {
            state.favPending = false;
            stop.fav = !!resp.fav;
            stop.title = undefined; // refit with/without the ★ on return
            if (state.stop === stop) {
              state.stopIsFav = stop.fav;
              draw(); // footer hint updates
            }
          })
          .catch(() => { state.favPending = false; });
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

state.status = watch.connected.pebblekit ? "Connecting…" : "Waiting for phone…";
draw();

// The first nearby fetch is driven by the phone: pkjs sends a
// SettingsChanged ping from its "ready" handler (see src/pkjs/index.js),
// which lands in protocol.onSettingsChanged above. Requesting at boot
// instead would race pkjs startup — the watch boots first, the request
// goes out before the phone JS is listening, and it vanishes into a 15 s
// timeout. If the ping is ever lost, Up at the top of the list refreshes.
