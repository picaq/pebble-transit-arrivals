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
 *     in phone localStorage so nearby searches cost 0 requests once warm;
 *     only StopMonitoring hits the network per refresh. Past the 7-day TTL
 *     the cached list is still served immediately and re-downloaded in the
 *     background (stops change ~quarterly; never block the watch on one).
 *   - Stop lists are big (Muni ≈ 3,500 stops). They are compacted to
 *     [code, name, lat, lon] tuples before caching and are NEVER sent to
 *     the watch — only the top-N nearest stops go over AppMessage.
 *
 * This module is provider-agnostic at its boundary: index.js only calls
 * findNearbyStops(), getArrivals(), getFavoriteStatus() and getStopInfo().
 * To support a non-511 region, write a sibling module with the same four
 * functions and switch on a setting.
 */

/* eslint-env browser */
/* global localStorage, XMLHttpRequest */

var BASE = "https://api.511.org/transit";
// The key is versioned because the SHAPE of a stop code has changed twice:
// v1 held BART platform ids, v2 briefly held bare station ids, and v3 holds
// station-direction codes ("901809-N", see SPLIT_BY_DIRECTION). Serving an old
// generation would hand the watch codes that no longer resolve, so the bump is
// mandatory whenever a code's shape changes. index.js sweeps the dead keys.
var STOP_CACHE_PREFIX = "stops511.v3.";
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
    return {
      stops: entry.stops,          // [[code, name, lat, lon], ...]
      alias: entry.alias || {},    // old platform code -> station code
      stale: Date.now() - entry.ts > STOP_CACHE_TTL_MS
    };
  } catch (e) {
    return null;
  }
}

function saveStopCache(agency, stops, alias) {
  try {
    localStorage.setItem(
      STOP_CACHE_PREFIX + agency,
      JSON.stringify({ ts: Date.now(), stops: stops, alias: alias || {} })
    );
  } catch (e) {
    // Quota exceeded — drop oldest caches and carry on uncached.
    console.log("511: stop cache save failed for " + agency + ": " + e.message);
  }
}

/*
 * Agencies addressed per PLATFORM but RIDDEN per direction: one stop per
 * (station, direction) — "Balboa Park · N" and "Balboa Park · S".
 *
 * BART gives every platform its own stop id, and those ids are neither one
 * station nor one direction (sampled live 2026-07-14):
 *
 *   - 12th Street has THREE ids and Balboa Park two, all sharing one name —
 *     so a platform-per-row list showed the same station two or three times
 *     over with nothing to choose between.
 *   - Platforms are not directions either: 12th Street and Daly City each have
 *     two NORTHBOUND platforms (different line groups), so even a direction
 *     token would not separate those rows.
 *   - And at 12 of the 50 stations (Bay Fair, Coliseum, …) a single platform
 *     serves BOTH directions.
 *
 * But 38 of the 50 stations DO have direction-specific platforms, so
 * collapsing every station to a single undirected row — which this code did
 * briefly — throws away the one distinction a rider actually rides on.
 *
 * Direction is the right axis, and the parent station is the right way to
 * query it. Every platform carries Extensions.ParentStation, and 511 accepts
 * that parent id as a StopMonitoring stopcode in its own right: code 901809
 * (Balboa Park) returns all 43 upcoming trains across both directions, each
 * tagged with DirectionRef. Querying a single PLATFORM would not do — 12th
 * Street's two northbound platforms serve different lines, so one platform's
 * feed is only *some* of the northbound trains. So: query the parent, filter
 * by DirectionRef (getArrivals), and let each station stand as two stops.
 *
 * A terminus has no departures one way, so that direction's row simply comes
 * back with nothing arriving and dims — which is true.
 *
 * BART ONLY, deliberately. Muni publishes no ParentStation at all (its two
 * sides of a street are genuinely different places to stand). Caltrain's is a
 * slug ("22nd_street") that is not a stopcode, and its children are already
 * exactly the two directional platforms — its stop NAMES say so ("… Station
 * Northbound"), so it needs no help.
 */
var SPLIT_BY_DIRECTION = { BA: 1 };
var STATION_DIRS = ["N", "S"];
// Joins a station id to a direction in a synthetic stop code ("901809-N").
// Station ids are numeric, so this can never be mistaken for part of one.
// getArrivals splits it back off before it goes anywhere near the API.
var DIR_CODE_SEP = "-";

function splitDirCode(agency, stopCode) {
  if (!SPLIT_BY_DIRECTION[agency]) return null;
  var i = String(stopCode).lastIndexOf(DIR_CODE_SEP);
  if (i <= 0) return null;
  return { stop: stopCode.slice(0, i), dir: stopCode.slice(i + 1) };
}

// The station's name when its platforms disagree: whichever name most
// platforms use, shortest as the tie-break. BART's only disagreement is
// Coliseum — two platforms say "Coliseum", the airport-shuttle one says
// "Coliseum - OAC" — and the station is Coliseum.
function pickName(names) {
  var best = null;
  var bestN = -1;
  for (var k in names) {
    if (names[k] > bestN || (names[k] === bestN && k.length < best.length)) {
      best = k;
      bestN = names[k];
    }
  }
  return best;
}

/**
 * Parse the 511 stops response (SIRI/NeTEx envelope) into compact tuples.
 * Structure: Contents.dataObjects.ScheduledStopPoint[] with
 *   { id, Name, Location: { Latitude, Longitude }, Extensions: { ParentStation } }
 * Coded defensively — if 511 tweaks the envelope, fix it here only.
 *
 * Returns { stops: [[code, name, lat, lon], ...], alias: { platformId: station } }.
 * `alias` is non-empty only for a SPLIT_BY_DIRECTION agency: it maps each
 * platform id onto the STATION (not the final stop code — the direction has to
 * come from live data), so favorites saved against the old per-platform codes
 * can be migrated instead of going dead, and so getStopInfo can fold each
 * platform's visits onto the station-direction they belong to.
 *
 * For a split agency each station yields one stop PER DIRECTION
 * ("901809-N", "901809-S"), all sharing the station's name and centroid.
 * For every other agency each stop is its own group, so this reduces to the
 * flat tuple list it always was.
 */
function parseStops(data, agency) {
  var points =
    data &&
    data.Contents &&
    data.Contents.dataObjects &&
    data.Contents.dataObjects.ScheduledStopPoint;
  if (!points) return { stops: [], alias: {} };
  if (!Array.isArray(points)) points = [points];

  var split = !!SPLIT_BY_DIRECTION[agency];
  var groups = {};
  var order = [];
  var alias = {};

  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    var loc = p.Location || {};
    var lat = parseFloat(loc.Latitude);
    var lon = parseFloat(loc.Longitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    var code = String(p.id);
    var parent = (p.Extensions || {}).ParentStation;
    var key = split && parent ? String(parent) : code;
    if (key !== code) alias[code] = key;
    var g = groups[key];
    if (!g) {
      g = groups[key] = { names: {}, lat: 0, lon: 0, n: 0 };
      order.push(key);
    }
    var name = String(p.Name || p.id);
    g.names[name] = (g.names[name] || 0) + 1;
    // A station sits at the centroid of its platforms — they are metres apart,
    // so this is exact enough for a walking distance and never lands off-site.
    g.lat += lat;
    g.lon += lon;
    g.n++;
  }

  var out = [];
  for (var j = 0; j < order.length; j++) {
    var gr = groups[order[j]];
    var nm = pickName(gr.names);
    var la = gr.lat / gr.n;
    var lo = gr.lon / gr.n;
    if (split) {
      // One stop per direction. Both are real places to stand and both are
      // separately favoritable; the one a terminus doesn't serve just comes
      // back with nothing arriving.
      for (var d = 0; d < STATION_DIRS.length; d++) {
        out.push([order[j] + DIR_CODE_SEP + STATION_DIRS[d], nm, la, lo]);
      }
    } else {
      out.push([order[j], nm, la, lo]);
    }
  }
  return { stops: out, alias: alias };
}

// One background revalidation per agency at a time — concurrent nearby
// searches and favorite lookups all funnel through fetchStops, and a
// stampede of duplicate multi-MB stop-list downloads would burn the
// 60 req/hr budget for nothing.
var stopRefreshing = {}; // agency -> 1 while a background download runs

function downloadStops(agency, apiKey, cb) {
  var url = BASE + "/stops?api_key=" + encodeURIComponent(apiKey) +
    "&operator_id=" + encodeURIComponent(agency) + "&format=json";
  getJSON(url, function (err, data) {
    if (err) return cb(err);
    var parsed = parseStops(data, agency);
    if (parsed.stops.length) saveStopCache(agency, parsed.stops, parsed.alias);
    cb(null, parsed.stops, parsed.alias);
  });
}

// cb(err, stops, alias) — alias maps a retired per-platform code onto the
// station that replaced it (empty for every agency but BART; see parseStops).
function fetchStops(agency, apiKey, cb) {
  var cached = loadStopCache(agency);
  if (cached) {
    // Serve even an expired list immediately: stops change on the
    // timescale of quarterly service changes, so days-stale is fine and
    // the weekly re-download must never block the watch's request. The
    // refresh runs off the critical path; a failure just leaves the
    // stale cache in place for the next attempt.
    if (cached.stale && !stopRefreshing[agency]) {
      stopRefreshing[agency] = 1;
      downloadStops(agency, apiKey, function (err) {
        delete stopRefreshing[agency];
        console.log("511: background stop refresh " + agency +
          (err ? " failed: " + err.message : " ok"));
      });
    }
    return cb(null, cached.stops, cached.alias);
  }
  downloadStops(agency, apiKey, cb); // cold cache: nothing to serve, block
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

// Rail agencies that reach farther up the list: BART and Caltrain stations
// are sparse and a train is worth walking farther for, so settings.railRadiusX
// scales them two ways — their eligibility radius (the nearby search radius,
// and the favorites hide line in getFavoriteStatus) is MULTIPLIED by it, and
// the distance they are RANKED by is divided by it. At 5× a station 3 km out
// sorts among the 600 m bus stops. Only reach and rank scale: the `dist` field
// every caller displays stays the true distance. Rail knowledge lives here and
// nowhere else — callers just sort by `eff` (see findNearbyStops).
// BA = BART, CT = Caltrain.
var RAIL_AGENCIES = { BA: 1, CT: 1 };

// Reach/rank multiplier for an agency; 1 for ordinary stops (no scaling).
function railScale(agency, settings) {
  if (!RAIL_AGENCIES[agency]) return 1;
  var x = Number(settings.railRadiusX) || 1;
  return x > 1 ? x : 1;
}

/**
 * settings.maxStops is a typical/floor count, not a hard cutoff: once that
 * many stops are found, keep extending the list while consecutive stops
 * stay close together (a dense cluster, e.g. a busy downtown intersection
 * with many lines), so we don't lop off part of a cluster at an arbitrary
 * index. A widening gap between consecutive stops marks the cluster's edge.
 * Bounded by HARD_STOP_CEILING either way.
 *
 * Gaps are measured in EFFECTIVE distance (results are ranked by it), so a
 * scaled-in rail station reads as part of whatever cluster it lands in
 * rather than as an artificial cliff.
 */
function selectNearbyStops(results, maxStops, ceiling) {
  ceiling = ceiling || HARD_STOP_CEILING;
  var floor = Math.max(1, maxStops);
  if (results.length <= floor) return results.slice(0, ceiling);
  var count = floor;
  while (count < ceiling && count < results.length) {
    var cur = results[count - 1].eff;
    var next = results[count].eff;
    if (next > cur * 1.4 + 50) break; // gap: edge of the cluster
    count++;
  }
  return results.slice(0, count);
}

/**
 * Find stops near (lat, lon) across all enabled agencies.
 * settings: { apiKey, agencies: ["SF", ...], radiusM, maxStops, railRadiusX }
 * cb(err, stops) where stops = [{ agency, code, name, dist, eff }] sorted by
 * `eff`, the effective (rank) distance: `dist` divided by the agency's
 * railScale, so BART/Caltrain stations interleave with the bus stops they
 * are worth as much as. `dist` is the real distance — display that.
 * BART/Caltrain are also searched out to radiusM × railRadiusX, so the far
 * station is in the candidate set in the first place.
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
      // Rank by effective distance: rail scaled in, everything else as-is.
      results.sort(function (a, b) { return a.eff - b.eff; });
      // hardCeiling override lets "load more" pagination reach past the
      // default 14-candidate ceiling (index.js buildMoreRows).
      var selected = selectNearbyStops(results, settings.maxStops, settings.hardCeiling);
      // Display-name compression (street-type abbreviation + the ≤20-char
      // LIST_NAME_MAX cut) happens in index.js compressStopName(), on top
      // of the 28-char payload cap applied at collection time above.
      return cb(null, selected);
    }
    var agency = agencies.shift();
    fetchStops(agency, settings.apiKey, function (err, stops) {
      if (err) {
        errors.push(agency + ": " + err.message);
        return next();
      }
      // Rail reaches railRadiusX times farther and ranks railRadiusX times
      // nearer; ordinary agencies get mult = 1 and behave exactly as before.
      var mult = railScale(agency, settings);
      var radius = settings.radiusM * mult;
      for (var i = 0; i < stops.length; i++) {
        var s = stops[i];
        var d = haversineMeters(lat, lon, s[2], s[3]);
        if (d <= radius) {
          results.push({
            agency: agency,
            code: s[0],
            // The RAW name, only sanity-bounded. It used to be cut to 28
            // chars here, which silently amputated the one thing that tells
            // two Caltrain platforms apart: "Bayshore Caltrain Station
            // Northbound" (35 chars) arrived as "Bayshore Caltrain Station No"
            // and came out of the display pipeline as "Bayshore Caltrain St",
            // identical to its southbound twin. The wire cap is index.js's
            // stopLabel (LIST_NAME_MAX), which is tighter than this and runs
            // on every row — so this bound only guards memory, never meaning.
            name: s[1].slice(0, 64),
            dist: Math.round(d),
            eff: Math.round(d / mult)
          });
        }
      }
      next();
    });
  })();
}

/* --------------------------------------------------------- favorite status */

/* ------------------------------------------------------- BART line names */

// BART (BA) names its lines by color: LineRef is "Green", "Yellow", "Red",
// "Orange", "Blue" (plus "Beige" for the Coliseum–OAK shuttle, left as-is).
// The initial letter compresses list-subtitle tokens ("Y,R,B,G") and keys
// the matching display color; the arrivals screen keeps the full name.
function bartLineLetter(line) {
  var m = /^(green|yellow|red|orange|blue)/i.exec(line);
  return m ? m[1].charAt(0).toUpperCase() : null;
}

/**
 * The compact token for a line, per agency's idea of what a "line" is.
 *
 * Muni and the bus operators publish a route number that is already short
 * ("14R", "38R"), so a 4-char cut is harmless. BART publishes a colour and
 * takes its initial (above). Caltrain publishes neither: its LineRef is a
 * SERVICE PATTERN — "Local Weekday" — and cutting that to 4 chars produced the
 * meaningless "Loca" in every Caltrain subtitle. Local vs Limited vs Bullet is
 * the thing a Caltrain rider actually chooses between, so keep exactly that.
 */
function lineToken(agency, line) {
  var s = String(line || "");
  if (agency === "BA") return (bartLineLetter(s) || s).slice(0, 4);
  if (agency === "CT") {
    if (/bullet/i.test(s)) return "Bullet";
    if (/limited/i.test(s)) return "Ltd";
    if (/local/i.test(s)) return "Local";
    return s.slice(0, 6);
  }
  return s.slice(0, 4);
}

/* ------------------------------------------------------ agency stop info */

// One agency-wide StopMonitoring call (no stopcode) answers, for every stop
// with upcoming service: which lines serve it, in which direction(s), and —
// by mere presence in the map — that something is arriving. This single call
// powers the list subtitles AND the favorites' has-arrivals check.
//
// It is the fattest endpoint in the API (Muni is tens of thousands of visits,
// multiple MB), and it is the dominant cost of a cold app launch: pkjs is torn
// down when the watchapp closes, so an in-memory-only cache is empty on every
// relaunch and every launch re-downloaded one of these PER agency, with the
// rows response blocked on all of them (index.js withInfo). So the map is now
// PERSISTED and served stale-while-revalidate, exactly like the stop lists:
//
//   fresh   (< TTL)  serve from cache, no network.
//   stale   (≥ TTL)  serve the cached map IMMEDIATELY, refresh in background.
//   absent           download and block (first-ever launch for the agency).
//
// Serving a stale map is safe here in a way it would not be for arrivals: the
// lines and directions it carries change on the timescale of service changes,
// and its only time-sensitive use — the "no arrivals" dimming — merely GRAYS a
// row, never hides it. A stop wrongly dimmed by a few-hour-old map is still
// shown and still tappable, and the background refresh corrects it. The
// alternative (blocking a launch on multiple MB per agency) is far worse.
var STOP_INFO_TTL_MS = 10 * 60 * 1000;
// Persisted per agency. Versioned on the SHAPE of a stop code, like the stop
// cache (STOP_CACHE_PREFIX) — the map is keyed by stop code (station-direction
// for a split agency), so a code-shape change must invalidate it. Bump both
// together.
var STOP_INFO_PREFIX = "stopinfo.v3.";
var stopInfoCache = {};      // agency -> { ts, map } — in-memory hot copy
var stopInfoRefreshing = {}; // agency -> 1 while a download runs
var stopInfoWaiters = {};    // agency -> [cb] sharing that one in-flight download

function loadStopInfoDisk(agency) {
  try {
    var raw = localStorage.getItem(STOP_INFO_PREFIX + agency);
    return raw ? JSON.parse(raw) : null; // { ts, map }
  } catch (e) {
    return null;
  }
}

function saveStopInfoDisk(agency, entry) {
  try {
    localStorage.setItem(STOP_INFO_PREFIX + agency, JSON.stringify(entry));
  } catch (e) {
    // Quota — carry on; a failed persist just costs a re-download next launch,
    // which is exactly the old behavior. Never corrupts the stop lists (their
    // own keys are already written).
    console.log("511: stop-info save failed for " + agency + ": " + e.message);
  }
}

// Build the stop-info map from one agency-wide StopMonitoring response.
// The feed reports each visit against the PLATFORM it calls at, so for a split
// agency its MonitoringRefs are codes our stop list no longer has. Fold each
// onto the (station, direction) it serves, through the same alias map that
// built the list — otherwise every BART stop is absent from the map, reads as
// "nothing is arriving", and every station dims with its lines stripped.
// Platform codes are ALSO kept as their own keys, which is how buildRows learns
// the direction of a favorite saved against a retired platform id.
function buildStopInfoMap(agency, data, alias) {
  var visits;
  try {
    var delivery = data.ServiceDelivery.StopMonitoringDelivery;
    if (Array.isArray(delivery)) delivery = delivery[0];
    visits = delivery.MonitoredStopVisit || [];
  } catch (e) {
    return null;
  }
  if (!Array.isArray(visits)) visits = [visits];
  var map = {};
  for (var i = 0; i < visits.length; i++) {
    var v = visits[i];
    var mvj = v && v.MonitoredVehicleJourney;
    if (!mvj) continue;
    var ref = String(v.MonitoringRef ||
      (mvj.MonitoredCall && mvj.MonitoredCall.StopPointRef) || "");
    if (!ref) continue;
    var dir = String(mvj.DirectionRef || "");
    var line = lineToken(agency, mvj.LineRef);
    var code = ref;
    if (SPLIT_BY_DIRECTION[agency]) {
      var base = (alias && alias[ref]) || ref;
      code = dir ? base + DIR_CODE_SEP + dir : base;
      var pe = map[ref] || (map[ref] = { dirs: [], lines: [] });
      if (dir && pe.dirs.indexOf(dir) < 0) pe.dirs.push(dir);
      if (line && pe.lines.indexOf(line) < 0) pe.lines.push(line);
    }
    var e = map[code] || (map[code] = { dirs: [], lines: [] });
    if (dir && e.dirs.indexOf(dir) < 0) e.dirs.push(dir);
    if (line && e.lines.indexOf(line) < 0) e.lines.push(line);
  }
  return map;
}

// Download and rebuild the map, updating both caches. Concurrent callers share
// one download (stopInfoWaiters) — the fan-out in buildRows and the favorites'
// has-arrivals check would otherwise fire the same agency's multi-MB feed more
// than once. cb may be omitted for a fire-and-forget background refresh.
function downloadStopInfo(agency, apiKey, cb) {
  if (stopInfoRefreshing[agency]) {
    if (cb) (stopInfoWaiters[agency] = stopInfoWaiters[agency] || []).push(cb);
    return;
  }
  stopInfoRefreshing[agency] = 1;
  fetchStops(agency, apiKey, function (sErr, stops, alias) {
    var url = BASE + "/StopMonitoring?api_key=" + encodeURIComponent(apiKey) +
      "&agency=" + encodeURIComponent(agency) + "&format=json";
    getJSON(url, function (err, data) {
      var waiters = stopInfoWaiters[agency] || [];
      delete stopInfoWaiters[agency];
      delete stopInfoRefreshing[agency];
      var done = function (e, map) {
        if (cb) cb(e, map);
        for (var i = 0; i < waiters.length; i++) waiters[i](e, map);
      };
      if (err) return done(err);
      var map = buildStopInfoMap(agency, data, alias);
      if (!map) return done(new Error("Unexpected 511 response"));
      var entry = { ts: Date.now(), map: map };
      stopInfoCache[agency] = entry;
      saveStopInfoDisk(agency, entry);
      console.log("stop info " + agency + ": " +
        Object.keys(map).length + " stops");
      done(null, map);
    });
  });
}

function getStopInfo(agency, apiKey, cb) {
  var now = Date.now();
  var entry = stopInfoCache[agency];
  // Fall back to the persisted copy on a cold pkjs (the whole point): a launch
  // finds yesterday's map on disk and serves it at once instead of downloading.
  if (!entry) {
    var disk = loadStopInfoDisk(agency);
    if (disk && disk.map) stopInfoCache[agency] = entry = disk;
  }
  if (entry) {
    // Stale-while-revalidate: serve whatever we have, refresh behind it if the
    // fresh window has passed. (See the block comment above for why serving a
    // stale map is safe.)
    if (now - entry.ts >= STOP_INFO_TTL_MS && !stopInfoRefreshing[agency]) {
      downloadStopInfo(agency, apiKey); // fire-and-forget
    }
    return cb(null, entry.map);
  }
  downloadStopInfo(agency, apiKey, cb); // absent: block on the first download
}

/**
 * Distance, name, and service status for the favorite stops.
 * favs: [{ agency, code, name }] (≤ 10)
 * maxCheckM: the base hide line — favorites farther than it come back with
 * far:1 (the caller drops those from the list) and skip the arrival check.
 * RAIL_AGENCIES favorites use maxCheckM × settings.railRadiusX instead
 * (railScale), the same reach the nearby search gives them.
 * cb(null, [{ agency, code, canon?, dist, eff, name?, far?, hasArr? }]) — dist
 * in meters, -1 when the stop can't be found (never far:1 — an unresolved
 * favorite still shows, with its saved name); eff is the rank distance
 * (dist ÷ railScale, -1 alongside an unknown dist) that the caller orders
 * the favorites block by; name comes from the cached stop list (absent on a
 * cache/API miss); hasArr only present when it was actually checked.
 * Never fails as a whole: unresolvable favorites just come back dist -1.
 *
 * `code` is echoed back exactly as passed in, so the caller can match the
 * entry to the favorite it stored. `canon` appears only when that stored code
 * has been RETIRED and the stop now lives under another one — a BART favorite
 * saved against a platform id before stations were collapsed (see parseStops).
 * Everything here is already resolved against the canonical stop; the caller
 * should rewrite the code it has saved, or the favorite dies at the next
 * arrivals fetch.
 */
function getFavoriteStatus(favs, lat, lon, settings, maxCheckM, cb) {
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
    fetchStops(agency, settings.apiKey, function (err, stops, alias) {
      var codes = byAgency[agency];
      var mult = railScale(agency, settings);
      for (var i = 0; i < codes.length; i++) {
        var dist = -1;
        var name;
        var code = codes[i];
        // A favorite may be saved against a code we have since retired: a BART
        // PLATFORM id (901801), or a bare STATION id from the brief spell when
        // stations were undirected (901809). Both now live under a
        // station-direction code (901809-N / -S). Resolve the station here; the
        // caller picks the direction, which only live data knows (buildRows).
        var base = (alias && alias[code]) || code;
        var canonBase = null;
        if (!err) {
          for (var j = 0; j < stops.length; j++) {
            if (stops[j][0] === code) {          // still a real stop
              dist = Math.round(haversineMeters(lat, lon, stops[j][2], stops[j][3]));
              name = stops[j][1].slice(0, 64);   // raw — see findNearbyStops
              break;
            }
            // Every direction of a station shares its name and centroid, so
            // any of them answers "where is this station, and what is it
            // called" for a code that has lost its direction.
            if (!canonBase &&
                stops[j][0].indexOf(base + DIR_CODE_SEP) === 0) {
              dist = Math.round(haversineMeters(lat, lon, stops[j][2], stops[j][3]));
              name = stops[j][1].slice(0, 64);
              canonBase = base;
            }
          }
        }
        var entry = {
          agency: agency,
          code: code, // as stored, so the caller can match its record
          dist: dist,
          eff: dist >= 0 ? Math.round(dist / mult) : -1,
          name: name
        };
        if (canonBase) entry.canonBase = canonBase;
        if (dist >= 0 && dist > maxCheckM * mult) entry.far = 1;
        entries.push(entry);
      }
      nextAgency();
    });
  })();

  // has-arrivals now comes from the cached agency-wide stop-info map:
  // presence in the map = something is coming. One cached call per agency
  // instead of one StopMonitoring call per favorite.
  function checkArrivals() {
    var checkAgencies = {};
    entries.forEach(function (entry) {
      if (entry.dist >= 0 && !entry.far) checkAgencies[entry.agency] = 1;
    });
    var list = Object.keys(checkAgencies);
    var remaining = list.length;
    if (!remaining) return cb(null, entries);
    // Fire every agency's stop-info call at once rather than serially — the
    // sequential version put one network round-trip per agency on the nearby
    // critical path (the main field-latency source; see index.js withInfo).
    // Each call is cached 10 min (getStopInfo), so warm agencies return
    // immediately and the whole fan-out costs ~one round-trip.
    list.forEach(function (agency) {
      getStopInfo(agency, settings.apiKey, function (err, map) {
        if (!err) {
          entries.forEach(function (entry) {
            if (entry.agency === agency && entry.dist >= 0 && !entry.far) {
              var has = !!map[entry.code];
              // A favorite still on a retired code has no entry of its own —
              // any direction of the station it belongs to answers for it,
              // until buildRows rewrites the record.
              if (!has && entry.canonBase) {
                for (var d = 0; d < STATION_DIRS.length; d++) {
                  if (map[entry.canonBase + DIR_CODE_SEP + STATION_DIRS[d]]) {
                    has = true;
                    break;
                  }
                }
              }
              entry.hasArr = has;
            }
          });
        }
        if (--remaining === 0) cb(null, entries);
      });
    });
  }
}

/**
 * Live arrivals for one stop via SIRI StopMonitoring.
 * cb(err, arrivals) where arrivals = [{ line, dest, min }] soonest first.
 *
 * Cached for ARRIVALS_TTL_MS: the watch's manual refresh (Up/Down) and 60 s
 * auto-refresh can fire far faster than the 60 req/hour budget tolerates.
 * The cache stores absolute arrival times and recomputes the minutes at
 * serve time, so a cached answer still ticks down correctly.
 */
var ARRIVALS_TTL_MS = 45 * 1000;
var fullArrivalsCache = {}; // "AGENCY:code" -> { ts, list: [{line, dest, when}] }

function serveArrivals(list) {
  var now = Date.now();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var ms = list[i].when - now;
    if (ms < -60000) continue; // already gone
    var a = {
      line: list[i].line,
      dest: list[i].dest,
      min: Math.max(0, Math.round(ms / 60000))
    };
    if (list[i].k) a.k = list[i].k; // display-color code (see getArrivals)
    out.push(a);
  }
  out.sort(function (a, b) { return a.min - b.min; });
  return out;
}

// The arrivals-screen destination. 511 pads these with the same noise the stop
// names carry, and a blunt slice then amputated the part that actually names
// the place — "Berryessa / North San Jose" came through as "Berryessa / North
// San Jo", and every Caltrain destination as "… Caltrain Statio". Clean before
// cutting:
//   - Caltrain spells "<place> Caltrain Station <bound>" into every
//     destination; the screen is already one direction, so both are pure width
//     ("San Jose Diridon Caltrain Station Southbound" -> "San Jose Diridon").
//   - A trailing parenthetical is a qualifier, not the name ("Millbrae
//     (Caltrain Transfer Platform)" -> "Millbrae").
//   - Only if it is still too long, abbreviate a leading compass word so the
//     distinguishing tail survives ("Berryessa / North San Jose" ->
//     "Berryessa / N San Jose") rather than losing the end to the cut.
// The 24-char cap remains as a payload bound; the watch fits the result to the
// row and adds an ellipsis if even the cleaned name overflows.
var DEST_MAX = 24;
var DEST_CALTRAIN_RE = /\s+Caltrain Station\b/i;
var DEST_BOUND_RE = /\s+(North|South|East|West)bound\b/i;
var DEST_PAREN_RE = /\s*\([^)]*\)\s*$/;
var DEST_COMPASS_RE = /\b(North|South|East|West)\s+(?=\S)/g;
function cleanDest(agency, raw) {
  var d = String(raw || "");
  if (agency === "CT") d = d.replace(DEST_BOUND_RE, "").replace(DEST_CALTRAIN_RE, "");
  d = d.replace(DEST_PAREN_RE, "");
  if (d.length > DEST_MAX) {
    d = d.replace(DEST_COMPASS_RE, function (m, dir) { return dir.charAt(0) + " "; });
  }
  return d.slice(0, DEST_MAX);
}

// limit: how many arrivals to return (watch "load more" raises it). Bounded
// to keep the AppMessage payload under the watch's ~1 KB parse budget.
var MAX_ARRIVALS = 10;
function getArrivals(agency, stopCode, apiKey, limit, cb) {
  limit = Math.max(1, Math.min(MAX_ARRIVALS, limit || 6));
  var cacheKey = agency + ":" + stopCode;
  var cached = fullArrivalsCache[cacheKey];
  // Reuse the cache only if it holds at least as many as now requested (a
  // "load more" asks for more than the last fetch stored).
  if (cached && Date.now() - cached.ts < ARRIVALS_TTL_MS && cached.lim >= limit) {
    return cb(null, serveArrivals(cached.list));
  }

  // A split agency's stop code is (station, direction) — "901809-N". Ask 511
  // for the STATION and keep only the trains going that way. It has to be the
  // station: 12th Street's two northbound platforms serve different lines, so
  // querying one platform returns only some of the northbound trains.
  var sd = splitDirCode(agency, stopCode);
  var apiStop = sd ? sd.stop : stopCode;
  var wantDir = sd ? sd.dir : null;

  var url = BASE + "/StopMonitoring?api_key=" + encodeURIComponent(apiKey) +
    "&agency=" + encodeURIComponent(agency) +
    "&stopcode=" + encodeURIComponent(apiStop) + "&format=json";
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
    var list = [];
    for (var i = 0; i < visits.length && list.length < limit; i++) {
      var mvj = visits[i] && visits[i].MonitoredVehicleJourney;
      if (!mvj) continue;
      // Wrong way at a station we asked one direction of.
      if (wantDir && String(mvj.DirectionRef || "") !== wantDir) continue;
      var call = mvj.MonitoredCall || {};
      var when = call.ExpectedArrivalTime || call.ExpectedDepartureTime ||
        call.AimedArrivalTime || call.AimedDepartureTime;
      if (!when) continue;
      var ms = Date.parse(when) - now;
      if (ms < -60000) continue; // already gone
      // Name the train. Caltrain's LineRef is a service pattern ("Local
      // Weekday"), so it is tokenized (lineToken). BART's carries a direction
      // suffix ("Yellow-N") that is pure redundancy now the whole screen is
      // one direction — the line is "Yellow".
      var name = String(mvj.LineRef || mvj.PublishedLineName || "");
      if (agency === "CT") name = lineToken(agency, mvj.LineRef);
      else if (agency === "BA") name = name.replace(/-[NS]$/, "");
      // A train we cannot name is noise, not information: it used to render as
      // a literal "?" beside a time, which tells a rider nothing they can act
      // on. Every visit across all six agencies carries a LineRef today
      // (checked 2026-07-14), so this should never fire — but if 511 ever
      // emits one, drop it rather than showing a "?" row.
      if (!name) continue;
      var entry = {
        line: name.slice(0, 10),
        dest: cleanDest(agency, Array.isArray(mvj.DestinationName)
          ? mvj.DestinationName[0]
          : mvj.DestinationName),
        when: now + ms
      };
      if (agency === "BA") {
        // Color-named BART lines keep their full name on the arrivals screen
        // but carry a matching color code the watch maps to its palette
        // (LINE_COLOR_CODES in main.js). The one-letter compression applies
        // only to list subtitles (getStopInfo).
        var letter = bartLineLetter(entry.line);
        if (letter) entry.k = letter.toLowerCase();
      }
      list.push(entry);
    }
    fullArrivalsCache[cacheKey] = { ts: now, lim: limit, list: list };
    cb(null, serveArrivals(list));
  });
}

module.exports = {
  findNearbyStops: findNearbyStops,
  getArrivals: getArrivals,
  getFavoriteStatus: getFavoriteStatus,
  getStopInfo: getStopInfo
};
