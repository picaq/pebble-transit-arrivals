/*
 * pinned.js — the one thing this watch app stores on the watch.
 *
 * Everything else lives on the phone on purpose: watch storage costs watch
 * heap and watch code costs watch heap, and this module's compiled bytecode
 * loads into the same 32 KB XS arena as the runtime heap (playbook §B). It
 * earns its bytes by covering the one case the phone cannot: a dead phone
 * battery, or Bluetooth off, where pkjs is not merely slow but absent. In
 * that state the phone's own caches are unreachable, so a stop pinned before
 * the phone died has to be readable from here or from nowhere.
 *
 * What makes it worth so little code: arrival times are ABSOLUTE. We store
 * each due time as an epoch millisecond and main.js's existing tickArrivals()
 * derives the displayed minute from (whenMs - now) on every clock tick. The
 * countdown therefore needs no network, no phone, and no refresh — only
 * arithmetic that already exists.
 *
 * Read exactly once, at boot, when the arena is emptiest and a parse is at
 * its cheapest. Written exactly once, on the pin gesture. NEVER from draw().
 */

const KEY = "pin.v1";
// Six is what the arrivals screen can show without scrolling plus a little
// slack for ones that age out while the watch is in a drawer. Every entry is
// a string pair plus a number, so the whole blob stays near 300 B — an order
// of magnitude under the rows payload that main.js documents as needing
// 1.2–1.6 KB of free chunk to parse.
const MAX_ARRIVALS = 6;

// Short keys and positional arrays rather than named fields, for the same
// reason the wire format uses them: this string is parsed on a 32 KB arena.
//   { s: [agency, code, name, fav], t: fetchedAtMs, l: pinnedLine|0,
//     a: [[line, dest, whenMs, colorCode], …] }
export function savePin(stop, arrivals, arrivalsAt, line) {
  const a = [];
  for (let i = 0; i < arrivals.length && a.length < MAX_ARRIVALS; i++) {
    const x = arrivals[i];
    a.push(x.k ? [x.line, x.dest, x.whenMs, x.k] : [x.line, x.dest, x.whenMs]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({
      // fav rides along so a reopened screen shows the right Select hint
      // instead of offering to favorite a stop that already is one.
      s: [stop.agency, stop.code, stop.name, stop.fav ? 1 : 0],
      t: arrivalsAt,
      l: line || 0,
      a: a
    }));
  } catch (e) {
    // Nothing to do and nothing worth failing the exit over: without this
    // record the app simply opens on the nearby list next time, which is
    // where it opened before this feature existed.
  }
}

// Returns { stop, arrivals, arrivalsAt, line } shaped exactly as main.js's
// state expects, or null. Arrivals already past are NOT filtered here —
// tickArrivals() splices them on the first tick using the same threshold it
// applies to live data, so there is no second rule to keep in step.
export function loadPin() {
  let p;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    p = JSON.parse(raw);
  } catch (e) {
    return null; // corrupt or half-written: treat as no pin
  }
  if (!p || !p.s || !p.a) return null;
  const arrivals = [];
  for (const x of p.a) {
    const a = { line: x[0], dest: x[1], whenMs: x[2], min: 0 };
    if (x[3]) a.k = x[3];
    arrivals.push(a);
  }
  return {
    stop: { agency: p.s[0], code: p.s[1], name: p.s[2], fav: !!p.s[3] },
    arrivals: arrivals,
    arrivalsAt: p.t || 0,
    line: p.l || 0
  };
}

export function clearPin() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    // A failed removal just means the next boot opens on a stop you left.
  }
}
