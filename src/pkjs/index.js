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

// autoHandleEvents:false — we intercept webviewclosed so settings stay on
// the phone instead of being pushed to the watch key-by-key.
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

var SETTINGS_KEY = "settings.v1";

// localSecrets.apiKey is a local dev convenience (see scripts/inject-api-key.js
// and .env.example) — seeds the settings page before you've saved anything
// via Clay. It is never committed; on a fresh clone it's "".
var DEFAULT_SETTINGS = {
  apiKey: localSecrets.apiKey || "",
  agencies: ["SF", "BA", "AC", "GG", "SM"],
  radiusM: 500,
  maxStops: 8
};

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
    maxStops: Number(val("MaxStops", 8)) || 8
  };
  saveSettings(settings);
  console.log("settings saved: " + JSON.stringify(settings));

  // Nudge the watch so it can re-run its nearby search.
  Pebble.sendAppMessage({ SettingsChanged: 1 });
});

/* --------------------------------------------------------- watch requests */

function respond(id, body) {
  body.id = id;
  var payload = JSON.stringify(body);
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

// The watch sends its favorites as compact "AGENCY:code" strings; names are
// resolved here from the cached stop lists (the watch fills any gaps from
// its own saved names).
function parseFavs(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length && out.length < 10; i++) {
    var s = String(raw[i]);
    var idx = s.indexOf(":");
    if (idx > 0) out.push({ agency: s.slice(0, idx), code: s.slice(idx + 1) });
  }
  return out;
}

function formatDistM(m) {
  if (m < 1000) return Math.round(m) + " m";
  return (m / 1000).toFixed(1) + " km";
}

// Favorites farther than this draw dimmed on the watch — keep in sync with
// ARRIVAL_CHECK_MAX_M in transit511.js (12 miles).
var FAR_M = 19312;

// Build the display-ready rows list the watch renders verbatim: favorites
// (nearest first, dimmed when far away or serviceless) followed by nearby
// non-favorite stops. All formatting lives here because watch code costs
// watch heap (docs/WATCH-DEBUGGING-PLAYBOOK.md §B).
function buildRows(req, lat, lon, settings) {
  transit.findNearbyStops(lat, lon, settings, function (err, stops) {
    if (err) return respond(req.id, { type: "error", message: err.message });
    var favs = parseFavs(req.favs);

    var finish = function (favStatus) {
      var status = {}; // "AGENCY:code" -> {dist, hasArr}
      (favStatus || []).forEach(function (f) {
        status[f.agency + ":" + f.code] = f;
      });

      var favRows = favs.map(function (f) {
        var st = status[f.agency + ":" + f.code];
        var dist = st && st.dist >= 0 ? st.dist : undefined;
        var noArr = !!st && st.hasArr === 0;
        // n omitted when the cache had no name — the watch substitutes its
        // own saved favorite name.
        var row = {
          a: f.agency, c: f.code, n: st && st.name,
          s: f.agency +
            (dist !== undefined ? " · " + formatDistM(dist) : "") +
            (noArr ? " · no arrivals" : ""),
          _d: dist === undefined ? 1e9 : dist
        };
        if (noArr || (dist !== undefined && dist > FAR_M)) row.m = 1;
        return row;
      });
      favRows.sort(function (x, y) { return x._d - y._d; });

      var favKeys = {};
      favs.forEach(function (f) { favKeys[f.agency + ":" + f.code] = 1; });
      var rows = favRows.map(function (r) { delete r._d; return r; });
      stops.forEach(function (s) {
        if (favKeys[s.agency + ":" + s.code]) return;
        rows.push({
          a: s.agency, c: s.code, n: s.name,
          s: s.agency + (s.dist !== undefined ? " · " + formatDistM(s.dist) : "")
        });
      });

      var body = { type: "rows", rows: rows };
      // Payload budget: 700 B, tighter than the usual ~1 KB discipline —
      // the watch parses this while its chunk heap has only a few KB of
      // slack on 32 KB-arena firmware (playbook §B). Shed the farthest
      // nearby stops first; favorites are never shed.
      while (JSON.stringify(body).length > 700 && rows.length > favRows.length) {
        rows.pop();
      }
      respond(req.id, body);
    };

    if (!favs.length) return finish([]);
    transit.getFavoriteStatus(favs, lat, lon, settings, function (fErr, favStatus) {
      finish(fErr ? [] : favStatus);
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
    console.log("req nearby: locating…");
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
    transit.getArrivals(req.agency, req.stop, settings.apiKey, function (err, arrivals) {
      if (err) return respond(req.id, { type: "error", message: err.message });
      respond(req.id, { type: "arrivals", stop: req.stop, arrivals: arrivals });
    });
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
