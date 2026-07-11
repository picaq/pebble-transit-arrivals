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
const SUB_GRAY = render.makeColor(60, 60, 60); // subtitles/destination text — higher contrast than GRAY

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

// The phone may attach a color code ("k") to an arrival when the line has a
// canonical color — e.g. BART's color-named lines ("Yellow" → k="y") keep
// their full name but draw in it. Unknown/absent codes fall back to the hash
// above. Yellow is darkened so it stays readable on the white background.
const LINE_COLOR_CODES = {
  g: render.makeColor(0, 140, 60),
  y: render.makeColor(215, 170, 0),
  r: render.makeColor(200, 30, 30),
  o: render.makeColor(210, 110, 0),
  b: render.makeColor(0, 90, 200)
};

const HEADER_H = 28;
const ROW_H = 40;
const ARRIVAL_ROW_H = 44;
const VISIBLE_ROWS = Math.floor((render.height - HEADER_H) / ROW_H);
const VISIBLE_ARRIVALS = Math.floor((render.height - HEADER_H - 4) / ARRIVAL_ROW_H);
const MAX_LIST_ROWS = 14; // list "load more" cap (favorites + nearby) — keeps
                          // the on-watch list within the safe bound (playbook §B)
const ARR_DEFAULT = 6;  // arrivals requested on open
const ARR_MAX = 10;     // arrivals ceiling for "load more" (phone caps too)
const ARR_STEP = 4;     // arrivals added per "load more" (6 → 10)
// Minimum spacing between manual refreshes (Up at the top of either screen).
// The in-flight guards serialize request cycles but do NOT rate-limit them:
// the phone answers from cache in ~200 ms, so a mashed Up ran ~5 complete
// parse-and-rebuild cycles a second and crashed the heap (playbook §B,
// seventh recurrence). A cooldown is required alongside every guard.
const REFRESH_COOLDOWN_MS = 3000;
// How long after showing a stale list to run the fresh revalidation. It used
// to fire the instant the stale reply landed — which put a third full parse
// into the busiest second of the app's life (boot: stale parse + the user
// already opening a stop), beside data it had no room next to (playbook §B,
// eleventh recurrence). Deferred, it runs through the frame-hold refresh
// path instead, and only when the list screen is idle.
const REVALIDATE_DELAY_MS = 5000;

// draw() must stay ALLOCATION-FREE (docs/WATCH-DEBUGGING-PLAYBOOK.md §B):
// string churn in the render path fragments this watch's tiny heap until an
// allocation fails ("memory full") with plenty of total free space. All text
// is fitted/concatenated once when the underlying data changes, stored, and
// only *drawn* here. Layout metrics are hoisted for the same reason.
const LIST_TEXT_W = render.width - 12;
const ARRIVAL_TEXT_X = 6 + render.getTextWidth("88", fontBig) + 8;
const ARRIVAL_TEXT_W = render.width - ARRIVAL_TEXT_X - 4;
const HINT_IS_FAV = "★ hold Select to unfavorite";
const HINT_NOT_FAV = "Select to ★ favorite";
// Unfavoriting requires HOLDING Select this long (favoriting stays a tap —
// it's harmless and reversible; accidental unfavorites are what stung).
// Fires AT the threshold, mid-hold, via a timer — the footer flips while
// the button is still down, so the user knows it took before releasing.
const LONGPRESS_MS = 500;

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
  arrTop: 0,                   // first visible arrival (scroll window)
  arrLimit: ARR_DEFAULT,       // how many arrivals we ask the phone for
  arrivalsPending: false,     // in-flight guard — see fetchArrivals()
  arrivalsStatus: "Loading…",
  refreshTimer: null,
  nearbyPending: false,       // in-flight guard — see fetchNearby()
  moreExhausted: false,       // list "load more" reached the end (no more stops)
  favPending: false,          // in-flight guard for the favorite toggle
  refrOkAt: 0,                // manual-refresh cooldown deadline (Date.now() ms)
  revalTimer: null,           // deferred stale-list revalidation (scheduleRevalidate)
  selTimer: null,             // armed while Select is held on a ★ stop; fires the unfavorite
  refreshing: false,          // frame-hold (both screens): display data is
                              // RELEASED (heap!) but the last frame stays on
                              // screen with a "…" header indicator; draw()
                              // no-ops until whoever clears the flag repaints
                              // (gate at the top of draw())
  timeStr: "",                // precomputed clock text (see updateClock)
  minStamp: -1,               // last integer minute stamp — gates reformat/redraw
  timeX: 0,                   // cached right-aligned x for timeStr
  timeDirty: false            // timeStr changed → remeasure timeX inside draw()
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
  state.moreExhausted = false; // a full (re)load resets "load more" pagination
  clampScroll();
}

// Fit a row's text once; cached on the row WHILE it stays in the visible
// window, and released once it scrolls away. The cache used to be permanent,
// so scrolling a full 14-row list retained ~1 KB of fitted duplicates beside
// the originals — the chunk pool hit 288 B free and a within-budget refresh
// response faulted mid-parse (playbook §B, eighth recurrence). Retained
// fitted text is now bounded by the window, not the list length; steady-state
// draws still allocate nothing (comparisons only), and re-scrolling refits
// in-frame, 2 strings per step. Called only from draw(), inside
// begin()/end() — the only place text measurement has proven safe (§B/§F).
function fitVisibleRows() {
  const end = Math.min(state.rows.length, state.top + VISIBLE_ROWS);
  for (let i = 0; i < state.rows.length; i++) {
    const row = state.rows[i];
    if (i >= state.top && i < end) {
      if (row.title === undefined) {
        row.title = ellipsize((row.fav ? "★ " : "") + row.name, fontRow, LIST_TEXT_W);
        row.subtitle = ellipsize(row.sub, fontSub, LIST_TEXT_W);
      }
    } else if (row.title !== undefined) {
      row.title = undefined;
      row.subtitle = undefined;
    }
  }
}

function clampScroll() {
  if (state.sel < state.top) state.top = state.sel;
  if (state.sel >= state.top + VISIBLE_ROWS) state.top = state.sel - VISIBLE_ROWS + 1;
  if (state.top < 0) state.top = 0;
}

/* ------------------------------------------------------------------ draw */

function drawHeader(title, busy) {
  render.fillRectangle(ACCENT, 0, 0, render.width, HEADER_H);
  const w = render.getTextWidth(title, fontHeader);
  const x = (render.width - w) >> 1;
  render.drawText(title, fontHeader, WHITE, x, 4);
  // Refresh-pending indicator, drawn after the (still centered) title. "…"
  // because its glyph is proven in this font ("Loading…") — arrow glyphs
  // like ↻ are not in the Gothic tables and would render as a blank.
  if (busy) render.drawText("…", fontHeader, WHITE, x + w + 4, 4);
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

// Stamp the "…" refresh-pending indicator into the header band of the frame
// already on screen (partial Poco update — everything outside the band is
// untouched). Used by the frame-hold flow: this is the ONLY paint that may
// run while state.refreshing holds the frame.
function drawHeaderBusy(title) {
  render.begin(0, 0, render.width, HEADER_H);
  drawHeader(title, true);
  render.end();
}

function draw() {
  // Frame-hold gate (playbook §B, ninth/tenth recurrences): while a refresh
  // is in flight the display data is RELEASED (that's what lets the response
  // parse) and only the framebuffer still shows it — any repaint would blank
  // the screen. Gating here covers every draw path at once; whoever clears
  // state.refreshing must draw() the fresh data.
  if (state.refreshing) return;
  render.begin();
  render.fillRectangle(WHITE, 0, 0, render.width, render.height);

  if (state.mode === MODE_LIST) {
    fitVisibleRows(); // no-op once the visible rows are fitted
    drawHeader("Transit Glance", state.refreshing);
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
        // Dimmed rows (favorite with nothing arriving) go gray;
        // selection stays white-on-accent so it's always readable.
        const fg = selected ? WHITE : row.dim ? GRAY : BLACK;
        const sub = selected ? WHITE : row.dim ? GRAY : SUB_GRAY;
        render.drawText(row.title, fontRow, fg, 6, y + 2);
        render.drawText(row.subtitle, fontSub, sub, 6, y + 22);
      }
    }
  } else {
    drawHeader(state.stop ? state.stopTitle : "Arrivals");
    if (!state.arrivals.length) {
      render.drawText(state.arrivalsStatus, fontSub, GRAY, 8, HEADER_H + 12);
    } else {
      // Release fitted text outside the scroll window — same eviction policy
      // as fitVisibleRows (playbook §B, eighth recurrence): off-screen fitted
      // copies are retained weight while the 60 s auto-refresh parses beside
      // them. Keep one row of margin for the partially visible bottom row.
      for (let i = 0; i < state.arrivals.length; i++) {
        const a = state.arrivals[i];
        if ((i < state.arrTop || i > state.arrTop + VISIBLE_ARRIVALS) &&
            a.lineText !== undefined) {
          a.lineText = undefined;
          a.destText = undefined;
        }
      }
      let y = HEADER_H + 4;
      // Scrollable window: draw from state.arrTop (Up/Down scroll; Down at the
      // bottom loads more — see the button handler).
      for (let i = state.arrTop; i < state.arrivals.length; i++) {
        if (y + ARRIVAL_ROW_H > render.height) break;
        const a = state.arrivals[i];
        if (a.lineText === undefined) {
          // Fit lazily, in-frame, once per arrival (see fitVisibleRows()).
          a.lineText = ellipsize(a.line, fontLine, ARRIVAL_TEXT_W);
          a.destText = ellipsize(a.dest, fontSub, ARRIVAL_TEXT_W);
        }
        render.drawText(a.minStr, a.minFont, BLACK, 6, y);
        render.drawText(a.lineText, fontLine, a.lineColor, ARRIVAL_TEXT_X, y);
        render.drawText(a.destText, fontSub, SUB_GRAY, ARRIVAL_TEXT_X, y + 26);
        y += ARRIVAL_ROW_H;
      }
    }
    // Footer hint: favorite state (cached — never read storage from draw())
    if (state.stop) {
      render.drawText(state.stopIsFav ? HINT_IS_FAV : HINT_NOT_FAV,
                      fontSub, GRAY, 6, render.height - 18);
    }
  }

  // Clock overlay — bottom-right, on the footer/favorite-hint line, drawn last
  // so it hovers on top of any row or hint behind it. A box behind it keeps it
  // legible over whatever it covers. When the selected list row is the one the
  // clock sits over (the bottom-most visible row, drawn in ACCENT), the box
  // matches that blue and the text goes white so the clock blends into the
  // selection instead of punching a white hole in it. timeX is remeasured only
  // when the minute changes (timeDirty), in-frame, so steady-state draws
  // allocate nothing (playbook §B).
  if (state.timeStr) {
    if (state.timeDirty) {
      state.timeX = render.width - render.getTextWidth(state.timeStr, fontSub) - 4;
      state.timeDirty = false;
    }
    const ty = render.height - 18;
    // onSel: does the ACCENT-filled selected row overlap the clock band?
    // Only the bottom-most visible row's rect can reach ty (see VISIBLE_ROWS).
    let onSel = false;
    if (state.mode === MODE_LIST && state.rows.length) {
      const selVis = state.sel - state.top;
      if (selVis >= 0 && selVis < VISIBLE_ROWS) {
        const sy = HEADER_H + selVis * ROW_H;
        if (sy < ty + 16 && sy + ROW_H > ty - 1) onSel = true;
      }
    }
    render.fillRectangle(onSel ? ACCENT : WHITE,
                         state.timeX - 3, ty - 1, render.width - state.timeX + 3, 17);
    render.drawText(state.timeStr, fontSub, onSel ? WHITE : BLACK, state.timeX, ty);
  }
  render.end();
}

// Format the clock into state.timeStr and redraw, but only when the minute
// actually changes — the "secondchange" listener calls this every second, so
// the minute-stamp gate keeps us from reformatting/redrawing (and, crucially,
// from allocating a Date) on the 59 no-op ticks a minute. 12-hour, no leading
// zero, no AM/PM (e.g. "3:45").
function updateClock() {
  // secondchange fires every second. Gate on the integer minute stamp, which
  // Date.now() gives as a primitive (no allocation), so the 59 no-op ticks a
  // minute allocate NOTHING. Allocating a Date every second churned the tiny
  // chunk heap toward saturation between GCs — a "memory full" fragmentation
  // risk (playbook §B), and the likely cause of easy memory-full crashes.
  const ms = Date.now();
  const minStamp = (ms / 60000) | 0;
  if (minStamp === state.minStamp) return;
  state.minStamp = minStamp;
  const now = new Date(ms); // allocate a Date only on the real minute boundary
  const min = now.getMinutes();
  let h = now.getHours() % 12;
  if (h === 0) h = 12;
  state.timeStr = h + ":" + (min < 10 ? "0" + min : min);
  state.timeDirty = true;
  draw(); // no-ops during a frame-hold (gate inside draw)
}

// Cheap per-arrival display fields; text fitting happens in draw() (in-frame).
function prepareArrivals(list) {
  for (const a of list) {
    a.minStr = a.min <= 0 ? "Now" : String(a.min);
    a.minFont = a.min <= 0 ? fontNow : fontBig;
    a.lineColor = (a.k && LINE_COLOR_CODES[a.k]) || colorForLine(a.line);
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
// fresh: bypass the phone's instant stale reply (the revalidation follow-up).
// The phone answers a plain request instantly from its cached list (stale:1);
// we show it, then fire one fresh:1 follow-up here to replace it with live
// data. Only blank to "Finding stops…" when we have nothing to show, so a
// revalidate never wipes the list the user is looking at.
function fetchNearby(fresh) {
  if (state.nearbyPending) return;
  state.nearbyPending = true;
  if (!state.rows.length && !state.refreshing) { // hold the frame mid-refresh
    state.status = "Finding stops…";
    draw();
  }
  protocol.nearbyStops(migFavs, fresh)
    .then(resp => {
      state.nearbyPending = false;
      state.refreshing = false;
      const isStale = !!resp.stale;
      // Migration completes only on a real (non-stale) response — the stale
      // reply is served before the phone imports anything.
      if (migFavs && !isStale) {
        migFavs = null;
        localStorage.removeItem("favorites.v1");
      }
      setRowsFromResponse(resp.rows || []);
      state.status = state.rows.length ? "" : "No stops nearby";
      draw();
      // Revalidate the instant list — DEFERRED, not immediately: the fresh
      // response used to land ~1 s after boot and parse beside the stale
      // rows (and the arrivals of whatever stop the user had already
      // opened), with the chunk pool still ungrown — captured twice at
      // 172-340 B free (playbook §B, eleventh recurrence).
      if (isStale) scheduleRevalidate();
    })
    .catch(err => {
      state.nearbyPending = false;
      state.refreshing = false; // release the frame-hold: show the error
      console.log("nearby failed: " + err.message);
      if (!state.rows.length) {
        state.status = "Error: " + err.message;
        draw();
      }
    });
}

// Frame-hold refresh of the list (pull-to-refresh and the deferred stale
// revalidation): stamp the "…" indicator into the header band, release the
// rows — the framebuffer keeps the pixels, and the released ~1.2 KB+ is what
// lets the fresh response parse (a rows parse needs >1.6 KB of chunk,
// playbook §B ninth recurrence) — then fetch fresh. draw() self-gates on
// state.refreshing until the response lands. Callers ensure !nearbyPending.
function refreshList() {
  if (state.revalTimer) { // any fresh fetch satisfies a pending revalidation
    Timer.clear(state.revalTimer);
    state.revalTimer = null;
  }
  if (state.rows.length) {
    state.refreshing = true;
    state.status = "Refreshing…"; // insurance if a draw slips in
    drawHeaderBusy("Transit Glance");
    state.rows = [];
    state.sel = 0;
    state.top = 0;
  }
  fetchNearby(true);
}

// Deferred stale-list revalidation (see REVALIDATE_DELAY_MS): waits until the
// LIST screen is idle, retrying while the user is elsewhere — so the fresh
// parse lands beside a released list, never beside arrivals or boot churn.
function scheduleRevalidate() {
  if (state.revalTimer) Timer.clear(state.revalTimer);
  state.revalTimer = Timer.set(() => {
    state.revalTimer = null;
    if (state.mode === MODE_LIST && !state.nearbyPending) refreshList();
    else scheduleRevalidate(); // busy or on another screen — try again later
  }, REVALIDATE_DELAY_MS);
}

// "Load more stops": append the next page of farther non-favorite stops. The
// phone paginates from the offset (how many non-favorites we already show).
// Bounded by MAX_LIST_ROWS and stopped once the phone returns none, so the
// on-watch list can't grow without limit (playbook §B). Reuses the nearby
// in-flight guard so it can't stack with a refresh.
function fetchMore() {
  if (state.nearbyPending || state.moreExhausted) return;
  if (state.rows.length >= MAX_LIST_ROWS) return;
  let off = 0;
  for (let i = 0; i < state.rows.length; i++) if (!state.rows[i].fav) off++;
  state.nearbyPending = true;
  protocol.moreStops(off)
    .then(resp => {
      state.nearbyPending = false;
      const more = resp.rows || [];
      if (!more.length) { state.moreExhausted = true; return; }
      for (const r of more) {
        if (state.rows.length >= MAX_LIST_ROWS) break;
        state.rows.push({
          agency: r.a, code: r.c, name: r.n, sub: r.s, fav: false, dim: !!r.m
        });
      }
      draw();
    })
    .catch(err => {
      state.nearbyPending = false;
      console.log("more failed: " + err.message);
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
  state.arrTop = 0;               // top of the scroll window for this stop
  state.arrLimit = ARR_DEFAULT;   // reset "load more" growth per stop
  // Reset the guard so a still-in-flight request for a previous stop can't
  // block this screen's first fetch (its late response is ignored by the
  // identity check in fetchArrivals). Same for a frame-hold left by that
  // request — this screen draws fresh content now, so the hold must not
  // survive the transition (draw() would stay gated forever).
  state.arrivalsPending = false;
  state.refreshing = false;
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
  if (state.arrivals.length) {
    // Frame-hold, arrivals flavor (playbook §B, tenth recurrence): a 10-
    // arrival response parses beside the retained current list otherwise —
    // the same >1.6 KB-spike-beside-retained-data arithmetic that crashed
    // the list screen. Release before requesting; pixels stay up. Covers
    // manual refresh, "load more", and the 60 s auto-refresh alike.
    state.refreshing = true;
    state.arrivalsStatus = "Refreshing…"; // insurance if a draw slips in
    drawHeaderBusy(state.stopTitle);
    state.arrivals = [];
  }
  protocol.arrivals(requested.agency, requested.code, state.arrLimit)
    .then(resp => {
      state.arrivalsPending = false;
      state.refreshing = false; // release the hold before any early return
      if (state.mode !== MODE_ARRIVALS || state.stop !== requested) return;
      state.arrivals = prepareArrivals(resp.arrivals || []);
      // Keep the scroll window valid if a refresh returned fewer rows.
      if (state.arrTop >= state.arrivals.length) state.arrTop = 0;
      state.arrivalsStatus = state.arrivals.length ? "" : "No arrivals";
      draw();
    })
    .catch(err => {
      state.arrivalsPending = false;
      state.refreshing = false; // release the hold before any early return
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

// Toggle the current stop's favorite state on the phone (which owns the
// list). In-flight guard so repeated triggers can't stack request cycles
// (playbook §B). Callers decide the gesture: tap to favorite, long-press
// to unfavorite (see the button handler).
function toggleFav() {
  if (!state.stop || state.favPending) return;
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
}

function closeArrivals() {
  stopRefreshTimer();
  state.mode = MODE_LIST;
  state.stop = null;
  state.arrivals = [];
  // Back during an arrivals frame-hold: the hold belongs to the screen we
  // are leaving — clear it or this draw() (and every one after) no-ops.
  // The abandoned request's late response is ignored by its identity check.
  state.refreshing = false;
  draw();
}

/* --------------------------------------------------------------- buttons */

// NOTE: registering "back" replaces its single-tap auto-exit behavior with
// whatever we do below. We restore single-tap exit ourselves on the list
// (root) screen via watch.exit() — see the Alloy globals (CLAUDE.md section 2).
new Button({
  types: ["select", "up", "down", "back"],
  onPush(down, type) {
    if (!down) {
      // Releasing Select before the long-press timer fires cancels the
      // unfavorite (the unfavorite itself happens mid-hold, in the timer).
      if (state.selTimer) {
        Timer.clear(state.selTimer);
        state.selTimer = null;
      }
      return;
    }
    if (state.mode === MODE_LIST) {
      if (type === "up") {
        if (state.sel > 0) { state.sel--; clampScroll(); draw(); }
        else if (Date.now() >= state.refrOkAt) {
          // At the top: pull-to-refresh. fresh:1 always — the list data is
          // released below, so there is nothing to revalidate and the stale
          // echo would just add a second parse. Cooldown: REFRESH_COOLDOWN_MS.
          state.refrOkAt = Date.now() + REFRESH_COOLDOWN_MS;
          if (!state.nearbyPending) refreshList(); // else in flight: no-op
        }
      } else if (type === "down") {
        if (state.sel < state.rows.length - 1) {
          state.sel++; clampScroll(); draw();
        } else if (state.rows.length) {
          fetchMore(); // at the bottom: append more (farther) stops
        }
      } else if (type === "select" && state.rows.length) {
        openArrivals(state.rows[state.sel]);
      } else if (type === "back") {
        watch.exit();
      }
    } else {
      if (type === "select" && state.stop && !state.favPending) {
        // Tap favorites; unfavoriting needs a ≥LONGPRESS_MS hold so a stray
        // tap can't silently unstar a stop. The timer fires mid-hold; the
        // mode/fav re-checks make it a no-op if the screen or state changed
        // under it, and releasing early cancels it (release handler above).
        if (state.stop.fav) {
          state.selTimer = Timer.set(() => {
            state.selTimer = null;
            if (state.mode === MODE_ARRIVALS && state.stop && state.stop.fav) {
              toggleFav();
            }
          }, LONGPRESS_MS);
        } else {
          toggleFav();
        }
      } else if (type === "back") {
        closeArrivals();
      } else if (type === "up") {
        // Scroll up; at the very top, manual refresh — rate-limited like the
        // list's pull-to-refresh (the phone's 45 s arrivals cache answers
        // near-instantly, so the guard alone doesn't stop refresh-mashing).
        if (state.arrTop > 0) { state.arrTop--; draw(); }
        else if (Date.now() >= state.refrOkAt) {
          state.refrOkAt = Date.now() + REFRESH_COOLDOWN_MS;
          fetchArrivals();
        }
      } else if (type === "down") {
        // Scroll down; at the bottom, load more arrival times (no refresh).
        if (state.arrTop + VISIBLE_ARRIVALS < state.arrivals.length) {
          state.arrTop++; draw();
        } else if (state.arrivals.length >= state.arrLimit && state.arrLimit < ARR_MAX) {
          state.arrLimit = Math.min(ARR_MAX, state.arrLimit + ARR_STEP);
          fetchArrivals();
        }
      }
    }
  }
});

/* ----------------------------------------------------------------- start */

// Re-run nearby search when the phone-side settings change (e.g. the user
// enabled another agency or entered an API key).
protocol.onSettingsChanged = () => {
  if (state.mode === MODE_LIST) fetchNearby(false);
};

state.status = watch.connected.pebblekit ? "Connecting…" : "Waiting for phone…";
draw();

// Clock: tick the bottom-right time once a MINUTE via a Timer, aligned to the
// wall-clock boundary — not a per-second "secondchange" listener. A per-second
// wakeup churns the tiny heap every second for a display that only changes
// once a minute (playbook §B). Timer.set lands on the next minute boundary,
// then Timer.repeat holds the 60 s cadence.
updateClock(); // paint immediately
Timer.set(() => {
  updateClock();
  Timer.repeat(updateClock, 60000);
}, 60000 - (Date.now() % 60000));

// The first nearby fetch is driven by the phone: pkjs sends a
// SettingsChanged ping from its "ready" handler (see src/pkjs/index.js),
// which lands in protocol.onSettingsChanged above. Requesting at boot
// instead would race pkjs startup — the watch boots first, the request
// goes out before the phone JS is listening, and it vanishes into a 15 s
// timeout. If the ping is ever lost, Up at the top of the list refreshes.
