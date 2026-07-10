/*
 * protocol.js — watch side of the watch<->phone request/response protocol.
 *
 * All network traffic (511 API calls) happens on the PHONE in src/pkjs/.
 * The watch only ever sends a small JSON request and receives a small JSON
 * response over AppMessage. This keeps watch RAM usage tiny and keeps the
 * API key off the watch entirely.
 *
 * Wire format (see also src/pkjs/index.js — the two must stay in sync):
 *   watch -> phone : { Request:  "<json string>" }
 *   phone -> watch : { Response: "<json string>" }
 *
 * Request JSON:
 *   { id, cmd: "nearby",   mig?, fresh?, x? }
 *                          // the PHONE owns favorites and takes the location
 *                          // fix itself; mig is a one-time migration payload
 *                          // (the watch's legacy favorites.v1 JSON string),
 *                          // sent until a rows response succeeds, then
 *                          // deleted. fresh=1 bypasses the phone's instant
 *                          // stale reply (the revalidation follow-up). x=N
 *                          // widens the search radius N steps ("load more").
 *   { id, cmd: "arrivals", agency, stop, lim? }  // lim = how many arrivals to
 *                          // return (watch "load more"; phone caps it)
 *   { id, cmd: "fav",      a, c, n }   // toggle favorite (agency/code/name)
 * Response JSON:
 *   { id, type: "rows",     rows: [{ a, c, n, s, f?, m? }], stale? }
 *                           // One pre-merged, pre-sorted, display-ready list:
 *                           // favorites (nearest first) then nearby stops.
 *                           // a=agency, c=code, n=name (truncated),
 *                           // s=subtitle string ("SF · 320 m · no arrivals"),
 *                           // f=1 favorite, m=1 dimmed. The watch only fits
 *                           // text to the screen — all formatting/merging
 *                           // happens on the phone to keep watch code (and
 *                           // therefore watch heap — playbook §B) small.
 *                           // stale=1 marks the instant cached list — the
 *                           // watch shows it, then sends one fresh:1 request.
 *   { id, type: "arrivals", arrivals: [{ line, dest, min, k? }] }
 *                           // k = optional display-color code for lines with
 *                           // a canonical color (BART's color-named lines
 *                           // keep their full name and send k="g".."b");
 *                           // the watch maps it to its palette
 *                           // (LINE_COLOR_CODES, main.js)
 *   { id, type: "fav",      fav: 1|0 } // state after the toggle
 *   { id, type: "error",    message }
 *
 * Keep payloads SMALL (< ~1 KB). The phone side truncates names and caps
 * list lengths for this reason. If you ever need bigger payloads, add a
 * chunking layer (seq/total fields) rather than raising the caps.
 */

import Message from "pebble/message";
import Timer from "timer";

let nextId = 1;
let writable = false;
const pending = new Map();   // id -> { resolve, reject, timer }
const queue = [];            // requests made before the channel is writable

const REQUEST_TIMEOUT_MS = 15000;

// Hard ceiling on simultaneous in-flight requests. Every pending request
// pins real memory (handlers, timer, queued payload, and eventually a ~1 KB
// response being parsed) until its round trip ends — stacking them crashed
// the watch with "memory full" when a refresh button was hammered. Callers
// should keep their own in-flight guards (see fetchArrivals in main.js);
// this cap is the backstop that makes the mistake survivable.
const MAX_PENDING = 6;

const message = new Message({
  keys: ["Request", "Response", "SettingsChanged"],
  onReadable() {
    const msg = this.read();
    const raw = msg.get("Response");
    if (raw !== undefined) {
      handleResponse(raw);
    }
    const settingsChanged = msg.get("SettingsChanged");
    if (settingsChanged !== undefined && protocol.onSettingsChanged) {
      protocol.onSettingsChanged();
    }
  },
  onWritable() {
    writable = true;
    flushQueue();
  },
  onSuspend() {
    writable = false;
  }
});

function handleResponse(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.log("protocol: bad JSON from phone: " + e.message);
    return;
  }
  const entry = pending.get(data.id);
  if (!entry) {
    // Unsolicited or late response — ignore.
    return;
  }
  pending.delete(data.id);
  if (entry.timer) Timer.clear(entry.timer);
  if (data.type === "error") {
    entry.reject(new Error(data.message || "unknown error"));
  } else {
    entry.resolve(data);
  }
}

function flushQueue() {
  while (writable && queue.length) {
    const payload = queue.shift();
    try {
      message.write(new Map([["Request", payload]]));
    } catch (e) {
      // Channel got busy again; put it back and wait for next onWritable.
      queue.unshift(payload);
      break;
    }
  }
}

function request(body) {
  if (pending.size >= MAX_PENDING) {
    return Promise.reject(new Error("busy"));
  }
  return new Promise((resolve, reject) => {
    const id = nextId++;
    body.id = id;
    const payload = JSON.stringify(body);

    const timer = Timer.set(() => {
      pending.delete(id);
      reject(new Error("timed out"));
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    queue.push(payload);
    flushQueue();
  });
}

export const protocol = {
  /** Optional hook: set to a function to be told when phone settings changed. */
  onSettingsChanged: null,

  /**
   * Ask the phone for the display-ready stop list (favorites + nearby). The
   * phone owns favorites and takes the location fix itself. mig, when given,
   * is the legacy watch-side favorites JSON string for one-time import.
   * Resolves to { rows: [...] }.
   */
  nearbyStops(mig, fresh, expand) {
    const body = { cmd: "nearby" };
    if (mig) body.mig = mig;
    if (fresh) body.fresh = 1;   // bypass the phone's instant stale reply
    if (expand) body.x = expand; // "load more": widen the search radius N steps
    return request(body);
  },

  /**
   * Ask the phone for live arrivals at one stop. limit raises how many the
   * phone returns (watch "load more"). Resolves to { arrivals: [...] }.
   */
  arrivals(agency, stopCode, limit) {
    const body = { cmd: "arrivals", agency, stop: stopCode };
    if (limit) body.lim = limit;
    return request(body);
  },

  /** Toggle a favorite on the phone. Resolves to { fav: 1|0 } (new state). */
  toggleFav(agency, code, name) {
    return request({ cmd: "fav", a: agency, c: code, n: name });
  }
};

export default protocol;
