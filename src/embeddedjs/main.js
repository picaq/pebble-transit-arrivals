/*
 * main.js — Transit Minute watch app (runs ON THE WATCH, XS engine).
 *
 * Screens:
 *   LIST     — favorites (★) followed by nearby stops, scroll with Up/Down,
 *              Select opens arrivals for the highlighted stop.
 *   ARRIVALS — live predictions for one stop, auto-refreshes every 60 s.
 *              Select toggles ★ favorite. Back returns to the list.
 *              Holding Down reveals a route cursor (the other routes dim).
 *              Holding Back, or tapping it twice, PINS the stop and leaves:
 *              the times keep counting down on the launcher afterwards, and
 *              the stop is stored here (pinned.js) so the next launch opens
 *              on it even with the phone dead.
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
import { savePin, loadPin, clearPin } from "./pinned";

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
// The agency code leading each list subtitle, so it reads as a label rather
// than as the first word of the line. Same size as fontSub, so it sits on the
// same baseline and the rest of the subtitle just starts after it. Gothic has
// a bold at every one of its sizes (14/18/24/28), so this pair is valid —
// an invalid family/size pair builds fine and blanks the screen at runtime
// (CLAUDE.md §12 item 11). Costs one more Font object of watch heap.
const fontAgency = new render.Font("Gothic-Bold", 14);
const fontBig = new render.Font("Leco-Bold", 26);
const fontLine = new render.Font("Gothic-Bold", 24); // bus/route number, arrivals screen
// Minutes-column entries too wide for fontBig: the "Now" label and any 3-digit
// wait (the column is only sized for "88" — see ARRIVAL_TEXT_X). Smallest Leco
// size, so it matches fontBig's typeface; the width overflow this family
// caused before is absorbed by the per-row push (a.lineX in the draw loop).
// Costs a second Font object of heap — the Gothic-Bold 24 alias on fontLine
// was free but mismatched. (Bitham-Black was tried and rejected: its only
// size is 30pt, which bleeds under the route number and destination line.)
const fontNarrow = new render.Font("Leco-Bold", 20);

const BLACK = render.makeColor(0, 0, 0);
const WHITE = render.makeColor(255, 255, 255);
const ACCENT = render.makeColor(0, 85, 255);   // header / selection
const GRAY = render.makeColor(120, 120, 120);
const SUB_GRAY = render.makeColor(60, 60, 60); // subtitles/destination text — higher contrast than GRAY
// Every color has a dimmed twin: the same color at 50% opacity over the white
// background, which is just the midpoint between it and white. Hue survives, so
// a backgrounded Red is still recognisably red and the color coding never
// stops working — only the contrast drops.
//
// Two earlier attempts replaced the color instead of fading it, and both were
// wrong on hardware: a flat 175,175,175 washed out (the physical panel renders
// light grays far weaker than a PNG of the framebuffer, so never judge a gray
// on this watch from a screenshot), and a flat SUB_GRAY threw the line colors
// away entirely, which read worse than either.
//
// The blend must be precomputed — draw() may not allocate, and makeColor is an
// allocation. Every DIM constant below is built once, at module load.
function dim50(r, g, b) {
  return render.makeColor((r + 255) >> 1, (g + 255) >> 1, (b + 255) >> 1);
}
const BLACK_DIM = dim50(0, 0, 0);
const SUB_GRAY_DIM = dim50(60, 60, 60);

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
// Same six at 50% over white, index for index — keep the two lists in step.
const LINE_COLORS_DIM = [
  dim50(0, 90, 200),
  dim50(200, 30, 30),
  dim50(0, 140, 60),
  dim50(140, 40, 180),
  dim50(210, 110, 0),
  dim50(0, 130, 130)
];

// Returns the INDEX so the full and dimmed variants stay in step; a route's
// color must not change depending on which one is asked for.
function colorIndexForLine(line) {
  let hash = 0;
  for (let i = 0; i < line.length; i++) hash = (hash * 31 + line.charCodeAt(i)) | 0;
  return Math.abs(hash) % LINE_COLORS.length;
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
const LINE_COLOR_CODES_DIM = {
  g: dim50(0, 140, 60),
  y: dim50(215, 170, 0),
  r: dim50(200, 30, 30),
  o: dim50(210, 110, 0),
  b: dim50(0, 90, 200)
};

// The agency code leading each list subtitle draws in that agency's own brand
// color, so "which system is this" reads before the text does. Approximations
// of each operator's livery/wordmark, darkened where needed to stay legible as
// 14px text on white. Note Muni and Caltrain are both genuinely red, and BART
// and SamTrans both genuinely blue — the two-letter code is what identifies
// the agency, and the color reinforces it rather than carrying it alone.
// Unlisted agencies (any ExtraAgencies code) just draw in the subtitle gray.
const AGENCY_COLORS = {
  SF: render.makeColor(198, 12, 48),   // Muni red
  BA: render.makeColor(0, 100, 164),   // BART blue
  CT: render.makeColor(227, 24, 55),   // Caltrain red
  AC: render.makeColor(0, 131, 62),    // AC Transit green
  GG: render.makeColor(200, 70, 30),   // Golden Gate orange
  SM: render.makeColor(0, 87, 158),    // SamTrans blue
  SB: render.makeColor(0, 150, 160),   // SF Bay Ferry teal (its livery is a
                                       // blue, but BART/SamTrans already own
                                       // blue and AC owns green — teal keeps the
                                       // code distinct and reads as water/ferry)
  CC: render.makeColor(122, 20, 46)    // County Connection burgundy (its
                                       // livery is burgundy and gold; gold is
                                       // too light to hold up as 14px text on
                                       // white, so burgundy alone carries the
                                       // brand, same tradeoff as every other
                                       // single-color approximation here)
};

// Separator the phone puts before a stop's direction letter ("Bayshore · N").
// Must stay in step with TOKEN_SEP in src/pkjs/index.js — the watch has to
// find the token to protect it from the ellipsize, and to draw it in its own
// color (see fitVisibleRows).
const DIR_SEP = " · ";

// The favorite star, drawn as its own piece of the title so it can carry its
// own color: amber, midway between yellow and orange, dark enough to hold up
// as a glyph on white. LINE_COLOR_CODES.y is the same idea for BART's yellow.
const STAR = "★ ";
const STAR_COLOR = render.makeColor(240, 165, 15);
// Measured once at module load, not per row — a fixed string in a fixed font.
// (Module-load measurement is established here: see HEADER_BUSY_W.)
const STAR_W = render.getTextWidth(STAR, fontRow);

// The direction token and its middot ride BEHIND the name: they identify the
// stop but they are not its name, and at full black they competed with it.
const TOKEN_GRAY = GRAY;

const HEADER_H = 28;
const ROW_H = 40;
const ARRIVAL_ROW_H = 44;
const VISIBLE_ROWS = Math.floor((render.height - HEADER_H) / ROW_H);
const VISIBLE_ARRIVALS = Math.floor((render.height - HEADER_H - 4) / ARRIVAL_ROW_H);
// How many rows stay RETAINED. Loading is unlimited — Down at the bottom
// appends for as long as the phone finds stops (its radius grows per page) —
// but the list never holds more than this: once full, appending evicts the
// oldest non-favorite rows off the TOP (favorites stay pinned). See
// trimRetained(). So memory is bounded by this constant, not by how far the
// user scrolls, and `state.moreOff` (not rows.length) drives pagination.
//
// This bound is NOT optional. It was MAX_LIST_ROWS = 14; removing it entirely
// (2026-07-13, by request) crashed real hardware with "memory full" on a deep
// scroll — the playbook §B thirteenth-recurrence geometry, where the
// load-more page parses BESIDE the retained list, so free chunk shrinks with
// every page loaded. That crash was observed at ~4 am, when few arrivals mean
// short subtitles and small payloads: daytime rows cost more, so it will bite
// sooner. 24 was a deliberately conservative step up from the known-safe 14.
//
// Raised to 30 on 2026-07-17 so a fast scroller keeps ~2 screens of
// scrolled-past stops to back up into (VISIBLE_ROWS is ~5 on emery). The tight
// case is a full favorites block (10, all pinned): right after a load-more the
// retained NEARBY rows above the cursor are 30 − 10 fav − 8 new-page − 1 = 11,
// i.e. ~2 screens; fewer favorites leave more. Was one screen at 24. This is a
// +6 bump and MUST be re-validated against the §F instrumentation (chunk
// headroom on a deep scroll of a FULL 30-row list, the load-more-parses-beside-
// the-retained-list geometry) — never raise it further by guessing.
const LIST_RETAIN_MAX = 30;
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
// How long an arrivals refresh may be in flight before the screen falls back to
// the offline countdown (last-known minutes, ticking) instead of waiting out the
// 15 s REQUEST_TIMEOUT_MS. Link-state-agnostic: it just bounds the wait, so a
// Bluetooth-off drop (which does not reliably flip watch.connected.*) surfaces
// offline in a few seconds. The request stays in flight — if it still succeeds,
// live data replaces the estimate. Comfortably above a warm round trip (~1–2 s).
const OFFLINE_FALLBACK_MS = 4000;

// draw() must stay ALLOCATION-FREE (docs/WATCH-DEBUGGING-PLAYBOOK.md §B):
// string churn in the render path fragments this watch's tiny heap until an
// allocation fails ("memory full") with plenty of total free space. All text
// is fitted/concatenated once when the underlying data changes, stored, and
// only *drawn* here. Layout metrics are hoisted for the same reason.
const LIST_TEXT_W = render.width - 12;
// Minutes column (user mock, 2026-07-12): every minutes string right-aligns
// to ARRIVAL_MIN_EDGE — sized for two fontBig digits or a 3-digit fontNarrow
// wait, which is allowed to overhang the shared edge by 1 px (hence the -1).
// Wider strings ("Now") keep the edge and grow left toward the screen edge.
// Route numbers and destinations sit in one fixed column 9 px after it.
const ARRIVAL_MIN_EDGE = 6 + Math.max(render.getTextWidth("88", fontBig),
                                      render.getTextWidth("888", fontNarrow) - 1);
const ARRIVAL_TEXT_X = ARRIVAL_MIN_EDGE + 9;
// "Now" is one fixed string, so its draw x's are module constants (all
// hardware-measured and user-tuned, 2026-07-12; keeps per-row math out of
// the draw loop — bytecode is arena, playbook §B):
//   NOW_X       right edge of the column minus "Now"'s width, +2 px (the
//               fontNarrow +1 ink offset plus one more the user asked for)
//   NOW_NO_X    "No" kerned +1 px toward the "w" to tighten the o–w gap
//   NOW_W_X     the "w" kept at its one-string pen position
//   NOW_SLIVER_X  a 1 px sliver completing Leco-20's lowercase-w final
//               stroke (the bitmap is one column short: 2 px wide where
//               every other stroke is 3; the intact uppercase "W" has
//               angled strokes the user rejected)
const NOW_X = ARRIVAL_MIN_EDGE - render.getTextWidth("Now", fontNarrow) + 2;
const NOW_NO_X = NOW_X + 1;
const NOW_W_X = NOW_X + render.getTextWidth("No", fontNarrow);
const NOW_SLIVER_X = NOW_X + 41;
// fontNarrow (Leco-Bold 20) sits shorter than fontBig/fontLine (26/24) when
// drawn from the same y — its glyphs need to drop 3 px to line up with the
// route number/code baseline (user-tuned, 2026-07-12). Applies to "Now" and
// any 3-digit (>99) wait, the only two cases that use fontNarrow here.
const NARROW_Y_SHIFT = 3;
const ARRIVAL_TEXT_W = render.width - ARRIVAL_TEXT_X - 4;
// Header title budget. The title is centered, so this is what decides when a
// stop name ellipsizes: 6 px of margin per side (same as the row margin), plus
// room for the "…" busy indicator, which drawHeader() draws immediately after
// the title and which must therefore fit inside the bar even at full width.
const HEADER_PAD = 6;
const HEADER_BUSY_W = render.getTextWidth("…", fontHeader) + 4;
const HEADER_TEXT_W = render.width - 2 * HEADER_PAD - HEADER_BUSY_W;
const HINT_IS_FAV = "★ hold Select to unfavorite";
const HINT_NOT_FAV = "Select to ★ favorite";
// Footer while the arrivals shown are last-known (a refresh could not reach the
// network) — the minutes keep counting down offline (tickArrivals), and this
// tells the rider they are estimated and how stale. The age is appended per
// tick (see buildOfflineText), so the whole string is precomputed off the draw
// path. DIR_SEP is the same " · " the list uses.
const OFFLINE_PREFIX = "Offline" + DIR_SEP + "updated ";
// A response older than this was served from the phone's own store after a
// failed 511 call, not fetched — so it gets the offline footer even though the
// round trip succeeded. Comfortably above the phone's 45 s arrivals cache,
// which is a deliberate rate-limit measure and still counts as live.
const OFFLINE_STALE_MS = 90000;
// Unfavoriting requires HOLDING Select this long (favoriting stays a tap —
// it's harmless and reversible; accidental unfavorites are what stung).
// Fires AT the threshold, mid-hold, via a timer — the footer flips while
// the button is still down, so the user knows it took before releasing.
const LONGPRESS_MS = 500;
// Two Back taps inside this window pin the stop and leave. The hold below
// does the same thing, but the firmware ALSO exits on a held Back once "back"
// is registered (see the button handler), so the hold is a race we can only
// win by acting first — the double tap is the gesture that always works.
// Back never pins any more. Holding it was a race against the firmware's own
// hold-to-exit and the race is UNWINNABLE — at 500 ms nothing happened, at
// 250 ms nothing happened, and the verdict from hardware was blunt: "the back
// button to clear always overrides the press and hold" (2026-08-11). Pinning
// moved to Select, which fights nothing, and leaving-while-pinned moved to a
// two-button chord that cannot be confused with either.
// Footer while a route cursor is showing, telling you what leaving will do.
const HINT_SELECTED = "Select to pin this route";
// Shown once Select has committed the route: choosing is over, so the hint
// turns to how to leave while keeping it.
const HINT_PINNED = "Pinned · Back+Up to exit";
// Header title on the LIST when the distances came from a remembered location
// fix rather than a live one (rows response `fix`); the age is appended per
// response. It replaces the app name in the bar rather than taking a footer,
// because the list has no spare band — five 40 px rows fill the screen below
// the header, and anything drawn at the bottom lands on the last row's
// subtitle. Losing the app name for as long as this is true costs nothing:
// you know which app you opened, and this is the one thing about the list
// that is not what it appears to be.
const FIX_PREFIX = "Location ";
const FIX_SUFFIX = "m old";

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
  stopTitle: undefined,       // ARRIVALS header text; undefined = needs fitting
  stopIsFav: false,           // cached — reading favorites re-parses JSON, keep out of draw()
  arrivals: [],               // [{line, dest, min, whenMs, + display fields fitted in draw()}]
  arrivalsAt: 0,              // Date.now() when the shown arrivals were fetched —
                              // the anchor the offline countdown ticks against.
                              // Each arrival carries a.whenMs (absolute due time
                              // reconstructed from its min at fetch), so the
                              // displayed minute is always round((whenMs-now)/60s):
                              // second-accurate, never drifting a whole minute.
  offline: false,            // showing last-known arrivals (a refresh could not
                              // reach the network) — footers/redraw reflect it,
                              // cleared by the next successful fetch
  offlineText: "",           // precomputed "Offline · updated Nm ago" footer
                              // (built in tickArrivals, off the draw path)
  offlineFallbackTimer: null, // arrivals refresh in flight: fires at
                              // OFFLINE_FALLBACK_MS to show the offline countdown
                              // without waiting out the 15 s request timeout
  arrTop: 0,                   // first visible arrival (scroll window)
  selLine: "",                // the route the cursor is on, "" = no cursor. This,
                              // not arrSel, is what draw() compares against: the
                              // cursor picks a ROUTE, and a route arrives more
                              // than once, so every 14 on the screen stays lit
                              // and only the other routes dim. Highlighting the
                              // single row under the cursor read as "this
                              // departure", which is not the thing being pinned
  selLocked: false,           // the route choice is COMMITTED (Select pressed).
                              // The highlight stays and the other routes stay
                              // dimmed, but Up/Down go back to scrolling the
                              // list instead of moving the cursor — otherwise
                              // choosing a route costs you the ability to
                              // scroll a stop with more arrivals than fit
  arrSel: -1,                 // route cursor on the ARRIVALS screen, -1 = none.
                              // Hidden by default: the screen is a readout, not
                              // a menu, and a cursor you never asked for implies
                              // a choice to make. Holding Down reveals it; the
                              // selected route then draws normally while the
                              // others DIM (dimming the rest, rather than
                              // highlighting one, keeps the row you care about
                              // rendered exactly as you were already reading it)
  fixText: "",                // precomputed "Last known location · Nm" LIST
                              // footer when the phone had no live GPS fix;
                              // "" when the fix was live (off the draw path)
  pinMsg: "",                 // one-line footer confirmation after Select pins
                              // a route; outranks every other footer, cleared
                              // by the next button press
  backHeld: false,            // Back is down right now  ┐ together they are
  upHeld: false,              // Up is down right now     ┘ the exit chord
  chordFired: false,          // the chord ran: swallow the release that follows
  pinPending: false,          // in-flight guard for the pin-and-exit round trip
  pinned: false,              // a stop is on the launcher right now, so a plain
                              // Back off the list has something to clear
  lastStop: null,             // the stop the last arrivals screen showed, kept
                              // by closeArrivals so the second tap of a Back
                              // double tap (which lands on the LIST) still
                              // knows what it is pinning. The stop object only
                              // — its arrivals are released, per playbook §B
  lastLine: 0,                // the route its cursor was on, if any
  arrLimit: ARR_DEFAULT,       // how many arrivals we ask the phone for
  arrivalsPending: false,     // in-flight guard — see fetchArrivals()
  arrivalsStatus: "Loading…",
  refreshTimer: null,
  nearbyPending: false,       // in-flight guard — see fetchNearby()
  moreExhausted: false,       // list "load more" reached the end (no more stops)
  moreOff: 0,                 // non-favorite stops LOADED so far — the pagination
                              // cursor. Not rows.length: trimRetained() evicts
                              // rows off the top, and pagination must not rewind
                              // with them (that would re-fetch stops you passed)
  paginated: false,           // user has loaded ≥1 "more" page: the retained list
                              // now holds stops the phone's page-0 refresh WON'T
                              // return, so an involuntary reload (the reconnect
                              // listener) would drop them and leave the user in the
                              // short page-0 tail (with SF Muni off, ~just
                              // favorites). Gates that reload; cleared by any full
                              // reload (setRowsFromResponse re-baselines page-0)
  favPending: false,          // in-flight guard for the favorite toggle
  refrOkAt: 0,                // manual-refresh cooldown deadline (Date.now() ms)
  revalTimer: null,           // deferred stale-list revalidation (scheduleRevalidate)
  selTimer: null,             // armed while Select is held on a ★ stop; fires the unfavorite
  downTimer: null,            // armed while Down is held on the arrivals screen;
                              // fires the route-cursor reveal at LONGPRESS_MS
  refreshing: false,          // frame-hold (ARRIVALS screen): display data is
                              // RELEASED (heap!) but the last frame stays on
                              // screen with a "…" header indicator; draw()
                              // no-ops until whoever clears the flag repaints
                              // (gate at the top of draw())
  listRefreshing: false,      // LIST refresh in flight: rows stay LIVE (the
                              // list scrolls/selects normally, header shows
                              // "…"); they are released at the last moment,
                              // in protocol.onBeforeParse, so the response
                              // still parses beside freed heap (playbook §B,
                              // ninth recurrence — the parse needs >1.6 KB)
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
  state.paginated = false;     // this IS page-0 again — the cursor is back in range
  // Re-seed the pagination cursor from what this list actually contains: the
  // nearby block is everything AFTER the leading favorites block, which is not
  // the same as "every unstarred row" — a favorite that didn't make the
  // favorites block (past the hide line, or capped out of it) appears in the
  // nearby block wearing its ★, and it is a row the phone handed over, so it
  // must count toward `off` or the next page skips a stop.
  let i = 0;
  while (i < state.rows.length && state.rows[i].fav) i++;
  state.moreOff = state.rows.length - i;
  clampScroll();
}

// Keep the retained list at LIST_RETAIN_MAX by dropping the oldest NON-favorite
// rows off the top — the nearest stops, which are the ones you scrolled away
// from. Favorites are pinned at the head and never evicted. Selection and the
// scroll window shift with the rows so the view doesn't jump. This is what lets
// "load more" be unlimited without the retained list growing without bound
// (playbook §B: the next page parses beside whatever is still retained).
function trimRetained() {
  const over = state.rows.length - LIST_RETAIN_MAX;
  if (over <= 0) return;
  let favCount = 0;
  while (favCount < state.rows.length && state.rows[favCount].fav) favCount++;
  // Never evict favorites, and always leave at least one nearby row.
  const drop = Math.min(over, state.rows.length - favCount - 1);
  if (drop <= 0) return;
  state.rows.splice(favCount, drop);
  state.sel = Math.max(0, state.sel - drop);
  state.top = Math.max(0, state.top - drop);
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
        // The title is drawn in up to THREE pieces, each with its own color:
        // the ★ (amber), the name (black), and the trailing " · N" direction
        // token (gray). Everything they need — the substrings and their x
        // positions — is computed HERE, so draw() only calls drawText.
        //
        // The token also has to SURVIVE: it is the entire reason two otherwise
        // identical stops read apart, and ellipsizing cuts from the END of a
        // string, so fitting the whole label would eat the token off exactly
        // the long names that most need it. Fit the NAME to what the star and
        // the token leave, and place them around it.
        const cut = row.name.lastIndexOf(DIR_SEP);
        row.token = cut > 0 ? row.name.slice(cut) : "";
        row.titleX = 6 + (row.fav ? STAR_W : 0);
        const tokenW = row.token ? render.getTextWidth(row.token, fontRow) : 0;
        row.title = ellipsize(
          cut > 0 ? row.name.slice(0, cut) : row.name,
          fontRow,
          LIST_TEXT_W - (row.fav ? STAR_W : 0) - tokenW
        );
        row.tokenX = row.titleX + render.getTextWidth(row.title, fontRow);
        // The subtitle is drawn in TWO pieces so the leading agency code can
        // take its brand color (AGENCY_COLORS) and its bold: measure the code
        // here and fit the remainder to what's left. The phone always builds
        // the subtitle as agency + the rest ("SF · 320 m · IB · 14,49"), so
        // slicing the code's length off the front is exact.
        row.agencyW = render.getTextWidth(row.agency, fontAgency);
        row.subtitle = ellipsize(
          row.sub.slice(row.agency.length), fontSub, LIST_TEXT_W - row.agencyW
        );
      }
    } else if (row.title !== undefined) {
      row.title = undefined;
      row.subtitle = undefined;
      row.token = undefined;
      row.titleX = undefined;
      row.tokenX = undefined;
      row.agencyW = undefined;
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

// Truncation marker. A "." is several pixels narrower than a "…", and the
// budget it costs is budget the text itself gets back — the point is fitting
// more characters, not the glyph. (The "…" that drawHeader() and the status
// strings use is a *busy* indicator, unrelated to truncation — leave it.)
const TRUNC = ".";

// Binary search the cut point instead of trimming one character at a time:
// the naive loop did a fresh `str + TRUNC` concat AND a `str.slice()` on every
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
  const budget = maxWidth - render.getTextWidth(TRUNC, font);
  let lo = 1, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (render.getTextWidth(str.slice(0, mid), font) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo) + TRUNC;
}

// Stamp the "…" refresh-pending indicator into the header band of the frame
// already on screen (partial Poco update — everything outside the band is
// untouched). Used when a refresh starts on either screen, for an immediate
// indicator without a full redraw; subsequent full repaints keep it by passing
// the in-flight flag (state.listRefreshing / state.refreshing) to drawHeader().
function drawHeaderBusy(title) {
  render.begin(0, 0, render.width, HEADER_H);
  drawHeader(title, true);
  render.end();
}

function draw() {
  // No frame freeze: the arrivals screen keeps drawing (and ticking) through a
  // refresh, exactly like the list. The old `if (state.refreshing) return;`
  // hard-froze it for the whole round trip, which hid the arrivals for the full
  // 15 s request timeout whenever the link was down. Memory safety does not need
  // the freeze — the arrivals are released just before the parse in
  // protocol.onBeforeParse (gated on state.refreshing), never retained beside a
  // real parse (playbook §B, tenth recurrence). state.refreshing now only marks
  // "arrivals request in flight" (drives that release and the "…" header).
  render.begin();
  render.fillRectangle(WHITE, 0, 0, render.width, render.height);

  if (state.mode === MODE_LIST) {
    fitVisibleRows(); // no-op once the visible rows are fitted
    drawHeader(state.fixText || "Transit Minute", state.listRefreshing);
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
        // Dimmed rows (stop with nothing arriving) go gray;
        // selection stays white-on-accent so it's always readable.
        const fg = selected ? WHITE : row.dim ? GRAY : BLACK;
        const sub = selected ? WHITE : row.dim ? GRAY : SUB_GRAY;
        // The agency code takes its brand color, but only on an ordinary row:
        // selection is white-on-accent (a dark brand blue on the blue bar
        // would be unreadable) and a dimmed row stays uniformly gray, which is
        // the whole signal that nothing is arriving there.
        const agFg = selected || row.dim ? sub : (AGENCY_COLORS[row.agency] || sub);
        // Star: amber on any ordinary row, white when selected. It does NOT
        // gray out with a dimmed row — being a favorite has nothing to do with
        // whether a bus is coming, and the star is what you scan the list for.
        if (row.fav) {
          render.drawText(STAR, fontRow, selected ? WHITE : STAR_COLOR, 6, y + 2);
        }
        render.drawText(row.title, fontRow, fg, row.titleX, y + 2);
        // Direction token rides behind the name in gray — it identifies the
        // stop, but it is not part of what the stop is called.
        if (row.token) {
          render.drawText(row.token, fontRow, selected ? WHITE : TOKEN_GRAY,
                          row.tokenX, y + 2);
        }
        render.drawText(row.agency, fontAgency, agFg, 6, y + 22);
        render.drawText(row.subtitle, fontSub, sub, 6 + row.agencyW, y + 22);
      }
    }
  } else {
    // Fit the stop name to the bar in-frame, once per stop (same lazy pattern
    // as fitVisibleRows — measurement is only safe inside begin()/end()).
    if (state.stop && state.stopTitle === undefined) {
      state.stopTitle = ellipsize(state.stop.name, fontHeader, HEADER_TEXT_W);
    }
    // Busy "…" while a refresh is in flight, so a full repaint (clock tick,
    // scroll) during the round trip keeps the indicator drawHeaderBusy stamped.
    drawHeader(state.stop ? state.stopTitle : "Arrivals", state.refreshing);
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
          // Minutes right-align to ARRIVAL_MIN_EDGE (units digits line up
          // to the pixel); fontNarrow ink sits 1 px left of fontBig's at
          // equal advance, so it gets +1, and a trailing "1" digit leaves
          // its right side of the advance empty, so it gets +2 (both
          // user-tuned; recomputed on refresh, so a tick-down realigns).
          // Only numeric strings use minX — "Now" draws at the NOW_*
          // constants. A cached number — steady-state draws still
          // allocate nothing.
          a.minX = ARRIVAL_MIN_EDGE - render.getTextWidth(a.minStr, a.minFont);
          if (a.minFont === fontNarrow) a.minX += 1;
          if (a.min % 10 === 1) a.minX += 2;
          a.lineText = ellipsize(a.line, fontLine, ARRIVAL_TEXT_W);
          a.destText = ellipsize(a.dest, fontSub, ARRIVAL_TEXT_W);
          a.minDirty = false;
        } else if (a.minDirty) {
          // Countdown ticked (tickArrivals): only the minute changed, so
          // recompute just its right-alignment in-frame — a width measure that
          // must stay inside begin()/end() (playbook §F) — without re-fitting
          // the unchanged line/dest strings.
          a.minX = ARRIVAL_MIN_EDGE - render.getTextWidth(a.minStr, a.minFont);
          if (a.minFont === fontNarrow) a.minX += 1;
          if (a.min % 10 === 1) a.minX += 2;
          a.minDirty = false;
        }
        // Route cursor: the row under it draws exactly as it always does and
        // every OTHER row dims. Dimming the rest rather than highlighting one
        // means the row you care about is still rendered the way you were
        // already reading it — a selection bar would recolor it instead.
        // Three comparisons against constants; allocates nothing.
        const off = state.selLine !== "" && a.line !== state.selLine;
        const minFg = off ? BLACK_DIM : BLACK;
        if (a.min <= 0) {
          // Kerned split draw + stroke-completing sliver; see the NOW_*
          // constants. Allocation-free: fixed literals and constants.
          render.drawText("No", fontNarrow, minFg, NOW_NO_X, y + NARROW_Y_SHIFT);
          render.drawText("w", fontNarrow, minFg, NOW_W_X, y + NARROW_Y_SHIFT);
          render.fillRectangle(minFg, NOW_SLIVER_X, y + NARROW_Y_SHIFT + 3, 1, 14);
        } else {
          render.drawText(a.minStr, a.minFont, minFg,
                          a.minX, a.minFont === fontNarrow ? y + NARROW_Y_SHIFT : y);
        }
        render.drawText(a.lineText, fontLine, off ? a.lineDim : a.lineColor, ARRIVAL_TEXT_X, y);
        render.drawText(a.destText, fontSub, off ? SUB_GRAY_DIM : SUB_GRAY, ARRIVAL_TEXT_X, y + 26);
        y += ARRIVAL_ROW_H;
      }
    }
    // Footer: while showing last-known arrivals offline, say so and how stale
    // (state.offlineText, precomputed in tickArrivals); otherwise the favorite
    // hint. Both cached — draw() never allocates or reads storage.
    if (state.pinMsg) {
      // Confirmation of the press you just made: the highest-priority thing
      // the footer can say, and cleared by the next press.
      render.drawText(state.pinMsg, fontSub, GRAY, 6, render.height - 18);
    } else if (state.selLine) {
      // A cursor is a choice you just made, so the footer says what it buys —
      // it outranks both the offline age and the favorite hint for as long as
      // it is showing. Once committed it says how to leave instead of how to
      // choose, since choosing is done.
      render.drawText(state.selLocked ? HINT_PINNED : HINT_SELECTED,
                      fontSub, GRAY, 6, render.height - 18);
    } else if (state.offline) {
      render.drawText(state.offlineText, fontSub, GRAY, 6, render.height - 18);
    } else if (state.stop) {
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
  // Same minute boundary drives the arrivals countdown: tick the displayed
  // minutes down against their absolute due times (offline, in flight, or
  // between the 60 s server refreshes alike). Allocation stays gated to the real
  // minute change this function already guards. draw() below repaints both clock
  // and arrivals at once — the screen no longer freezes during a refresh, so the
  // countdown keeps moving even while a request is out.
  if (state.mode === MODE_ARRIVALS) tickArrivals();
  draw();
}

// Cheap per-arrival display fields; text fitting happens in draw() (in-frame).
// Anchors each arrival to an absolute due time so the countdown can tick offline
// (see tickArrivals). state.arrivalsAt must be stamped BEFORE this runs — the
// phone's `min` is relative to when it served, i.e. ~now, so whenMs reconstructs
// the same absolute instant the phone computed it from (serveArrivals, phone).
function prepareArrivals(list) {
  for (const a of list) {
    // The pinned record (pinned.js) already carries absolute times — it stored
    // whenMs rather than a minute count precisely so it could be reopened at
    // any age. Deriving one here would overwrite it with the fetch stamp and
    // collapse every arrival onto the same instant.
    if (a.whenMs === undefined) a.whenMs = state.arrivalsAt + a.min * 60000;
    a.minStr = a.min <= 0 ? "Now" : String(a.min);
    // The phone does not cap `min`, so infrequent/late-night service really
    // does send 100+; three Leco-Bold 26 digits run into the route text.
    a.minFont = (a.min <= 0 || a.min > 99) ? fontNarrow : fontBig;
    const ci = colorIndexForLine(a.line);
    a.lineColor = (a.k && LINE_COLOR_CODES[a.k]) || LINE_COLORS[ci];
    // Its 50%-over-white twin, precomputed here so the cursor can background a
    // route without draw() computing (or allocating) anything.
    a.lineDim = (a.k && LINE_COLOR_CODES_DIM[a.k]) || LINE_COLORS_DIM[ci];
  }
  return list;
}

// Re-derive each arrival's displayed minute from its absolute due time and the
// current clock, dropping ones now gone. This is the OFFLINE COUNTDOWN: it needs
// no network — the minutes tick down against whenMs whether or not the next
// refresh reaches the phone. Runs on the wall-clock minute boundary (piggybacked
// on updateClock, so it allocates only when the clock does) and immediately when
// a refresh fails. Mirrors the phone's serveArrivals so cached/offline minutes
// match what a live fetch would have shown. Does NOT touch line/dest text —
// only the minutes change, so a.minDirty asks draw() to recompute a.minX
// in-frame (width measurement must stay inside begin()/end(), playbook §F)
// without re-ellipsizing the unchanged strings.
function tickArrivals() {
  if (!state.arrivals.length) return;
  const now = Date.now();
  for (let i = state.arrivals.length - 1; i >= 0; i--) {
    const a = state.arrivals[i];
    const ms = a.whenMs - now;
    if (ms < -60000) {            // already gone — same threshold as serveArrivals
      state.arrivals.splice(i, 1);
      continue;
    }
    const m = Math.max(0, Math.round(ms / 60000));
    if (m !== a.min) {
      a.min = m;
      a.minStr = m <= 0 ? "Now" : String(m);
      a.minFont = (m <= 0 || m > 99) ? fontNarrow : fontBig;
      a.minDirty = true;          // draw() recomputes a.minX in-frame
    }
  }
  // A refresh that reordered by min happens on the phone; a pure tick-down keeps
  // the existing order (waits only shrink), so no re-sort is needed here.
  if (state.arrivals.length) {
    if (state.arrTop >= state.arrivals.length) state.arrTop = 0;
  } else {
    // Everything aged out between refreshes. Offline that means the last-known
    // data is spent ("No live data"); online it is a transient gap the next
    // 60 s refresh fills, but avoid drawing a blank body meanwhile.
    state.arrivalsStatus = state.offline ? "No live data" : "No arrivals";
  }
  if (state.offline) buildOfflineText(now);
}

// Precompute the "Offline · updated Nm ago" footer (draw() never allocates).
// Age is whole minutes since the shown data was fetched.
function buildOfflineText(now) {
  const ageMin = Math.max(0, Math.floor((now - state.arrivalsAt) / 60000));
  state.offlineText = OFFLINE_PREFIX + ageMin + "m ago";
}

/* ------------------------------------------------------------- data flow */

// The phone takes the location fix itself (navigator.geolocation in pkjs)
// and answers with a display-ready rows list. In-flight guard: pull-to-
// refresh (Up at the top of the list) must be a no-op while a request is
// out — stacked cycles pin live memory (playbook §B).
// fresh: bypass the phone's instant stale reply (the revalidation follow-up).
// The phone answers a plain request instantly from its cached list (stale:1);
// we show it, then fire one fresh:1 follow-up here to replace it with live
// data.
// With rows on screen, the ONLY visible change until the response lands is
// the header "…" indicator — the rows stay LIVE and the list keeps
// scrolling/selecting normally (blocking input for the round trip was bad
// UX). The memory invariant still holds: protocol.onBeforeParse (below)
// releases the rows at response arrival, just before the parse spike.
function fetchNearby(fresh) {
  if (state.nearbyPending) return;
  state.nearbyPending = true;
  if (state.rows.length) {
    state.listRefreshing = true;
    drawHeaderBusy(state.fixText || "Transit Minute");
  } else {
    state.status = "Finding stops…";
    draw();
  }
  protocol.nearbyStops(fresh)
    .then(resp => {
      state.nearbyPending = false;
      state.listRefreshing = false;
      const isStale = !!resp.stale;
      // resp.fix: the phone could not get a live position and ranked these
      // stops from a remembered one, N minutes old. Say so rather than let a
      // list built from where you were an hour ago read as where you are.
      // Built here, once per response, so draw() never allocates.
      state.fixText = resp.fix ? FIX_PREFIX + resp.fix + FIX_SUFFIX : "";
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
      state.listRefreshing = false;
      if (!state.rows.length) {
        // Rows are empty (boot, or the phone answered an error AFTER the
        // pre-parse hook released them) — show the error.
        state.status = "Error: " + err.message;
      }
      // A timeout never reached the hook, so the rows are still live —
      // this repaint just clears the header "…".
      draw();
    });
}

// Last-moment display-data release (see fetchNearby / fetchArrivals): fires
// when a response has ARRIVED, synchronously before protocol.js parses it.
// Requests are serialized, so while a *Refreshing flag is set the next response
// is normally that screen's own — releasing here frees the chunk the parse
// needs (a rows parse needs >1.2 KB, playbook §B ninth recurrence) while the
// framebuffer keeps showing the old data for the few ms until the .then handler
// repaints. (If the request queued behind an abandoned earlier cycle, this
// fires on that response instead — releasing a round trip early is memory-safe
// and the data rebuilds when the real response lands right after.)
//
// `raw` is the unparsed response string. The ARRIVALS release is conditional on
// it: only a real data response (`"type":"arrivals"`) is about to spike the
// heap, so only then do we drop the arrivals. An error/timeout carries no big
// parse, so its arrivals are KEPT for the offline countdown (fetchArrivals'
// .catch ticks them down). None of the fixed phone error strings ("Network
// error", "511 timeout", "Bad API key", "Rate limited", "No phone location",
// "Unexpected 511 response", "HTTP nnn") contain that token, and indexOf
// allocates nothing.
protocol.onBeforeParse = (raw) => {
  if (state.listRefreshing) {
    state.rows = [];
    state.sel = 0;
    state.top = 0;
    state.status = "Refreshing…"; // insurance if a draw slips in
  } else if (state.refreshing && raw.indexOf('"type":"arrivals"') !== -1) {
    state.arrivals = [];
    state.arrivalsStatus = "Refreshing…"; // insurance if a draw slips in
  }
};

// Fresh reload of the list (pull-to-refresh and the deferred stale
// revalidation). The rows stay live and interactive while the request is
// out — fetchNearby stamps the "…" indicator and arms the last-moment
// release above. Callers ensure !nearbyPending.
function refreshList() {
  if (state.revalTimer) { // any fresh fetch satisfies a pending revalidation
    Timer.clear(state.revalTimer);
    state.revalTimer = null;
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
// phone paginates from state.moreOff and widens its search radius each page,
// so Down at the bottom always has somewhere farther to look. Loading is
// UNLIMITED; retention is not — trimRetained() evicts off the top to hold the
// list at LIST_RETAIN_MAX. The only stop condition is the phone returning an
// empty page, which now means "nothing left within 200 km", not "past the
// fixed 5 km radius". Reuses the nearby in-flight guard so it can't stack
// with a refresh.
function fetchMore() {
  if (state.nearbyPending || state.moreExhausted) return;
  state.nearbyPending = true;
  // From here the retained list holds stops a page-0 refresh won't return, so an
  // involuntary reload (the reconnect listener) must not clobber it — see the
  // "connected" handler. A voluntary refresh (Up-at-top, or a settings change)
  // still reloads and re-baselines page-0, which clears this flag.
  state.paginated = true;
  protocol.moreStops(state.moreOff)
    .then(resp => {
      state.nearbyPending = false;
      const more = resp.rows || [];
      if (!more.length) { state.moreExhausted = true; return; }
      for (const r of more) {
        // A load-more row CAN be a favorite (one past the hide line, which
        // never made the favorites block) and must show its star. It does not
        // disturb the cursor below: the phone's `off` counts rows handed over,
        // starred or not, so this advances by more.length either way.
        state.rows.push({
          agency: r.a, code: r.c, name: r.n, sub: r.s, fav: !!r.f, dim: !!r.m
        });
      }
      state.moreOff += more.length; // cursor advances even when rows are evicted
      trimRetained();
      draw();
    })
    .catch(err => {
      state.nearbyPending = false;
    });
}

function openArrivals(stop) {
  state.mode = MODE_ARRIVALS;
  state.stop = stop;
  state.stopTitle = undefined;    // refitted in-frame by draw() (HEADER_TEXT_W)
  state.stopIsFav = stop.fav; // rows arrive flagged from the phone
  // Release the list rows' fitted text while this screen's refresh cycles
  // own the heap — draw() refits the visible rows on return. Frees ~1 KB
  // of chunk space on a heap that crashes over less (playbook §B).
  for (const row of state.rows) {
    row.title = undefined;
    row.subtitle = undefined;
  }
  state.arrivals = [];
  state.offline = false;          // fresh stop — no stale data carried over
  state.arrTop = 0;               // top of the scroll window for this stop
  state.arrLimit = ARR_DEFAULT;   // reset "load more" growth per stop
  setArrSel(-1);                  // no route cursor until Down is held here
  // Reset the guard so a still-in-flight request for a previous stop can't
  // block this screen's first fetch (its late response is ignored by the
  // identity check in fetchArrivals). Same for a frame-hold left by that
  // request — this screen draws fresh content now, so the hold must not
  // survive the transition (draw() would stay gated forever).
  state.arrivalsPending = false;
  state.refreshing = false;
  if (state.offlineFallbackTimer) {
    Timer.clear(state.offlineFallbackTimer);
    state.offlineFallbackTimer = null;
  }
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
    // The arrivals stay LIVE through the round trip (they keep drawing and
    // ticking) and are released only in protocol.onBeforeParse, right before a
    // real data response is parsed — so a failed/offline refresh keeps them and
    // counts them down (playbook §B, tenth recurrence; mirrors the LIST screen).
    // state.refreshing is now just an in-flight/busy marker (draw() no longer
    // freezes on it): it gates that onBeforeParse release and shows the "…"
    // header. NOT a screen freeze — freezing here hid the arrivals for the whole
    // 15 s request timeout whenever the link was down.
    state.refreshing = true;
    state.arrivalsStatus = "Refreshing…"; // insurance if the list is empty
    // stopTitle is fitted by the first draw() of this screen, which always
    // precedes a refresh; fall back rather than drawText(undefined) if not.
    drawHeaderBusy(state.stopTitle || "Arrivals");
  }
  // Bound the wait WITHOUT relying on a link-state flag (watch.connected.* proved
  // unreliable for a Bluetooth-off drop): if the response hasn't landed in
  // OFFLINE_FALLBACK_MS, stop waiting on the frozen "…" — show the last-known
  // arrivals as an offline countdown (or, on a cold open with nothing to count
  // down, "No phone connection"). The request stays in flight; if it still
  // succeeds (e.g. the link recovers) .then replaces the estimate with live data.
  if (state.offlineFallbackTimer) Timer.clear(state.offlineFallbackTimer);
  state.offlineFallbackTimer = Timer.set(() => {
    state.offlineFallbackTimer = null;
    if (state.arrivalsPending && state.mode === MODE_ARRIVALS &&
        state.stop === requested) {
      if (state.arrivals.length) {
        state.offline = true;
        tickArrivals();
      } else {
        state.arrivalsStatus = "No phone connection";
      }
      draw();
    }
  }, OFFLINE_FALLBACK_MS);
  protocol.arrivals(requested.agency, requested.code, state.arrLimit)
    .then(resp => {
      state.arrivalsPending = false;
      state.refreshing = false; // release the hold before any early return
      if (state.offlineFallbackTimer) {
        Timer.clear(state.offlineFallbackTimer);
        state.offlineFallbackTimer = null;
      }
      if (state.mode !== MODE_ARRIVALS || state.stop !== requested) return;
      // Data landed — stamp the anchor BEFORE prepareArrivals (it derives each
      // arrival's whenMs from arrivalsAt) and clear any offline state.
      //
      // resp.asof is when the PHONE fetched these, which is not when they
      // arrived here: it answers from a 45 s cache, and when the network is
      // down it answers from disk with predictions that may be minutes old.
      // Anchoring to Date.now() in that case restarted every countdown from
      // scratch, so a four-minute-old "3" showed as "3" instead of "Now" and
      // the bus was gone before the number moved. Fall back to now only for a
      // phone build old enough not to send it.
      state.arrivalsAt = resp.asof || Date.now();
      // Data the phone had to reach into its own cache for is not live, and
      // the footer says so — same offline countdown, honestly labelled.
      state.offline = !!resp.asof && Date.now() - resp.asof > OFFLINE_STALE_MS;
      state.arrivals = prepareArrivals(resp.arrivals || []);
      // Keep the scroll window valid if a refresh returned fewer rows.
      if (state.arrTop >= state.arrivals.length) state.arrTop = 0;
      // Keep the cursor on the ROUTE it was on, wherever that route landed
      // in the refreshed list; drop it if that route is no longer running.
      if (state.selLine) {
        let at = -1;
        for (let i = 0; i < state.arrivals.length; i++) {
          if (state.arrivals[i].line === state.selLine) { at = i; break; }
        }
        setArrSel(at);
      }
      state.arrivalsStatus = state.arrivals.length ? "" : "No arrivals";
      // A stale-but-successful response needs its footer built here: the
      // offline text is normally produced by tickArrivals, which will not run
      // until the next minute boundary.
      if (state.offline) buildOfflineText(Date.now());
      draw();
    })
    .catch(err => {
      state.arrivalsPending = false;
      state.refreshing = false; // release the hold before any early return
      if (state.offlineFallbackTimer) {
        Timer.clear(state.offlineFallbackTimer);
        state.offlineFallbackTimer = null;
      }
      if (state.mode !== MODE_ARRIVALS || state.stop !== requested) return;
      if (state.arrivals.length) {
        // OFFLINE COUNTDOWN: the refresh (manual or auto) could not reach the
        // network, but onBeforeParse kept the last-known arrivals. Don't error
        // — mark offline and tick the minutes down against their absolute due
        // times right now (don't wait for the next minute boundary).
        state.offline = true;
        tickArrivals();
        draw();
      } else {
        // Nothing to fall back to (first fetch of this stop failed offline).
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

// Set the current stop's favorite state on the phone (which owns the list).
// We send the state we WANT, not a flip — see protocol.setFav. In-flight
// guard so repeated triggers can't stack request cycles (playbook §B).
// Callers decide the gesture: tap to favorite, long-press to unfavorite
// (see the button handler).
function toggleFav() {
  if (!state.stop || state.favPending) return;
  state.favPending = true;
  const stop = state.stop;
  protocol.setFav(stop.agency, stop.code, stop.name, stop.fav ? 0 : 1)
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

// Pin the route under the cursor. Select does this, and it does NOT leave the
// app: pinning and leaving are now separate acts (Back+Up leaves), because
// every attempt to fold them into one Back gesture lost to the firmware.
//
// Two things are written, neither depending on the other:
//   1. pin.v1 on the watch (rememberStop) — the copy that survives a dead
//      phone, and the thing that reopens this screen on the next launch.
function pinRoute() {
  rememberStop();
  state.pinned = true;
  // Commit the choice: the route stays highlighted and the rest stay dimmed,
  // but Up and Down go back to scrolling. Select NEVER exits the app — pinning
  // and leaving are separate acts (Back+Up leaves).
  state.selLocked = true;
  state.pinMsg = "Pinned";
  // Tell the phone too, so its own record matches; nothing depends on the
  // answer, so do not hold anything open for it.
  const p = loadPin();
  if (p) protocol.setPin(p.stop.agency, p.stop.code, p.stop.name, p.line || 0);
  draw();
}

// Leave from the LIST: a plain Back means "done", so it also takes the
// launcher line away. Only worth a round trip when there is something to
// take away — otherwise exit immediately, exactly as it always has.
function exitApp() {
  if (state.pinPending) return;
  // The stored record goes whether or not anything reached the launcher: any
  // arrivals screen visited this session wrote one (rememberStop), and
  // quitting from the root means the next launch should open on the list,
  // the way it did before this feature existed.
  if (state.lastStop) {
    clearPin();
    state.lastStop = null;
  }
  if (state.pinned) {
    protocol.clearPin();    // fire and forget, as above
    state.pinned = false;
  }
  watch.exit();
}

// Put the route cursor on `i`, or clear it with -1. Because the cursor picks a
// ROUTE, moving it means moving to the next row whose line DIFFERS — stepping
// row by row would visibly do nothing while it crossed the other departures of
// the route already selected.
function setArrSel(i) {
  if (i < 0 || !state.arrivals.length) {
    state.arrSel = -1;
    state.selLine = "";
    state.selLocked = false;
    return;
  }
  state.arrSel = i;
  state.selLine = state.arrivals[i].line;
  if (state.arrSel < state.arrTop) state.arrTop = state.arrSel;
  else if (state.arrSel >= state.arrTop + VISIBLE_ARRIVALS) {
    state.arrTop = state.arrSel - VISIBLE_ARRIVALS + 1;
  }
}

// What a Back TAP means on the arrivals screen: put the route cursor away if
// one is showing (the change you most recently made, and undoing it should not
// also cost you the screen), otherwise return to the list.
function backTap() {
  if (state.selLocked) {
    // A committed route stays pinned until Back says otherwise — including
    // across leaving and reopening the app. This press UNPINS it and nothing
    // else: the screen stays, so undoing a pin never also costs you the stop
    // you are reading. A second Back then returns to the list as usual.
    clearPin();
    state.pinned = false;
    state.lastStop = null;
    protocol.clearPin();   // fire and forget; the watch's record is the real one
    setArrSel(-1);
    state.pinMsg = "Unpinned";
    draw();
  } else if (state.selLine) {
    setArrSel(-1);
    draw();
  } else {
    closeArrivals();
  }
}

function moveArrSel(dir) {
  let i = state.arrSel;
  for (;;) {
    i += dir;
    if (i < 0 || i >= state.arrivals.length) return; // no further route that way
    if (state.arrivals[i].line !== state.selLine) break;
  }
  setArrSel(i);
  draw();
}

// Write the stop on screen to watch storage, while its arrivals are still
// here to write. Called by the FIRST thing Back does, before it decides what
// else Back means, so the record exists no matter which of Back's three
// meanings this press turns out to have.
//
// Writing on every Back rather than only on the pin gesture is deliberate:
// this IS the most recently looked at stop either way, the write is one small
// string, and a plain Back off the list clears it again (exitApp), so
// deliberately quitting still leaves nothing behind.
function rememberStop() {
  if (!state.stop) return;
  state.lastLine = state.selLine || 0;
  state.lastStop = state.stop;
  savePin(state.stop, state.arrivals, state.arrivalsAt, state.lastLine);
}

function closeArrivals() {
  stopRefreshTimer();
  state.mode = MODE_LIST;
  state.stop = null;
  state.arrivals = [];
  setArrSel(-1);                  // the cursor belongs to the stop you left
  state.offline = false;          // leaving the arrivals screen clears the flag
  // Clear the in-flight marker and the offline fallback for the screen we are
  // leaving; an abandoned request's late response is ignored by its identity
  // check, and its fallback must not fire against the list.
  state.refreshing = false;
  if (state.offlineFallbackTimer) {
    Timer.clear(state.offlineFallbackTimer);
    state.offlineFallbackTimer = null;
  }
  draw();
  // Launching straight onto a pinned stop means the nearby list was never
  // fetched: the settings ping runs refreshCurrent(), which on the arrivals
  // screen refreshes only the arrivals. Backing out then landed on an empty
  // list still showing its boot status ("Connecting…") with nothing on the way
  // — it looked hung, and only a manual pull-to-refresh ever filled it.
  //
  // Fetch it here, lazily, rather than warming it at boot: this is the moment
  // the list is first wanted, and a stop pinned for the commute is often the
  // only screen looked at, so a boot-time fetch would spend a request on a
  // list that is never opened.
  if (!state.rows.length && !state.nearbyPending) fetchNearby(false);
}

/* --------------------------------------------------------------- buttons */

// NOTE: registering "back" replaces its single-tap auto-exit behavior with
// whatever we do below. We restore single-tap exit ourselves on the list
// (root) screen via watch.exit() — see the Alloy globals (CLAUDE.md section 2).
new Button({
  types: ["select", "up", "down", "back"],
  onPush(down, type) {
    if (!down) {
      if (type === "back") state.backHeld = false;
      if (type === "up") state.upHeld = false;
      // Releasing before a long-press timer fires cancels it — Select's and
      // Down's holds act MID-hold, so the screen changes while the button is
      // still down and you know it took before you let go.
      if (type === "select" && state.selTimer) {
        Timer.clear(state.selTimer);
        state.selTimer = null;
      }
      if (type === "down" && state.downTimer) {
        Timer.clear(state.downTimer);
        state.downTimer = null;
      }
      // Swallow the releases belonging to an exit chord, so letting go of Back
      // after Back+Up does not also "go back".
      if (state.chordFired) {
        if (!state.backHeld && !state.upHeld) state.chordFired = false;
        return;
      }
      // Back on the ARRIVALS screen resolves on RELEASE, not on press. That
      // is what leaves room for Up to join it: pressing Back must not close
      // the screen before we can see whether a chord is forming.
      if (type === "back" && state.mode === MODE_ARRIVALS) backTap();
      return;
    }

    // ---- the exit chord, checked before anything else --------------------
    // Back + Up together leaves the app and KEEPS the pin. It exists because
    // Back alone cannot: a held Back is always taken by the firmware's own
    // exit before we ever see it, so "leave but remember this" needed a
    // gesture that is not a hold at all.
    if (type === "back") state.backHeld = true;
    if (type === "up") state.upHeld = true;
    if (state.backHeld && state.upHeld) {
      state.chordFired = true;
      watch.exit();
      return;
    }
    // Any press dismisses the pin confirmation.
    if (state.pinMsg) state.pinMsg = "";
    if (state.mode === MODE_LIST) {
      if (type === "up") {
        if (state.sel > 0) { state.sel--; clampScroll(); draw(); }
        else if (Date.now() >= state.refrOkAt) {
          // At the top: pull-to-refresh. fresh:1 always — the list data is
          // replaced wholesale, so the stale echo would just add a second
          // parse. Cooldown: REFRESH_COOLDOWN_MS. The list stays scrollable
          // and selectable while the request is out (header shows "…").
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
        // Back leaves, and leaving from the root means done — the launcher
        // line goes with it (exitApp). To leave and KEEP it, use the chord.
        exitApp();
      }
    } else {
      if (type === "select" && state.selLine) {
        // Cursor showing: Select PINS that route. Favoriting keeps Select only
        // when there is no cursor, so the two never compete for one press.
        pinRoute();
      } else if (type === "select" && state.stop && !state.favPending) {
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
        // Nothing on press — Back resolves on RELEASE (see the top of
        // this handler), which is what leaves room for Up to join it and
        // form the exit chord.
      } else if (type === "up") {
        // With a cursor: move it, scrolling only when it would leave the
        // window. Without one: scroll, and at the very top manual-refresh —
        // rate-limited like the list's pull-to-refresh (the phone's 45 s
        // arrivals cache answers near-instantly, so the guard alone doesn't
        // stop refresh-mashing).
        if (state.arrSel >= 0 && !state.selLocked) {
          // Cursor still being chosen: move it to the previous ROUTE. At the
          // first one nothing happens — a refresh there would fight the cursor
          // rather than serve it.
          moveArrSel(-1);
        } else if (state.arrTop > 0) {
          state.arrTop--; draw();
        } else if (Date.now() >= state.refrOkAt) {
          state.refrOkAt = Date.now() + REFRESH_COOLDOWN_MS;
          fetchArrivals();
        }
      } else if (type === "down") {
        if (state.arrSel >= 0 && !state.selLocked) {
          moveArrSel(1); // next ROUTE, skipping this route's other departures
        } else if (state.arrTop + VISIBLE_ARRIVALS < state.arrivals.length) {
          // Scroll down; at the bottom, load more arrival times (no refresh).
          state.arrTop++; draw();
        } else if (state.arrivals.length >= state.arrLimit && state.arrLimit < ARR_MAX) {
          state.arrLimit = Math.min(ARR_MAX, state.arrLimit + ARR_STEP);
          fetchArrivals();
        }
        // HOLDING Down reveals the route cursor. Armed after the tap action
        // above rather than instead of it, the same way Select's unfavorite
        // is: a hold therefore scrolls a row and then reveals the cursor,
        // which lands it on a row you have just looked at. The screen is a
        // readout by default — a cursor nobody asked for implies a choice
        // that isn't there.
        if (state.arrSel < 0 && state.arrivals.length) {
          state.downTimer = Timer.set(() => {
            state.downTimer = null;
            if (state.mode === MODE_ARRIVALS && state.arrSel < 0 && state.arrivals.length) {
              setArrSel(state.arrTop); // clears selLocked: a fresh cursor is
              draw();                  // being chosen, not yet committed
            }
          }, LONGPRESS_MS);
        }
      }
    }
  }
});

/* ----------------------------------------------------------------- start */

// Re-fetch whatever screen is showing. Used by the settings-changed ping and by
// the reconnect listener below.
function refreshCurrent() {
  if (state.mode === MODE_ARRIVALS) fetchArrivals();
  else fetchNearby(false);
}

// Re-run the fetch when the phone-side settings change (e.g. the user enabled
// another agency or entered an API key) — on either screen now, so a settings
// change while viewing arrivals isn't ignored.
protocol.onSettingsChanged = () => {
  refreshCurrent();
};

// Re-fetch when the phone link is (re)established. A mid-session Bluetooth
// reconnect otherwise left the running app showing stale data until it was
// closed and reopened: nothing re-fetched (the list has no periodic refresh,
// and pkjs doesn't reliably re-ping on reconnect). `watch` fires "connected" on
// link changes (CLAUDE.md §2). Recover the current screen — but ONLY once a
// session is under way (list loaded, or on the arrivals screen). At boot the
// list is empty and the FIRST fetch must come from pkjs's settings-ping, not
// from here: a watch-initiated fetch can beat pkjs's startup and vanish
// (CLAUDE.md §6), and its in-flight guard would then swallow the ping's fetch.
// On a disconnect event this fails gracefully into the offline countdown.
//
// EXCEPT a paginated LIST: reloading returns page-0 only, so an involuntary
// reload here would drop every "load more" stop and drop the user into the
// short page-0 tail — with SF Muni off that tail is ~just favorites, so a
// reconnect firing mid-scroll looked like "scrolling down jumped me to the
// bottom of my favorites." A reconnect is not worth destroying the list the
// user built; they still have pull-to-refresh (Up-at-top) if they want it.
watch.addEventListener("connected", () => {
  if (state.mode === MODE_ARRIVALS) refreshCurrent();
  else if (state.rows.length && !state.paginated) refreshCurrent();
});

state.status = watch.connected.app ? "Connecting…" : "Waiting for phone…";

// Open on the stop you pinned, if there is one. This is the whole point of
// keeping a copy here: the record is read before anything has been asked of
// the phone, so the first frame shows real minutes even with the phone dead,
// Bluetooth off, or pkjs still starting. The times are absolute, so they are
// as correct now as they were when they were written — tickArrivals derives
// the display from (whenMs - now) and drops the ones that have gone.
//
// Read exactly here, once, while the arena is emptiest and a JSON.parse is at
// its cheapest (playbook §B). The blob is a few hundred bytes against the
// 1.2–1.6 KB of free chunk a rows response needs.
const pin = loadPin();
if (pin && pin.arrivals.length) {
  state.pinned = true;
  state.mode = MODE_ARRIVALS;
  state.stop = pin.stop;
  state.stopIsFav = pin.stop.fav;
  state.lastStop = pin.stop;
  state.lastLine = pin.line;
  state.arrivalsAt = pin.arrivalsAt;
  state.arrivals = prepareArrivals(pin.arrivals);
  // Restore the route cursor onto the line you pinned, so the screen comes
  // back in the state you left it rather than silently widening to the whole
  // stop while the launcher still shows one route.
  if (pin.line) {
    for (let i = 0; i < state.arrivals.length; i++) {
      if (state.arrivals[i].line === pin.line) {
        setArrSel(i);
        // COMMITTED, not mid-choice. Without this the route came back looking
        // unpinned on every launch: the cursor showed but Up/Down moved it and
        // the footer offered to pin something that already was pinned. A pin
        // is meant to survive leaving — that is the whole point of it.
        state.selLocked = true;
        break;
      }
    }
  }
  // Age the stored minutes to now BEFORE the first frame — prepareArrivals
  // computed each `min` from a stamp that may be hours old.
  state.offline = true;
  tickArrivals();
  state.arrivalsStatus = state.arrivals.length ? "" : "No live data";
  // The pinned copy is a starting point, not the answer: openArrivals'
  // machinery (fetch + the 60 s refresh timer) still has to run, and it does
  // when the phone announces itself (protocol.onSettingsChanged below).
  state.refreshTimer = Timer.repeat(fetchArrivals, 60000);
}
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
