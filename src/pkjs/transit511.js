/*
 * transit511.js — 511 SF Bay Open Data client. Runs on the PHONE (PKJS).
 *
 * One API, every requested agency. 511.org's regional feed covers SF Muni,
 * BART, AC Transit, Golden Gate Transit, SamTrans, and 30+ other Bay Area
 * operators, each addressed by a short operator code:
 *
 *   SF = San Francisco Muni      BA = BART
 *   AC = AC Transit              GG = Golden Gate Transit
 *   SM = SamTrans                CT = Caltrain (extendable), etc.
 *
 * Verify codes at:  https://api.511.org/transit/operators?api_key=KEY&format=json
 *
 * Endpoints used (docs: https://511.org/open-data/transit):
 *   Stops:          https://api.511.org/transit/stops?api_key=K&operator_id=SF&format=json
 *   StopMonitoring: https://api.511.org/transit/StopMonitoring?api_key=K&agency=SF&stopcode=15553&format=json
 *
 * Gotchas baked into this file:
 *   - 511 JSON responses begin with a UTF-8 BOM (\uFEFF). Strip before parse.
 *   - Rate limit: 60 requests / hour / key by default. Stop lists are cached
 *     for 7 days in phone localStorage so nearby searches cost 0 requests
 *     once warm; only StopMonitoring hits the network per refresh.
 *   - Stop lists are big (Muni ≈ 3,500 stops). They are compacted to
 *     [code, name, lat, lon] tuples before caching and are NEVER sent to
 *     the watch — only the top-N nearest stops go over AppMessage.
 *
 * This module is provider-agnostic at its boundary: index.js only calls
 * findNearbyStops(), getArrivals() and getFavoriteStatus(). To support a
 * non-511 region, write a sibling module with the same three functions and
 * switch on a setting.
 */

/* eslint-env browser */
/* global localStorage, XMLHttpRequest */

var BASE = "https://api.511.org/transit";
var STOP_CACHE_PREFIX = "stops511.v1.";
var STOP_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ------------------------------------------------------------------ http */

function getJSON(url, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url, true);
  xhr.timeout = 20000;
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      var msg = "HTTP " + xhr.status;
      if (xhr.status === 401) msg = "Bad API key";
      if (xhr.status === 429) msg = "Rate limited";
      return cb(new Error(msg));
    }
    try {
      // 511 responses start with a UTF-8 BOM which breaks JSON.parse.
      var text = xhr.responseText.replace(/^\uFEFF/, "");
      cb(null, JSON.parse(text));
    } catch (e) {
      cb(new Error("Bad JSON from 511"));
    }
  };
  xhr.onerror = function () { cb(new Error("Network error")); };
  xhr.ontimeout = function () { cb(new Error("511 timeout")); };
  xhr.send();
}

/* ------------------------------------------------------------- stop cache */

function loadStopCache(agency) {
  try {
    var raw = localStorage.getItem(STOP_CACHE_PREFIX + agency);
    if (!raw) return null;
    var entry = JSON.parse(raw);
    if (Date.now() - entry.ts > STOP_CACHE_TTL_MS) return null;
    return entry.stops; // [[code, name, lat, lon], ...]
  } catch (e) {
    return null;
  }
}

function saveStopCache(agency, stops) {
  try {
    localStorage.setItem(
      STOP_CACHE_PREFIX + agency,
      JSON.stringify({ ts: Date.now(), stops: stops })
    );
  } catch (e) {
    // Quota exceeded — drop oldest caches and carry on uncached.
    console.log("511: stop cache save failed for " + agency + ": " + e.message);
  }
}

/**
 * Parse the 511 stops response (SIRI/NeTEx envelope) into compact tuples.
 * Structure: Contents.dataObjects.ScheduledStopPoint[] with
 *   { id, Name, Location: { Latitude, Longitude } }
 * Coded defensively — if 511 tweaks the envelope, fix it here only.
 */
function parseStops(data) {
  var points =
    data &&
    data.Contents &&
    data.Contents.dataObjects &&
    data.Contents.dataObjects.ScheduledStopPoint;
  if (!points) return [];
  if (!Array.isArray(points)) points = [points];
  var out = [];
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    var loc = p.Location || {};
    var lat = parseFloat(loc.Latitude);
    var lon = parseFloat(loc.Longitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    out.push([String(p.id), String(p.Name || p.id), lat, lon]);
  }
  return out;
}

function fetchStops(agency, apiKey, cb) {
  var cached = loadStopCache(agency);
  if (cached) return cb(null, cached);
  var url = BASE + "/stops?api_key=" + encodeURIComponent(apiKey) +
    "&operator_id=" + encodeURIComponent(agency) + "&format=json";
  getJSON(url, function (err, data) {
    if (err) return cb(err);
    var stops = parseStops(data);
    if (stops.length) saveStopCache(agency, stops);
    cb(null, stops);
  });
}

/* --------------------------------------------------------------- geometry */

function haversineMeters(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad;
  var dLon = (lon2 - lon1) * toRad;
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ------------------------------------------------------------ public API */

// Absolute safety ceiling regardless of settings.maxStops — keeps the watch
// list and the AppMessage payload bounded even in the densest area.
var HARD_STOP_CEILING = 14;

/**
 * settings.maxStops is a typical/floor count, not a hard cutoff: once that
 * many stops are found, keep extending the list while consecutive stops
 * stay close together (a dense cluster, e.g. a busy downtown intersection
 * with many lines), so we don't lop off part of a cluster at an arbitrary
 * index. A widening gap between consecutive stops marks the cluster's edge.
 * Bounded by HARD_STOP_CEILING either way.
 */
function selectNearbyStops(results, maxStops) {
  var floor = Math.max(1, maxStops);
  if (results.length <= floor) return results.slice(0, HARD_STOP_CEILING);
  var count = floor;
  while (count < HARD_STOP_CEILING && count < results.length) {
    var cur = results[count - 1].dist;
    var next = results[count].dist;
    if (next > cur * 1.4 + 50) break; // gap: edge of the cluster
    count++;
  }
  return results.slice(0, count);
}

/**
 * Find stops near (lat, lon) across all enabled agencies.
 * settings: { apiKey, agencies: ["SF", ...], radiusM, maxStops }
 * cb(err, stops) where stops = [{ agency, code, name, dist }] sorted by dist.
 *
 * Agencies are fetched sequentially so a cold cache doesn't burst the rate
 * limit; warm caches make this loop instant and network-free.
 */
function findNearbyStops(lat, lon, settings, cb) {
  var agencies = settings.agencies.slice();
  var results = [];
  var errors = [];

  (function next() {
    if (!agencies.length) {
      if (!results.length && errors.length) return cb(new Error(errors[0]));
      results.sort(function (a, b) { return a.dist - b.dist; });
      var selected = selectNearbyStops(results, settings.maxStops);
      // Extending past the usual ~8-stop payload budget: compact names
      // further rather than raising the per-stop byte cost unbounded.
      if (selected.length > 8) {
        selected = selected.map(function (s) {
          return { agency: s.agency, code: s.code, name: s.name.slice(0, 16), dist: s.dist };
        });
      }
      return cb(null, selected);
    }
    var agency = agencies.shift();
    fetchStops(agency, settings.apiKey, function (err, stops) {
      if (err) {
        errors.push(agency + ": " + err.message);
        return next();
      }
      for (var i = 0; i < stops.length; i++) {
        var s = stops[i];
        var d = haversineMeters(lat, lon, s[2], s[3]);
        if (d <= settings.radiusM) {
          results.push({
            agency: agency,
            code: s[0],
            // Truncate: watch AppMessage payloads must stay small.
            name: s[1].slice(0, 28),
            dist: Math.round(d)
          });
        }
      }
      next();
    });
  })();
}

/* --------------------------------------------------------- favorite status */

// The watch dims favorites that are too far away or have nothing arriving.
// Distance comes free from the cached stop lists; "has arrivals" costs one
// StopMonitoring request per favorite, so it is (a) skipped beyond
// ARRIVAL_CHECK_MAX_M — those are dimmed for distance alone — and (b)
// cached for a few minutes so repeated nearby refreshes stay inside the
// 60 requests/hour budget.
var ARRIVAL_CHECK_MAX_M = 19312; // 12 miles — keep in sync with FAR_METERS in src/embeddedjs/main.js
var ARR_CACHE_TTL_MS = 3 * 60 * 1000;
var arrivalCache = {}; // "AGENCY:code" -> { ts, hasArr }

/**
 * Distance and service status for the watch's favorite stops.
 * favs: [{ agency, code }] (≤ 10 — the watch caps favorites)
 * cb(null, [{ agency, code, dist, hasArr? }]) — dist in meters, -1 when the
 * stop can't be found; hasArr only present when it was actually checked.
 * Never fails as a whole: unresolvable favorites just come back dist -1.
 */
function getFavoriteStatus(favs, lat, lon, settings, cb) {
  // Group by agency so each stop list is loaded (and its cache JSON-parsed)
  // once, not per favorite.
  var byAgency = {};
  for (var i = 0; i < favs.length; i++) {
    (byAgency[favs[i].agency] = byAgency[favs[i].agency] || []).push(favs[i].code);
  }
  var agencies = Object.keys(byAgency);
  var entries = [];

  (function nextAgency() {
    if (!agencies.length) return checkArrivals();
    var agency = agencies.shift();
    fetchStops(agency, settings.apiKey, function (err, stops) {
      var codes = byAgency[agency];
      for (var i = 0; i < codes.length; i++) {
        var dist = -1;
        if (!err) {
          for (var j = 0; j < stops.length; j++) {
            if (stops[j][0] === codes[i]) {
              dist = Math.round(haversineMeters(lat, lon, stops[j][2], stops[j][3]));
              break;
            }
          }
        }
        entries.push({ agency: agency, code: codes[i], dist: dist });
      }
      nextAgency();
    });
  })();

  // Arrivals checks run in parallel: each is one small StopMonitoring
  // response, and the watch's 15 s request timeout can't absorb up to ten
  // of them back-to-back.
  function checkArrivals() {
    var pending = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.dist < 0 || entry.dist > ARRIVAL_CHECK_MAX_M) continue;
      var cached = arrivalCache[entry.agency + ":" + entry.code];
      if (cached && Date.now() - cached.ts < ARR_CACHE_TTL_MS) {
        entry.hasArr = cached.hasArr;
      } else {
        pending.push(entry);
      }
    }
    if (!pending.length) return cb(null, entries);
    var remaining = pending.length;
    pending.forEach(function (entry) {
      getArrivals(entry.agency, entry.code, settings.apiKey, function (aErr, arrivals) {
        if (!aErr) {
          entry.hasArr = arrivals.length > 0;
          arrivalCache[entry.agency + ":" + entry.code] = {
            ts: Date.now(),
            hasArr: entry.hasArr
          };
        }
        if (--remaining === 0) cb(null, entries);
      });
    });
  }
}

/**
 * Live arrivals for one stop via SIRI StopMonitoring.
 * cb(err, arrivals) where arrivals = [{ line, dest, min }] soonest first.
 */
function getArrivals(agency, stopCode, apiKey, cb) {
  var url = BASE + "/StopMonitoring?api_key=" + encodeURIComponent(apiKey) +
    "&agency=" + encodeURIComponent(agency) +
    "&stopcode=" + encodeURIComponent(stopCode) + "&format=json";
  getJSON(url, function (err, data) {
    if (err) return cb(err);
    var visits;
    try {
      var delivery = data.ServiceDelivery.StopMonitoringDelivery;
      // Some responses wrap deliveries in an array.
      if (Array.isArray(delivery)) delivery = delivery[0];
      visits = delivery.MonitoredStopVisit || [];
    } catch (e) {
      return cb(new Error("Unexpected 511 response"));
    }
    if (!Array.isArray(visits)) visits = [visits];

    var now = Date.now();
    var arrivals = [];
    for (var i = 0; i < visits.length && arrivals.length < 6; i++) {
      var mvj = visits[i] && visits[i].MonitoredVehicleJourney;
      if (!mvj) continue;
      var call = mvj.MonitoredCall || {};
      var when = call.ExpectedArrivalTime || call.ExpectedDepartureTime ||
        call.AimedArrivalTime || call.AimedDepartureTime;
      if (!when) continue;
      var ms = Date.parse(when) - now;
      if (ms < -60000) continue; // already gone
      arrivals.push({
        line: String(mvj.LineRef || mvj.PublishedLineName || "?").slice(0, 10),
        dest: String(
          (Array.isArray(mvj.DestinationName)
            ? mvj.DestinationName[0]
            : mvj.DestinationName) || ""
        ).slice(0, 24),
        min: Math.max(0, Math.round(ms / 60000))
      });
    }
    arrivals.sort(function (a, b) { return a.min - b.min; });
    cb(null, arrivals);
  });
}

module.exports = {
  findNearbyStops: findNearbyStops,
  getArrivals: getArrivals,
  getFavoriteStatus: getFavoriteStatus
};
