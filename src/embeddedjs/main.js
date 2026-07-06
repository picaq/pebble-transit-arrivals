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

const BLACK = render.makeColor(0, 0, 0);
const WHITE = render.makeColor(255, 255, 255);
const ACCENT = render.makeColor(0, 85, 255);   // header / selection
const GRAY = render.makeColor(120, 120, 120);

const HEADER_H = 28;
const ROW_H = 40;
const VISIBLE_ROWS = Math.floor((render.height - HEADER_H) / ROW_H);

/* ----------------------------------------------------------------- state */

const MODE_LIST = 0;
const MODE_ARRIVALS = 1;

const state = {
  mode: MODE_LIST,
  status: "Locating…",        // status line when a screen has no rows yet
  favorites: loadFavorites(), // [{agency, code, name}]
  nearby: [],                 // [{agency, code, name, dist}]
  rows: [],                   // flattened list rows currently shown
  sel: 0,                     // selected row index
  top: 0,                     // first visible row index (scroll window)
  stop: null,                 // stop shown on the ARRIVALS screen
  arrivals: [],               // [{line, dest, min}]
  arrivalsStatus: "Loading…",
  refreshTimer: null,
  lastFix: null,              // {lat, lon}
  locationPending: false      // true while a Location() request is in flight
};

/* ------------------------------------------------------------------ list */

function rebuildRows() {
  const favKeys = new Set(state.favorites.map(f => f.agency + ":" + f.code));
  const rows = state.favorites.map(f => ({ ...f, fav: true }));
  for (const s of state.nearby) {
    if (!favKeys.has(s.agency + ":" + s.code)) rows.push({ ...s, fav: false });
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

function ellipsize(str, font, maxWidth) {
  if (render.getTextWidth(str, font) <= maxWidth) return str;
  while (str.length > 1 && render.getTextWidth(str + "…", font) > maxWidth) {
    str = str.slice(0, -1);
  }
  return str + "…";
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
        const fg = selected ? WHITE : BLACK;
        const sub = selected ? WHITE : GRAY;
        const prefix = row.fav ? "★ " : "";
        render.drawText(
          ellipsize(prefix + row.name, fontRow, render.width - 12),
          fontRow, fg, 6, y + 2);
        const subtitle = row.agency +
          (row.dist !== undefined ? "  ·  " + formatDist(row.dist) : "");
        render.drawText(subtitle, fontSub, sub, 6, y + 22);
      }
    }
  } else {
    drawHeader(state.stop ? shortName(state.stop.name) : "Arrivals");
    if (!state.arrivals.length) {
      render.drawText(state.arrivalsStatus, fontSub, GRAY, 8, HEADER_H + 12);
    } else {
      let y = HEADER_H + 4;
      for (const a of state.arrivals) {
        if (y + ROW_H > render.height) break;
        const minStr = a.min <= 0 ? "Now" : String(a.min);
        render.drawText(minStr, fontBig, BLACK, 6, y);
        const textX = 6 + render.getTextWidth("88", fontBig) + 8;
        render.drawText(
          ellipsize(a.line, fontRow, render.width - textX - 4),
          fontRow, BLACK, textX, y);
        render.drawText(
          ellipsize(a.dest, fontSub, render.width - textX - 4),
          fontSub, GRAY, textX, y + 20);
        y += ROW_H;
      }
    }
    // Footer hint: favorite state
    if (state.stop) {
      const hint = isFavorite(state.stop) ? "★ favorited — Select to remove"
                                          : "Select to ★ favorite";
      render.drawText(hint, fontSub, GRAY, 6, render.height - 18);
    }
  }
  render.end();
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
  protocol.nearbyStops(state.lastFix.lat, state.lastFix.lon)
    .then(resp => {
      state.nearby = resp.stops || [];
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
      state.arrivals = resp.arrivals || [];
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
        toggleFavorite(state.stop);
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
