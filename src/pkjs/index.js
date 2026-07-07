/*
 * index.js — phone side of Transit Glance (PebbleKit JS).
 *
 * Responsibilities:
 *   1. Run the @moddable/pebbleproxy so the watch's Location sensor works.
 *   2. Serve the Clay settings page and persist settings in PHONE
 *      localStorage (settings never live on the watch — see config.js).
 *   3. Answer watch requests ("nearby", "arrivals") using transit511.js.
 *
 * Message routing order matters: the proxy gets first look at every
 * appmessage (it returns true when the message was one of its own, e.g. a
 * Location request); everything else falls through to our router.
 */

var Clay = require("@rebble/clay");
var clayConfig = require("./config");
var moddableProxy = require("@moddable/pebbleproxy");
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

// The watch sends favorites as compact "AGENCY:code" strings.
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

function handleRequest(req) {
  var settings = loadSettings();

  if (!settings.apiKey) {
    return respond(req.id, {
      type: "error",
      message: "Set API key in app settings"
    });
  }

  if (req.cmd === "nearby") {
    transit.findNearbyStops(req.lat, req.lon, settings, function (err, stops) {
      if (err) return respond(req.id, { type: "error", message: err.message });
      var favs = parseFavs(req.favs);
      if (!favs.length) return respond(req.id, { type: "stops", stops: stops });
      transit.getFavoriteStatus(favs, req.lat, req.lon, settings, function (fErr, favStatus) {
        var body = { type: "stops", stops: stops };
        if (!fErr && favStatus && favStatus.length) {
          // Compact keys — this rides in the same ~1 KB payload as stops.
          body.favs = favStatus.map(function (f) {
            var e = { a: f.agency, c: f.code, d: f.dist };
            if (f.hasArr !== undefined) e.h = f.hasArr ? 1 : 0;
            return e;
          });
        }
        // Payload budget: favorites status can push a dense stop list past
        // ~1 KB; shed the farthest nearby stops before breaking AppMessage.
        while (JSON.stringify(body).length > 950 && body.stops.length > 4) {
          body.stops.pop();
        }
        respond(req.id, body);
      });
    });
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

Pebble.addEventListener("ready", function (e) {
  moddableProxy.readyReceived(e);
  console.log("Transit Glance PKJS ready");
});

Pebble.addEventListener("appmessage", function (e) {
  if (moddableProxy.appMessageReceived(e)) return; // proxy traffic (Location)

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
