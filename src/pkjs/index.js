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
var DEFAULT_SETTINGS = {
  apiKey: localSecrets.apiKey || "",
  agencies: ["SF", "BA", "AC", "GG", "SM"],
  radiusM: 500,
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

// Stale-while-revalidate: the last computed rows list is persisted so the
// watch can render a list the instant it asks (even at cold app launch),
// before any geolocation or network work runs. A non-fresh "nearby" request
// is answered immediately from this cache with stale:1; the watch shows it,
// then fires exactly one fresh:1 follow-up that does the real compute and
// replaces the list. Only the normal page-0 list is cached — "load more"
// pages (buildMoreRows) are not, so a launch never flashes a long list.
var ROWS_CACHE_KEY = "rows.v1";
// Don't serve a stale list older than this — past it you may be somewhere
// else entirely, so eat the compute rather than flash a wrong location.
var ROWS_STALE_TTL_MS = 6 * 60 * 60 * 1000; // 6 h

// "Load more stops" pagination (buildMoreRows): a wide search radius so
// farther stops become reachable, and how many farther stops to return per
// page. The watch caps its total list length, so this only needs to feed
// the next screenful.
var MORE_RADIUS_M = 5000;
var MORE_PAGE = 8;

function loadRowsCache() {
  try {
    var e = JSON.parse(localStorage.getItem(ROWS_CACHE_KEY) || "null");
    if (!e || !e.rows || Date.now() - e.ts > ROWS_STALE_TTL_MS) return null;
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
  clay.setSettings("RadiusM", s.radiusM);
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
    maxStops: Number(val("MaxStops", 8)) || 8,
    hideFavKm: Number(val("HideFavKm", 19)) || 19
  };
  saveSettings(settings);
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

function respond(id, body) {
  body.id = id;
  var payload = JSON.stringify(body);
  // The rows payload budget is enforced HERE, on the final wire payload.
  // It used to run inside buildRows, before `id` (and `stale:1` on
  // cache-served replies) were appended — the overhead pushed an exactly-
  // budgeted list to 884 B on the wire and the watch crashed "memory full"
  // parsing it (playbook §B, seventh recurrence). Farthest nearby stops
  // shed first (rows arrive sorted); favorites are never shed.
  if (body.type === "rows" && body.rows && body.rows.length) {
    var rows = body.rows;
    var favCount = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].f) favCount++;
    while (payload.length > 880 && rows.length > Math.max(favCount, 1)) {
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

// " · N · 8,14,49+" from an agency stop-info entry (directions capped at 2,
// lines capped by a character budget rather than a count — BART's one-letter
// lines all fit ("Y,R,B,G"), four-char route tokens cap around three —
// subtitle space on the watch is one ellipsized line).
var LINES_CHAR_BUDGET = 14;
function dirLinesSuffix(info) {
  if (!info) return "";
  var s = "";
  if (info.dirs.length) s += " · " + info.dirs.slice(0, 2).join("/");
  if (info.lines.length) {
    var lines = "";
    var i = 0;
    while (i < info.lines.length) {
      var next = lines ? lines + "," + info.lines[i] : info.lines[i];
      if (next.length > LINES_CHAR_BUDGET) break;
      lines = next;
      i++;
    }
    s += " · " + lines + (i < info.lines.length ? "+" : "");
  }
  return s;
}

// Build the display-ready rows list the watch renders verbatim: favorites
// (nearest first, dimmed when serviceless) followed by nearby non-favorite
// stops. Favorites farther than settings.hideFavKm are left out entirely —
// no payload bytes, no arrival-check API calls (they reappear when you get
// closer, and stay editable on the settings page). Subtitles carry the
// stop's direction and serving lines from the cached agency-wide stop-info
// map. All formatting lives here because watch code costs watch heap
// (playbook §B).
function buildRows(req, lat, lon, settings) {
  transit.findNearbyStops(lat, lon, settings, function (err, stops) {
    if (err) return respond(req.id, { type: "error", message: err.message });
    // Hidden favorites cost nothing: no status lookups, no payload, no spot
    // in the favorites block. Their stop can still show up as an ordinary
    // unstarred nearby row when physically close (favKeys below uses only
    // visible favorites) — starring it there unhides it.
    var favs = loadFavs().filter(function (f) { return !f.hide; });
    var hideM = (Number(settings.hideFavKm) || 19) * 1000;

    var assemble = function (favStatus, infoByAgency) {
      var infoFor = function (agency, code) {
        return infoByAgency[agency] && infoByAgency[agency][code];
      };
      var status = {}; // "AGENCY:code" -> {dist, name, hasArr}
      (favStatus || []).forEach(function (f) {
        status[f.agency + ":" + f.code] = f;
      });

      var favRows = [];
      favs.forEach(function (f) {
        var st = status[f.agency + ":" + f.code];
        var dist = st && st.dist >= 0 ? st.dist : undefined;
        if (dist !== undefined && dist > hideM) return; // beyond the hide line
        // hasArr is a boolean from the stop-info map (false = checked, nothing
        // arriving; undefined = not checked, e.g. beyond the hide line — leave
        // those undimmed). It used to be 0/1, hence the earlier `=== 0`.
        var noArr = !!st && st.hasArr === false;
        var row = {
          a: f.agency, c: f.code,
          n: (st && st.name) || f.name,
          s: f.agency +
            (dist !== undefined ? " · " + formatDistM(dist) : "") +
            (noArr ? " · no arrivals" : dirLinesSuffix(infoFor(f.agency, f.code))),
          f: 1,
          _d: dist === undefined ? 1e9 : dist
        };
        if (noArr) row.m = 1;
        favRows.push(row);
      });
      favRows.sort(function (x, y) { return x._d - y._d; });

      var favKeys = {};
      favs.forEach(function (f) { favKeys[f.agency + ":" + f.code] = 1; });
      var rows = favRows.map(function (r) { delete r._d; return r; });
      stops.forEach(function (s) {
        if (favKeys[s.agency + ":" + s.code]) return;
        rows.push({
          a: s.agency, c: s.code, n: s.name,
          s: s.agency + (s.dist !== undefined ? " · " + formatDistM(s.dist) : "") +
            dirLinesSuffix(infoFor(s.agency, s.code))
        });
      });

      // Response-order trace (★ = favorite) — reads as the on-watch order.
      console.log("rows order: " + rows.map(function (r) {
        return (r.f ? "*" : "") + ((r.s.split(" · ")[1]) || "?");
      }).join(", "));

      var body = { type: "rows", rows: rows };
      // Budgeting to 880 B happens in respond(), on the final serialized
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
        if (f.dist >= 0 && f.dist <= hideM) agSet[f.agency] = 1;
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
// nearest (the ones the watch already shows), ranked by distance from a wide
// search. No favorites block and no stale cache — the watch appends these to
// its list. An empty rows array means there are no more stops (the watch then
// stops asking). Mirrors buildRows' subtitle formatting.
function buildMoreRows(req, lat, lon, settings) {
  transit.findNearbyStops(lat, lon, settings, function (err, stops) {
    if (err) return respond(req.id, { type: "error", message: err.message });
    var favKeys = {};
    loadFavs().filter(function (f) { return !f.hide; })
      .forEach(function (f) { favKeys[f.agency + ":" + f.code] = 1; });

    var agSet = {};
    stops.forEach(function (s) {
      if (!favKeys[s.agency + ":" + s.code]) agSet[s.agency] = 1;
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
        if (favKeys[s.agency + ":" + s.code]) return; // favorites already shown
        rows.push({
          a: s.agency, c: s.code, n: s.name,
          s: s.agency + (s.dist !== undefined ? " · " + formatDistM(s.dist) : "") +
            dirLinesSuffix(infoFor(s.agency, s.code))
        });
      });
      rows = rows.slice(Number(req.off) || 0); // drop the ones already on the watch
      var body = { type: "rows", rows: rows };
      // Budgeted to 880 B in respond() (sheds in place, so log after).
      respond(req.id, body);
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
      wide.radiusM = Math.max(settings.radiusM, MORE_RADIUS_M);
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
    // Instant stale reply: answer a plain (non-fresh) request from the
    // persisted list with no geolocation or network work, then let the watch
    // revalidate with a fresh:1 follow-up (see rows cache above).
    if (!req.fresh) {
      var cachedRows = loadRowsCache();
      if (cachedRows) {
        console.log("req nearby: served stale (" + cachedRows.length + " rows)");
        return respond(req.id, { type: "rows", rows: cachedRows, stale: 1 });
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
    // The watch's Select toggles VISIBILITY, never deletes: unfavoriting
    // hides the saved record (star it again — even via its unstarred
    // nearby row — and it comes back). Deletion is settings-page only
    // (trash toggles + confirmation).
    var favs = loadFavs();
    var key = String(req.a) + ":" + String(req.c);
    var fav = null;
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].agency + ":" + favs[i].code === key) { fav = favs[i]; break; }
    }
    var nowFav;
    if (!fav) {
      favs.unshift({ agency: String(req.a), code: String(req.c), name: String(req.n || req.c) });
      nowFav = 1;
    } else if (fav.hide) {
      delete fav.hide;
      nowFav = 1;
    } else {
      fav.hide = 1;
      nowFav = 0;
    }
    saveFavs(favs);
    respond(req.id, { type: "fav", fav: nowFav });
  } else {
    respond(req.id, { type: "error", message: "unknown cmd " + req.cmd });
  }
}

/* ---------------------------------------------------------------- wiring */

Pebble.addEventListener("ready", function () {
  console.log("Transit Glance PKJS ready");
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
