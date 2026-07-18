/*
 * index.js — phone side of Transit Glance (PebbleKit JS).
 *
 * Responsibilities:
 *   1. Serve the Clay settings page and persist settings in PHONE
 *      localStorage (settings never live on the watch — see config.js).
 *   2. Take the location fix (navigator.geolocation — the watch does NOT
 *      use its Location sensor; that kept the @moddable/pebbleproxy and
 *      extra watch code out of the tiny watch heap, playbook §B).
 *   3. Answer watch requests ("nearby", "arrivals") using transit511.js,
 *      doing ALL merging/sorting/formatting here so the watch just renders.
 */

var Clay = require("@rebble/clay");
var clayConfig = require("./config");
var transit = require("./transit511");
var localSecrets = require("./localSecrets");

// Runs INSIDE the Clay settings webview (serialized by Clay). Its only job:
// a confirmation dialog when any 🗑 delete toggle is on at save time.
// Defensive try/catch throughout — if anything about Clay's DOM changes,
// deletion degrades to working without a dialog rather than breaking the
// page.
function clayCustomFn() {
  var clayConfig = this;
  clayConfig.on(clayConfig.EVENTS.AFTER_BUILD, function () {
    try {
      var btn = document.querySelector('button[type="submit"]') ||
        document.querySelector(".button--submit");
      if (!btn) return;
      btn.addEventListener("click", function (e) {
        try {
          var doomed = [];
          var items = clayConfig.getAllItems();
          for (var i = 0; i < items.length; i++) {
            var cfg = items[i].config || {};
            if (cfg.messageKey && cfg.messageKey.indexOf("Del_") === 0 && items[i].get()) {
              doomed.push(cfg.label || cfg.messageKey);
            }
          }
          if (doomed.length && !window.confirm(
            "Permanently delete " + doomed.length + " favorite stop(s)?\n\n" +
            doomed.join("\n"))) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        } catch (err) { /* fall through: save proceeds without a dialog */ }
      }, true);
    } catch (err) { /* ignore */ }
  });
}

// autoHandleEvents:false — we intercept webviewclosed so settings stay on
// the phone instead of being pushed to the watch key-by-key.
var clay = new Clay(clayConfig, clayCustomFn, { autoHandleEvents: false });

var SETTINGS_KEY = "settings.v1";

// localSecrets.apiKey is a local dev convenience (see scripts/inject-api-key.js
// and .env.example) — seeds the settings page before you've saved anything
// via Clay. It is never committed; on a fresh clone it's "".
// Agencies with a dedicated toggle on the settings page. Anything else in
// settings.agencies (CT = Caltrain, SC = VTA, …) came from the ExtraAgencies
// free-text field, and both halves of the Clay round trip — filling the field
// in showConfiguration and re-reading it in webviewclosed — key off this list.
var TOGGLED_AGENCIES = ["SF", "BA", "AC", "GG", "SM", "SB"];

var DEFAULT_SETTINGS = {
  apiKey: localSecrets.apiKey || "",
  agencies: TOGGLED_AGENCIES.slice(),
  radiusM: 500,
  railRadiusX: 1, // BART/Caltrain reach ×this and rank ÷this (1 = off); see transit511 railScale
  maxStops: 8,
  hideFavKm: 19 // favorites farther than this are left out of the rows response (~12 mi)
};

/* -------------------------------------------------------------- favorites */

// The phone owns the favorites list (the watch keeps nothing persistent —
// watch code and storage cost watch heap, playbook §B). Managed from the
// watch (Select on the arrivals screen → "fav" request) and from the Clay
// settings page (each favorite gets a remove toggle).
var FAVS_KEY = "favorites.v1";
// Storage cap, not a display cap — unfavoriting hides rather than deletes,
// so hidden records accumulate here until trashed from the settings page.
var MAX_FAVORITES = 20;

function loadFavs() {
  try {
    var list = JSON.parse(localStorage.getItem(FAVS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveFavs(list) {
  localStorage.setItem(FAVS_KEY, JSON.stringify(list.slice(0, MAX_FAVORITES)));
}

// Collapse records that now name the same stop. Two of them can only exist
// because a code was retired under them: favoriting both Balboa Park platforms
// once made two records, and migrating both onto the station they became
// (buildRows, via getFavoriteStatus's `canon`) points them at one stop — which
// is precisely the doubled "Balboa Park (BA)" the settings page was showing.
// The earliest record wins the slot (favorites are newest-first), but a
// visible duplicate un-hides it: if you ever starred either platform, you want
// the station.
function dedupeFavs(list) {
  var seen = {};
  var out = [];
  list.forEach(function (f) {
    var key = f.agency + ":" + f.code;
    var kept = seen[key];
    if (kept) {
      if (!f.hide) delete kept.hide;
      return;
    }
    seen[key] = f;
    out.push(f);
  });
  return out;
}

// One-time import of the legacy watch-side favorites list (the watch sends
// its old favorites.v1 JSON with nearby requests until one succeeds).
function importLegacyFavs(raw) {
  var legacy;
  try {
    legacy = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!Array.isArray(legacy)) return;
  var favs = loadFavs();
  var have = {};
  favs.forEach(function (f) { have[f.agency + ":" + f.code] = 1; });
  legacy.forEach(function (f) {
    if (f && f.agency && f.code && !have[f.agency + ":" + f.code]) {
      favs.push({ agency: String(f.agency), code: String(f.code), name: String(f.name || f.code) });
    }
  });
  saveFavs(favs);
  console.log("imported " + legacy.length + " legacy watch favorites");
}

function loadSettings() {
  try {
    var raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      var stored = JSON.parse(raw);
      // Spread-merge equivalent (PKJS is ES5-ish): defaults fill gaps.
      var merged = {};
      for (var k in DEFAULT_SETTINGS) merged[k] = DEFAULT_SETTINGS[k];
      for (var j in stored) merged[j] = stored[j];
      return merged;
    }
  } catch (e) {
    console.log("settings: parse failed, using defaults");
  }
  var copy = {};
  for (var d in DEFAULT_SETTINGS) copy[d] = DEFAULT_SETTINGS[d];
  return copy;
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/* ------------------------------------------------------------- rows cache */

// Cached-list boot: the last computed rows list is persisted so the watch
// can render a list the instant it asks (even at cold app launch), before
// any geolocation or network work runs. A non-fresh "nearby" request is
// answered from this cache AS FINAL — no stale:1 flag, so the watch never
// schedules its fresh:1 revalidation follow-up. That follow-up was a
// second full rows parse ~11 s into boot, and it aborted "memory full"
// deterministically once the boot allocations carved the whole arena
// (playbook §B, sixteenth recurrence, captured 2026-07-12). Freshness now
// comes from the short serve window below instead: a cache young enough to
// serve is young enough to be true (you're still where you were), and
// anything older takes the normal single-parse fresh path. Manual
// pull-to-refresh still forces fresh:1. Only the normal page-0 list is
// cached — "load more" pages (buildMoreRows) are not, so a launch never
// flashes a long list.
var ROWS_CACHE_KEY = "rows.v1";
// Serve-as-final window. Past it, eat the geolocation + network wait
// rather than show possibly-moved distances with no revalidation behind
// them (there is none anymore).
var ROWS_FRESH_MS = 3 * 60 * 1000; // 3 min

// "Load more stops" pagination (buildMoreRows). MORE_RADIUS_M is the FIRST
// page's search radius, not the only one: handleRequest doubles it per page
// (5 km, 10, 20, …) up to MORE_RADIUS_MAX_M, so Down keeps finding farther
// stops instead of hitting a fixed distance wall. It used to be a flat
// 5 km — once you'd seen every stop inside it, every further Down returned
// an empty page and the watch latched "no more stops" permanently.
// Widening is free: agency stop lists are already cached on the phone, and
// the radius is just a filter over them (no extra 511 calls).
// MORE_RADIUS_MAX_M spans the whole 511 service area — past it there is
// genuinely nothing left to find, and an empty page is the honest answer.
var MORE_RADIUS_M = 5000;
var MORE_RADIUS_MAX_M = 200000; // 200 km — beyond the Bay Area's far edge
var MORE_PAGE = 8;
// Page-0 list shape: how many rows the opening screen arrives with. The watch
// grows past this on Down ("load more"), retaining up to LIST_RETAIN_MAX=24
// rows (main.js); the ROWS_BUDGET below fits all 14 of page 0, so FAV_ROWS_MAX
// is a pure anti-monopoly cap (favorites can't push every nearby stop off the
// list), sized so the whole favorites roster shows when you're near it.
// Under the old 880 B budget it was 6: 13 visible favorites once filled
// 1143 B by themselves — respond() (whose shed floor was "never shed
// favorites") sent the oversized payload, the watch's SECOND parse of it
// faulted "memory full", and every non-favorite was shed, which read as
// "local stops don't load" (playbook §B, fifteenth recurrence,
// 2026-07-12). Nearest FAV_ROWS_MAX favorites show; local stops fill the
// rest; capped-out favorites stay saved and reappear when you're nearer
// them (or trim the list / lower hideFavKm on the settings page).
var FAV_ROWS_MAX = 10;
// Page-0 list length. NOT a ceiling on the watch's list — the watch has no
// row cap and appends farther stops on Down for as long as they exist. This
// is just how many rows the opening screen arrives with (and what fits
// ROWS_BUDGET in one reply); "load more" pages grow the list past it.
var WATCH_LIST_CAP = 14;
// Page-0 wire budget, enforced in respond(). 1600 B fits 14 compact rows
// (~100 B each) plus wrapper. RELAXED 2026-07-12 from 880 B — a 32 KB-arena
// trade (playbook §B, seventh/fifteenth recurrences) that the 72 KB heap
// on firmware ≥ v4.21.0 lifted; the parse spike is ~2× wire size, trivial
// against ~23 KB of free chunk. Revert to 880 for any 32 KB-firmware
// device. Budgets now bound the parse spike and the AppMessage transport,
// not survival.
var ROWS_BUDGET = 1600;
// Wire budget for "load more" pages — tighter than page 0 because a
// load-more response is the ONE payload the watch must parse beside a
// retained full list (appending is its purpose). 1000 B fits a full
// MORE_PAGE of 8 stops. RELAXED 2026-07-12 from 400 B, which was sized to
// the measured ~750 B worst-case free chunk on the 32 KB arena (playbook
// §B, thirteenth recurrence) — revert to 400 for 32 KB firmware.
var MORE_BUDGET = 1000;

function loadRowsCache() {
  try {
    var e = JSON.parse(localStorage.getItem(ROWS_CACHE_KEY) || "null");
    if (!e || !e.rows || Date.now() - e.ts > ROWS_FRESH_MS) return null;
    return e.rows;
  } catch (x) {
    return null;
  }
}

function saveRowsCache(rows) {
  try {
    localStorage.setItem(ROWS_CACHE_KEY, JSON.stringify({ ts: Date.now(), rows: rows }));
  } catch (x) {
    // Quota — carry on; the watch just waits for the fresh compute.
  }
}

// The cached rows embed the favorites block and each row's `f` star flag, so
// ANY change to the favorites list or to the settings that shape the list
// (agencies, radius, hide line) makes them a lie. They are served as FINAL
// (no stale:1, no revalidation — see the cache comment above), so a stale
// entry is not merely early, it is what the watch shows for the rest of the
// serve window. Favoriting a stop, quitting, and relaunching inside those
// 3 minutes used to replay the pre-favorite rows: the stop came back
// unstarred and a re-star silently unfavorited it (the toggle trusted the
// watch's `f` flag; protocol.setFav no longer lets it). Drop the cache on
// every write instead of trying to patch it — a newly starred stop may not
// even be among the cached rows.
function clearRowsCache() {
  try {
    localStorage.removeItem(ROWS_CACHE_KEY);
  } catch (x) {
    // Nothing to do — a failed removal just means the next request rebuilds.
  }
}

/* ------------------------------------------------------------------ Clay */

Pebble.addEventListener("showConfiguration", function () {
  // Pre-populate the page with saved values.
  var s = loadSettings();
  clay.setSettings("ApiKey", s.apiKey);
  clay.setSettings("AgencySF", s.agencies.indexOf("SF") >= 0);
  clay.setSettings("AgencyBA", s.agencies.indexOf("BA") >= 0);
  clay.setSettings("AgencyAC", s.agencies.indexOf("AC") >= 0);
  clay.setSettings("AgencyGG", s.agencies.indexOf("GG") >= 0);
  clay.setSettings("AgencySM", s.agencies.indexOf("SM") >= 0);
  clay.setSettings("AgencySB", s.agencies.indexOf("SB") >= 0);
  // Everything not covered by a toggle above (CT, SC, …) goes back into the
  // free-text field. Without this the field renders EMPTY however many extra
  // agencies are saved, and the next save reads it as "" — silently dropping
  // Caltrain from settings.agencies, which is the only way it is ever added.
  clay.setSettings("ExtraAgencies", s.agencies.filter(function (code) {
    return TOGGLED_AGENCIES.indexOf(code) < 0;
  }).join(","));
  clay.setSettings("RadiusM", s.radiusM);
  clay.setSettings("RailRadiusX", s.railRadiusX);
  clay.setSettings("MaxStops", s.maxStops);
  clay.setSettings("HideFavKm", s.hideFavKm);

  // Append a remove-toggle per saved favorite before the submit button.
  // Clay serializes this.config at generateUrl() time, so rebuilding it per
  // open keeps the section in sync with the current favorites list.
  var favs = loadFavs();
  var cfg = clayConfig.slice(0, clayConfig.length - 1);
  if (favs.length) {
    var items = [
      { type: "heading", defaultValue: "Favorite stops" },
      {
        type: "text",
        defaultValue:
          "Toggle whether a favorite appears on the watch (unfavoriting " +
          "on the watch does the same thing — nothing is deleted either way)."
      }
    ];
    favs.forEach(function (f) {
      items.push({
        type: "toggle",
        messageKey: "Show_" + f.agency + "_" + f.code,
        label: f.name + " (" + f.agency + ")",
        defaultValue: !f.hide
      });
    });
    items.push({
      type: "text",
      defaultValue:
        "To delete a stop permanently, check its 🗑 toggle below and save " +
        "(you'll be asked to confirm)."
    });
    favs.forEach(function (f) {
      items.push({
        type: "toggle",
        messageKey: "Del_" + f.agency + "_" + f.code,
        label: "🗑 " + f.name + " (" + f.agency + ")",
        defaultValue: false
      });
    });
    cfg.push({ type: "section", items: items });
  }
  cfg.push(clayConfig[clayConfig.length - 1]); // submit
  clay.config = cfg;

  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener("webviewclosed", function (e) {
  if (!e || !e.response) return;
  // Second arg false => object keyed by messageKey, values under .value.
  var dict = clay.getSettings(e.response, false);
  var val = function (key, fallback) {
    return dict[key] !== undefined && dict[key].value !== undefined
      ? dict[key].value
      : fallback;
  };

  var agencies = [];
  if (val("AgencySF", true)) agencies.push("SF");
  if (val("AgencyBA", true)) agencies.push("BA");
  if (val("AgencyAC", true)) agencies.push("AC");
  if (val("AgencyGG", true)) agencies.push("GG");
  if (val("AgencySM", true)) agencies.push("SM");
  if (val("AgencySB", true)) agencies.push("SB");
  String(val("ExtraAgencies", ""))
    .split(",")
    .forEach(function (code) {
      code = code.trim().toUpperCase();
      if (code && agencies.indexOf(code) < 0) agencies.push(code);
    });

  var settings = {
    apiKey: String(val("ApiKey", "")).trim(),
    agencies: agencies,
    radiusM: Number(val("RadiusM", 500)) || 500,
    railRadiusX: Number(val("RailRadiusX", 1)) || 1,
    maxStops: Number(val("MaxStops", 8)) || 8,
    hideFavKm: Number(val("HideFavKm", 19)) || 19
  };
  saveSettings(settings);
  // Agencies, radius and the hide line all shape the rows list, and the
  // favorite show/hide/delete toggles below rewrite its star flags — every
  // cached row is suspect after a save.
  clearRowsCache();
  console.log("settings saved: " + JSON.stringify(settings));

  // Deletions first (🗑 toggles, confirmed in the webview), then apply the
  // show/hide toggles to what's left. Hiding keeps the favorite saved.
  var favs = loadFavs();
  var kept = favs.filter(function (f) {
    return !val("Del_" + f.agency + "_" + f.code, false);
  });
  var changed = favs.length - kept.length;
  kept.forEach(function (f) {
    var hide = !val("Show_" + f.agency + "_" + f.code, !f.hide);
    if (hide !== !!f.hide) {
      if (hide) f.hide = 1;
      else delete f.hide;
      changed++;
    }
  });
  if (changed) {
    saveFavs(kept);
    console.log("favorites changed via settings: " + changed);
  }

  // Nudge the watch so it can re-run its nearby search.
  Pebble.sendAppMessage({ SettingsChanged: 1 });
});

/* --------------------------------------------------------- watch requests */

function respond(id, body, budget) {
  body.id = id;
  var payload = JSON.stringify(body);
  // The rows payload budget is enforced HERE, on the final wire payload.
  // It used to run inside buildRows, before `id` (and `stale:1` on
  // cache-served replies) were appended — the overhead pushed an exactly-
  // budgeted list to 884 B on the wire and the watch crashed "memory full"
  // parsing it (playbook §B, seventh recurrence). The budget is ABSOLUTE:
  // rows are farthest-first from the tail (farthest by the effective/rank
  // distance the list is ordered by — a scaled-in rail station is not shed
  // ahead of a bus stop that ranks below it), non-favorites behind the
  // favorites block, so popping sheds all non-favorites first and then
  // favorites farthest-first as the last resort. Favorites used to be
  // exempt — 13 of them alone made a 1143 B payload that crashed the
  // watch parse (fifteenth recurrence); an oversized payload is strictly
  // worse than a hidden row. Callers can pass a tighter budget: "load
  // more" pages must fit MORE_BUDGET because they are the one response
  // that parses beside a retained full list (thirteenth recurrence).
  if (body.type === "rows" && body.rows && body.rows.length) {
    var cap = budget || ROWS_BUDGET;
    var rows = body.rows;
    while (payload.length > cap && rows.length > 1) {
      rows.pop();
      payload = JSON.stringify(body);
    }
  }
  console.log("resp id=" + id + " type=" + body.type + " " + payload.length + "B");
  Pebble.sendAppMessage(
    { Response: payload },
    function () {},
    function () {
      // One retry — AppMessage can transiently fail while the proxy is busy.
      setTimeout(function () {
        Pebble.sendAppMessage({ Response: payload });
      }, 500);
    }
  );
}

function formatDistM(m) {
  if (m < 1000) return Math.round(m) + " m";
  return (m / 1000).toFixed(1) + " km";
}

// " · IB · 8,14,49" from an agency stop-info entry: the direction (capped at
// 2) and then EVERY route serving the stop.
//
// The line list is deliberately uncapped. It used to be cut to a 14-char
// budget with a trailing "+", which is the one thing a rider cannot act on —
// "something else also stops here, good luck" is worse than a longer string,
// and the watch already ellipsizes a subtitle that overruns its row. What the
// list must not do is overrun the PAYLOAD: respond() sheds whole rows to stay
// inside ROWS_BUDGET, so an unbounded subtitle would silently drop stops off
// the end of the list. LINES_CHAR_BUDGET therefore still exists as a payload
// backstop, set far above any real stop (measured worst case in the Bay Area
// is ~30 chars, at Market & 5th) rather than as a display cap.
var LINES_CHAR_BUDGET = 60;
function dirLinesSuffix(info) {
  if (!info) return "";
  var s = "";
  if (info.dirs.length) s += " · " + info.dirs.slice(0, 2).join("/");
  if (info.lines.length) {
    var lines = "";
    for (var i = 0; i < info.lines.length; i++) {
      var next = lines ? lines + "," + info.lines[i] : info.lines[i];
      if (next.length > LINES_CHAR_BUDGET) break; // payload backstop only
      lines = next;
    }
    s += " · " + lines;
  }
  return s;
}

/* ------------------------------------------------------ direction tokens */

// A stop code is direction-specific far more often than its name admits, and
// the two 511 agencies that matter here disagree about where they say so:
//
//   Caltrain  spells it into the NAME — "Bayshore Caltrain Station Northbound"
//   BART      doesn't say at all — three ids share "12th Street / Oakland
//             City Center"; only the live DirectionRef distinguishes them
//   Muni      likewise: the two sides of a street share one name
//
// Live DirectionRef vocabulary, sampled 2026-07-14: BA and CT report "N"/"S",
// SF reports "IB"/"OB" (plus a little "N"/"S"). Folding Caltrain's spelled-out
// "…bound" onto those same tokens gives one vocabulary for every agency.
var BOUND_RE = /\s+(North|South|East|West)bound\b/i;
var BOUND_TOKEN = { NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W" };

// Every Caltrain stop is "<place> Caltrain Station <bound>". The row already
// carries "CT · " in its subtitle, so those two words are pure width — they
// cost half a row and say nothing.
var AGENCY_FILLER_RE = /\s+Caltrain Station\b/i;

// The title's token is a SINGLE letter — N, S, E, W, I (inbound), O
// (outbound) — because on the title it is not there to be read as a word: it
// is there to tell two otherwise identical rows apart at a glance, and the
// row has ~17 renderable chars to spend on the stop's actual name. The
// subtitle spells the same direction out in full ("· IB ·", dirLinesSuffix),
// where there is room for it.
//
// "" when the code is NOT direction-specific — two DirectionRefs at one code
// means both directions board there and no token would tell them apart.
function dirToken(info) {
  if (!info || info.dirs.length !== 1) return "";
  return String(info.dirs[0]).charAt(0).toUpperCase();
}

// Set off from the name so a lone letter doesn't read as part of it
// ("Bayshore · N", not "Bayshore N", which invites reading a street name).
// The middot matches the subtitle's separator; an em dash rendered correctly
// on hardware but read heavier than the row wanted.
var TOKEN_SEP = " · ";

// List-row stop names: the row fits ~17 chars of Gothic-Bold 18 before the
// watch ellipsizes, and a dumb character cap ("Mansell St & San") spends
// that width on street-type words instead of the distinguishing cross
// street. Compress instead of cutting: always shorten street-type words
// ("Powell Street" → "Powell St"); if the name still exceeds LIST_NAME_MAX,
// drop the types where they end an intersection segment ("San Bruno Ave &
// Mansell St" → "San Bruno & Mansell"); only then hard-cut. Phone-side
// only — the watch renders the string verbatim, and a watch-side expansion
// dictionary would cost bytecode = heap (playbook §B).
// Char cap on a row's display name. It approximates what actually FITS the
// row (~24 chars of Gothic-Bold 18 in 188 px) rather than being an arbitrary
// bound, and that matters: compressStopName only abbreviates and drops street
// types once the name EXCEEDS this, so a cap set far above the real width
// would stop compressing and let the watch ellipsize instead — turning
// "San Bruno & Wayland" into the strictly worse "San Bruno Ave & Wayl…".
// Raised 20 -> 24 on 2026-07-14: the direction token spends 3 of these, and
// letters are what make a stop recognizable.
var LIST_NAME_MAX = 24;
var STREET_TYPES = [
  ["Street", "St"], ["Avenue", "Ave"], ["Boulevard", "Blvd"],
  ["Road", "Rd"], ["Drive", "Dr"], ["Court", "Ct"], ["Place", "Pl"],
  ["Terrace", "Ter"], ["Lane", "Ln"], ["Highway", "Hwy"],
  ["Square", "Sq"], ["Circle", "Cir"], ["Parkway", "Pkwy"],
  ["Station", "Sta"]
];
var ABBREV_RES = STREET_TYPES.map(function (t) {
  return [new RegExp("\\b" + t[0] + "\\b", "gi"), t[1]];
});
// Trailing street type of one intersection segment. The required leading
// space keeps a Saint-style street name intact ("St Marys Ave" loses only
// the "Ave"), and anchoring to the segment end keeps interior words
// ("St Francis Blvd" keeps "St Francis").
var TYPE_SUFFIX_RE = new RegExp(
  " (" + STREET_TYPES.map(function (t) { return t[1]; }).join("|") + ")$"
);
function compressStopName(name, max) {
  max = max || LIST_NAME_MAX;
  var out = String(name);
  ABBREV_RES.forEach(function (r) { out = out.replace(r[0], r[1]); });
  if (out.length > max) {
    out = out.split(" & ").map(function (part) {
      return part.replace(TYPE_SUFFIX_RE, "");
    }).join(" & ");
  }
  if (out.length > max) {
    var cut = out.slice(0, max);
    var sp = cut.lastIndexOf(" ");
    // Drop a dangling STUB of a word ("12th St / Oakland Ci" -> "… Oakland"),
    // but never a real fragment. A longer fragment is still doing the work of
    // telling two stops apart: "San Bruno Ave & Wayland St" and "San Bruno Ave
    // & Thornton Ave" cut to "San Bruno & Wayla" and "San Bruno & Thorn",
    // whereas rounding both back to a word boundary collapses them BOTH to
    // "San Bruno" — one useless label on two different stops, 70 m apart.
    if (sp > 0 && cut.length - sp - 1 <= 2) cut = cut.slice(0, sp);
    out = cut.replace(/[ &,/]+$/, "");
  }
  return out;
}

// The display name for a stop: the compressed name, then " — " and the
// single-letter direction. This is the ONE place a stop's label is composed —
// the watch list, the favorite records the phone stores, and the Clay settings
// page all show whatever comes out of here, which is why the token has to be
// part of the name and not only the subtitle: the settings page shows no
// subtitle at all, and two "Bayshore Caltrain St" toggles are unusable.
//
// The token gets its own reserved width instead of competing for the name's:
// it is the difference between two real, distinct places, so it must survive
// the cut that a long name would otherwise force on it.
function stopLabel(rawName, info) {
  var name = String(rawName);
  var token = "";
  var m = BOUND_RE.exec(name); // Caltrain says it in the name…
  if (m) {
    token = BOUND_TOKEN[m[1].toUpperCase()];
    name = name.slice(0, m.index) + name.slice(m.index + m[0].length);
  }
  name = name.replace(AGENCY_FILLER_RE, "");
  if (!token) token = dirToken(info); // …everyone else, in the live feed
  var budget = token
    ? LIST_NAME_MAX - token.length - TOKEN_SEP.length
    : LIST_NAME_MAX;
  var out = compressStopName(name, budget);
  return token ? out + TOKEN_SEP + token : out;
}

// Build the display-ready rows list the watch renders verbatim: favorites
// (nearest first, dimmed when serviceless) followed by nearby non-favorite
// stops.
//
// "Nearest" in both blocks means nearest by EFFECTIVE distance — real
// distance ÷ railRadiusX for BART/Caltrain (transit511's railScale; the
// provider hands back `eff` beside `dist` so rail knowledge stays behind
// the provider boundary). A far station therefore interleaves with the bus
// stops it's worth as much as instead of sitting at the bottom. Rows always
// DISPLAY the real distance.
//
// Favorites farther than settings.hideFavKm — × railRadiusX for BART/
// Caltrain, the same reach the nearby search now gives them
// (getFavoriteStatus flags them far:1) — are left out entirely: no payload
// bytes, no arrival-check API calls (they reappear when you get closer, and
// stay editable on the settings page) — but they are NOT suppressed from the
// nearby block, or a station starred from a deep "load more" page would have
// no row at all. Names carry the direction token (stopLabel) and subtitles the
// serving lines (dirLinesSuffix, which spells the direction out again), both
// from the cached agency-wide stop-info map.
// All formatting lives here because watch code costs watch heap (playbook §B).
function buildRows(req, lat, lon, settings) {
  transit.findNearbyStops(lat, lon, settings, function (err, stops) {
    if (err) return respond(req.id, { type: "error", message: err.message });
    // Hidden favorites cost nothing: no status lookups, no payload, no spot
    // in the favorites block. Their stop can still show up as an ordinary
    // unstarred nearby row when physically close (only the favorites we
    // actually emit are suppressed from the nearby block, and a hidden one
    // never gets that far) — starring it there unhides it.
    var allFavs = loadFavs(); // the records themselves — see the repair below
    var favs = allFavs.filter(function (f) { return !f.hide; });
    var hideM = (Number(settings.hideFavKm) || 19) * 1000;

    var assemble = function (favStatus, infoByAgency) {
      var infoFor = function (agency, code) {
        return infoByAgency[agency] && infoByAgency[agency][code];
      };
      var status = {}; // "AGENCY:code" -> {dist, name, hasArr}
      (favStatus || []).forEach(function (f) {
        status[f.agency + ":" + f.code] = f;
      });

      // Favorite records heal here rather than needing to be re-starred:
      //
      //   code — a BART favorite may point at a stop code that no longer
      //          exists: a PLATFORM id (901801), or a bare STATION id from the
      //          brief spell when stations were undirected (901809). Both now
      //          live under a station-direction code. getFavoriteStatus returns
      //          the station as `canonBase`; the DIRECTION is only knowable
      //          from live data, so it is resolved here, off the stop-info map,
      //          which keys the retired platform ids for exactly this purpose.
      //          Left alone the record resolves to nothing and its arrivals
      //          come back empty forever.
      //   name — what the settings page shows, and it was whatever compressed
      //          string the watch happened to send at the time. Records
      //          written before stopLabel existed read "Bayshore Caltrain St"
      //          twice over, with nothing to tell the two platforms apart.
      var favsRepaired = false;
      var emitted = {}; // agency:code already in the favorites block

      var favRows = [];
      favs.forEach(function (f) {
        var st = status[f.agency + ":" + f.code];
        var dist = st && st.dist >= 0 ? st.dist : undefined;
        // Beyond the hide line — per-agency: BART/Caltrain favorites reach
        // hideFavKm × railRadiusX (getFavoriteStatus computes the flag).
        if (st && st.far) return;
        if (st && st.canonBase) {
          // Which way was this stop? The retired platform's own live entry
          // says so. A platform serving both directions (Bay Fair, Coliseum)
          // takes the first — those two records were indistinguishable
          // duplicates anyway, which is what started all this; dedupeFavs
          // merges them. Nothing running at all (deep night) falls back to N.
          var old = infoFor(f.agency, f.code);
          var dir = (old && old.dirs.length && old.dirs[0]) || "N";
          f.code = st.canonBase + "-" + dir; // shared object — allFavs sees it
          favsRepaired = true;
        }
        // Two records can land on one stop the moment a migration merges them
        // (both Balboa Park platforms -> the station). Emit the row once; the
        // redundant record is dropped from storage by dedupeFavs below.
        var favKey = f.agency + ":" + f.code;
        if (emitted[favKey]) return;
        emitted[favKey] = 1;
        // hasArr is a boolean from the stop-info map (false = checked, nothing
        // arriving; undefined = not checked, e.g. beyond the hide line — leave
        // those undimmed). It used to be 0/1, hence the earlier `=== 0`.
        var noArr = !!st && st.hasArr === false;
        var info = infoFor(f.agency, f.code);
        var label = st && st.name ? stopLabel(st.name, info) : String(f.name);
        if (st && st.name && f.name !== label) {
          f.name = label;
          favsRepaired = true;
        }
        var row = {
          a: f.agency, c: f.code,
          n: label,
          s: f.agency +
            (dist !== undefined ? " · " + formatDistM(dist) : "") +
            (noArr ? " · no arrivals" : dirLinesSuffix(info)),
          f: 1,
          // Rank (not display) distance: getFavoriteStatus divides BART/
          // Caltrain by railRadiusX, so a starred station sorts among the
          // stops it's worth as much as. Unknown distance sorts last.
          _d: st && st.eff >= 0 ? st.eff : 1e9
        };
        if (noArr) row.m = 1;
        favRows.push(row);
      });
      favRows.sort(function (x, y) { return x._d - y._d; });
      // Nearest favorites only (dist-unknown ones sort last and cap out
      // first) — see FAV_ROWS_MAX: an uncapped favorites block has filled
      // the whole payload budget and crashed the watch.
      if (favRows.length > FAV_ROWS_MAX) favRows.length = FAV_ROWS_MAX;

      // Suppress from the nearby block exactly the favorites that made the
      // favorites block — `emitted`, keyed by the codes as they now stand
      // (the loop above may have migrated them). Rebuilding this set from
      // `favs` here would look up `status` under the NEW code and miss, since
      // getFavoriteStatus keyed it by the old one.
      //
      // A favorite past the hide line (far:1) is not in `emitted`, and that is
      // the point: dropping it from the favorites block AND filtering it out
      // here made it vanish from the list ENTIRELY, starred and unstarred
      // alike, so a station starred from a deep "load more" page could never
      // be reached again from the watch. Those fall through as ordinary rows.
      var rows = favRows.map(function (r) { delete r._d; return r; });
      stops.forEach(function (s) {
        if (emitted[s.agency + ":" + s.code]) return;
        // Same serviceless signal as favorites: agency map loaded but the
        // stop is absent = checked, nothing arriving (map missing entirely =
        // unchecked, leave undimmed).
        var noArr = !!infoByAgency[s.agency] && !infoFor(s.agency, s.code);
        var row = {
          a: s.agency, c: s.code,
          n: stopLabel(s.name, infoFor(s.agency, s.code)),
          s: s.agency + (s.dist !== undefined ? " · " + formatDistM(s.dist) : "") +
            (noArr ? " · no arrivals" : dirLinesSuffix(infoFor(s.agency, s.code)))
        };
        if (noArr) row.m = 1;
        rows.push(row);
      });

      // Codes and names healed above; drop any records the code migration just
      // merged onto one stop, and persist. The rows cache is written from this
      // same build, so it and the favorites list stay in step.
      if (favsRepaired) saveFavs(dedupeFavs(allFavs));

      // The watch renders 14 rows at most — anything past that is bytes
      // the budget shed would spend compute on and the stale cache would
      // hold for nothing.
      if (rows.length > WATCH_LIST_CAP) rows.length = WATCH_LIST_CAP;

      // Response-order trace (★ = favorite) — reads as the on-watch order.
      console.log("rows order: " + rows.map(function (r) {
        return (r.f ? "*" : "") + ((r.s.split(" · ")[1]) || "?");
      }).join(", "));

      var body = { type: "rows", rows: rows };
      // Budgeting to ROWS_BUDGET happens in respond(), on the final serialized
      // payload. Persist the list first for instant stale-while-revalidate
      // replies (the cache may hold a row or two more than fits one reply;
      // stale serves re-shed in respond). Only the normal page-0 list is
      // cached ("load more" pages go through buildMoreRows).
      saveRowsCache(rows);
      respond(req.id, body);
    };

    // Fetch the stop-info map for every agency that will appear in the rows
    // (cache-hit free within 10 min; getFavoriteStatus warmed the favorites'
    // agencies already).
    var withInfo = function (favStatus) {
      var agSet = {};
      stops.forEach(function (s) { agSet[s.agency] = 1; });
      (favStatus || []).forEach(function (f) {
        if (f.dist >= 0 && !f.far) agSet[f.agency] = 1;
      });
      var infoByAgency = {};
      var list = Object.keys(agSet);
      var remaining = list.length;
      if (!remaining) return assemble(favStatus, infoByAgency);
      // Fire all agencies' stop-info calls concurrently. Sequential was the
      // main field latency — N agency-wide StopMonitoring round-trips back to
      // back before any rows could be sent. Each is cached 10 min
      // (transit511.js), so warm agencies return at once and the whole
      // fan-out costs about one round-trip instead of N.
      list.forEach(function (ag) {
        transit.getStopInfo(ag, settings.apiKey, function (e, map) {
          if (!e) infoByAgency[ag] = map;
          if (--remaining === 0) assemble(favStatus, infoByAgency);
        });
      });
    };

    if (!favs.length) return withInfo([]);
    transit.getFavoriteStatus(favs, lat, lon, settings, hideM, function (fErr, favStatus) {
      withInfo(fErr ? [] : favStatus);
    });
  });
}

// "Load more stops": return non-favorite nearby stops beyond the req.off
// nearest (the ones the watch already shows), ranked by effective distance
// from a wide search — same ranking as page 0, so req.off lines up with what
// the watch has and BART/Caltrain keep their railRadiusX reach out of the
// wider MORE_RADIUS_M search. No favorites block and no stale cache — the
// watch appends these to its list. An empty rows array means there are no
// more stops (the watch then stops asking). Mirrors buildRows' subtitles.
function buildMoreRows(req, lat, lon, settings) {
  transit.findNearbyStops(lat, lon, settings, function (err, stops) {
    if (err) return respond(req.id, { type: "error", message: err.message });
    var favKeys = {};
    loadFavs().filter(function (f) { return !f.hide; })
      .forEach(function (f) { favKeys[f.agency + ":" + f.code] = 1; });

    // A favorite is skipped here only if page 0 is actually showing it in the
    // favorites block — i.e. it is inside the hide line. buildRows drops
    // favorites past that line (getFavoriteStatus's far:1), and this search is
    // deliberately wide (MORE_RADIUS_M doubles per page, out to 200 km), so
    // skipping every favorite made a far one — a Caltrain station starred from
    // a deep page, beyond the 19 km hideFavKm default — invisible in BOTH
    // blocks, with no way back to it from the watch.
    //
    // `eff` is the rank distance (real distance ÷ the agency's rail scale),
    // and getFavoriteStatus's far test divides by that same scale, so
    // `eff > hideM` is exactly its far:1 — no rail knowledge leaks over the
    // provider boundary here.
    var hideM = (Number(settings.hideFavKm) || 19) * 1000;
    var shownAsFav = function (s) {
      return !!favKeys[s.agency + ":" + s.code] && s.eff <= hideM;
    };

    var agSet = {};
    stops.forEach(function (s) {
      if (!shownAsFav(s)) agSet[s.agency] = 1;
    });
    var infoByAgency = {};
    var list = Object.keys(agSet);
    var remaining = list.length;

    var finish = function () {
      var infoFor = function (a, c) {
        return infoByAgency[a] && infoByAgency[a][c];
      };
      var rows = [];
      stops.forEach(function (s) {
        if (shownAsFav(s)) return; // already in page 0's favorites block
        // Same serviceless dimming as buildRows: in-map = something coming.
        var noArr = !!infoByAgency[s.agency] && !infoFor(s.agency, s.code);
        var row = {
          a: s.agency, c: s.code,
          n: stopLabel(s.name, infoFor(s.agency, s.code)),
          s: s.agency + (s.dist !== undefined ? " · " + formatDistM(s.dist) : "") +
            (noArr ? " · no arrivals" : dirLinesSuffix(infoFor(s.agency, s.code)))
        };
        if (noArr) row.m = 1;
        // A starred stop that reaches you on a load-more page — one past the
        // hide line, so it never made the favorites block — is still a
        // favorite, and must still wear its star. It stays part of THIS list
        // for pagination: `off` counts what the phone has handed over, and the
        // watch advances its cursor by the rows it receives, so a star here
        // costs the accounting nothing (main.js fetchMore).
        if (favKeys[s.agency + ":" + s.code]) row.f = 1;
        rows.push(row);
      });
      rows = rows.slice(Number(req.off) || 0); // drop the ones already on the watch
      var body = { type: "rows", rows: rows };
      // Budgeted to MORE_BUDGET in respond() (sheds in place, so log after).
      respond(req.id, body, MORE_BUDGET);
      console.log("more rows: " + rows.length + " beyond off " + req.off);
    };

    if (!remaining) return finish();
    list.forEach(function (ag) {
      transit.getStopInfo(ag, settings.apiKey, function (e, map) {
        if (!e) infoByAgency[ag] = map;
        if (--remaining === 0) finish();
      });
    });
  });
}

function handleRequest(req) {
  var settings = loadSettings();

  if (!settings.apiKey) {
    return respond(req.id, {
      type: "error",
      message: "Set API key in app settings"
    });
  }

  if (req.cmd === "nearby") {
    // "Load more stops" (req.off = how many non-favorite stops the watch
    // already shows): paginate the next farther stops from a wide search and
    // let the watch append them. Never touches the stale cache.
    if (req.off) {
      var wide = {};
      for (var wk in settings) wide[wk] = settings[wk];
      // The search radius GROWS with how deep you've scrolled: every page
      // doubles it (5 km, 10, 20, … up to MORE_RADIUS_MAX_M), so Down never
      // runs into a fixed distance wall. A fixed 5 km used to be the wall —
      // once you'd seen every stop inside it, every further Down returned an
      // empty page and the watch latched "exhausted" for good. Widening is
      // free: the agency stop lists are already cached on the phone and the
      // radius is only a filter over them (no extra 511 calls).
      var page = Math.floor(Number(req.off) / MORE_PAGE);
      var grown = MORE_RADIUS_M * Math.pow(2, page);
      wide.radiusM = Math.min(
        Math.max(settings.radiusM, grown),
        MORE_RADIUS_MAX_M
      );
      // Reach past the default candidate ceiling far enough for one more page.
      wide.maxStops = Number(req.off) + MORE_PAGE + 2;
      wide.hardCeiling = Number(req.off) + MORE_PAGE + 2;
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          buildMoreRows(req, pos.coords.latitude, pos.coords.longitude, wide);
        },
        function (geoErr) {
          console.log("geolocation failed: " + (geoErr && geoErr.message));
          respond(req.id, { type: "error", message: "No phone location" });
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }
      );
      return;
    }
    // Instant cached reply, served as FINAL — no stale:1, so the watch
    // never schedules the revalidation follow-up that crashed it (see the
    // rows cache comment above).
    if (!req.fresh) {
      var cachedRows = loadRowsCache();
      if (cachedRows) {
        console.log("req nearby: served cached (" + cachedRows.length + " rows)");
        return respond(req.id, { type: "rows", rows: cachedRows });
      }
    }
    if (req.mig) importLegacyFavs(req.mig);
    console.log("req nearby: locating...");
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        buildRows(req, pos.coords.latitude, pos.coords.longitude, settings);
      },
      function (geoErr) {
        console.log("geolocation failed: " + (geoErr && geoErr.message));
        respond(req.id, { type: "error", message: "No phone location" });
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }
    );
  } else if (req.cmd === "arrivals") {
    transit.getArrivals(req.agency, req.stop, settings.apiKey, req.lim || 6, function (err, arrivals) {
      if (err) return respond(req.id, { type: "error", message: err.message });
      respond(req.id, { type: "arrivals", stop: req.stop, arrivals: arrivals });
    });
  } else if (req.cmd === "fav") {
    // The watch's Select sets VISIBILITY, never deletes: unfavoriting hides
    // the saved record (star it again — even via its unstarred nearby row —
    // and it comes back). Deletion is settings-page only (trash toggles +
    // confirmation).
    //
    // req.w is the state the watch is asking FOR (1 favorite, 0 unfavorite),
    // applied idempotently. It used to be a blind flip of whatever we had
    // stored, which meant a watch showing a stale `f` flag would unstar the
    // stop the user was trying to star. Older watch builds send no `w`; fall
    // back to the flip for them.
    var favs = loadFavs();
    var key = String(req.a) + ":" + String(req.c);
    var fav = null;
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].agency + ":" + favs[i].code === key) { fav = favs[i]; break; }
    }
    var nowFav = req.w === undefined
      ? (fav && !fav.hide ? 0 : 1) // legacy watch: flip
      : (req.w ? 1 : 0);
    if (!fav) {
      // Unfavoriting something we've never stored is already true — don't
      // create a record just to mark it hidden.
      if (nowFav) {
        favs.unshift({
          agency: String(req.a), code: String(req.c), name: String(req.n || req.c)
        });
      }
    } else if (nowFav) {
      delete fav.hide;
    } else {
      fav.hide = 1;
    }
    saveFavs(favs);
    clearRowsCache(); // the cached rows carry the old star flags
    respond(req.id, { type: "fav", fav: nowFav });
  } else {
    respond(req.id, { type: "error", message: "unknown cmd " + req.cmd });
  }
}

/* ---------------------------------------------------------------- wiring */

// The stop cache is versioned on the SHAPE of a stop code, and that shape has
// changed twice (transit511 STOP_CACHE_PREFIX) — stranding a v1 and a v2 list
// per agency. They are by far the biggest thing this app stores (Muni alone is
// 3,000-odd stops), and saveStopCache swallows a quota failure with nothing but
// a log line, so leaving dead generations behind risks silently losing the
// cache we actually use and re-downloading every stop list on every request.
// Cheap to sweep, once per launch.
var DEAD_STOP_CACHE_PREFIXES = ["stops511.v1.", "stops511.v2."];
function dropStaleStopCaches() {
  var agencies = loadSettings().agencies.concat(TOGGLED_AGENCIES);
  agencies.forEach(function (ag) {
    DEAD_STOP_CACHE_PREFIXES.forEach(function (prefix) {
      try {
        localStorage.removeItem(prefix + ag);
      } catch (e) { /* nothing to do */ }
    });
  });
}

Pebble.addEventListener("ready", function () {
  console.log("Transit Glance PKJS ready");
  dropStaleStopCaches();
  // The watch usually boots before this JS is listening, so its first
  // nearby request can vanish and time out. SettingsChanged doubles as a
  // "phone is ready" ping — the watch responds by re-running its nearby
  // search (protocol.onSettingsChanged).
  Pebble.sendAppMessage({ SettingsChanged: 1 });
});

Pebble.addEventListener("appmessage", function (e) {
  var raw = e.payload && e.payload.Request;
  if (raw === undefined) return;

  var req;
  try {
    req = JSON.parse(raw);
  } catch (err) {
    console.log("bad request JSON from watch");
    return;
  }
  handleRequest(req);
});
