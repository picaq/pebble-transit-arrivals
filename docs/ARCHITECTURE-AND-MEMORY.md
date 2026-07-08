# Architecture & the watch memory model

Read this to understand *why* the app is shaped the way it is — especially
why the watch side does so little. For step-by-step crash debugging, use
`docs/WATCH-DEBUGGING-PLAYBOOK.md`; this file is the background story.

**One-paragraph summary:** the watch's JavaScript VM gets one 32 KB memory
arena, and the app's own compiled code is loaded into that same arena — so
every byte of watch-side JS you write is a byte of runtime memory you lose.
This app spent weeks riding that ceiling, producing a long series of
"memory full" crashes that each looked like a different bug. The durable
answer is an architecture rule: **the watch is a thin client** (draw, fit
text, buttons), and **the phone does everything else** (location, network,
merge, sort, format).

## The hard constraint: 32 KB for everything

On Pebble Time 2 the Moddable XS VM is created by the firmware with a
single **32 KB arena** shared by:

- the JS **stack**,
- **slots** (all JS objects, ~16 bytes each),
- **chunks** (strings, buffers), *and*
- **your compiled bytecode** (`mc.xsa` — the whole `src/embeddedjs/`
  output) plus the function objects created when modules load.

Measured on real hardware (2026-07-07): with ~13 KB of app bytecode, the
app booted with **3,328 bytes** of free heap and crashed the moment the
first ~1 KB nearby-stops response was JSON-parsed. Deleting the app body
freed heap almost byte-for-byte (−8.5 KB bytecode → +6.9 KB heap).

### The escape hatch, and why it's dormant

`src/c/mdbl.c` requests bigger heaps (8 KB stack / 32 KB slots / 32 KB
chunks ≈ 72 KB total, out of emery's ~122 KB app RAM) via
`ModdableCreationRecord`. Two gotchas discovered the hard way:

1. If **any** of stack/slot/chunk is nonzero, **all three** must be —
   otherwise the VM is silently never created and the app exits straight
   to the watchface with no error.
2. Watch firmware **older than v4.21.0** (released 2026-07-03) has a bug
   (a shadowed local variable, fixed in `coredevices/pebbleos` commit
   `76cd732`) that reads the sizes and then throws them away.

So on current-at-time-of-writing firmware the request is a no-op, and the
app must genuinely fit in 32 KB. **When the firmware update arrives,
nothing needs changing** — the record starts working automatically. You
can confirm with the instrumentation log (below): "Chunk available" jumps
from ~8192 to 32768.

## The design rules that follow

1. **Watch code stays small.** Bytecode is heap. Prefer adding logic to
   `src/pkjs/` (the phone has no meaningful limits) over `src/embeddedjs/`.
2. **The phone sends display-ready data.** The `nearby` response is a
   single pre-merged rows list — favorites (sorted nearest-first, with dim
   flags) then nearby stops, subtitles already formatted ("SF · 320 m ·
   no arrivals"). The watch never merges, sorts, or formats.
3. **Rows payload ≤ 700 bytes.** The watch parses it with only a few KB of
   chunk-heap slack. The phone sheds the farthest nearby stops first and
   never sheds favorites.
4. **Text is fitted lazily, inside `draw()`.** Fitting (ellipsizing to the
   screen width) needs font metrics, so it must happen on the watch — but
   only for rows actually scrolled into view, at most once per row, inside
   `render.begin()/end()`. Steady-state redraws allocate nothing.
5. **The phone takes the location fix** (`navigator.geolocation` in pkjs).
   The watch's Location sensor and the `@moddable/pebbleproxy` are gone —
   they cost watch code/heap and the phone's GPS is the same fix anyway.
   The phone also **owns the favorites list** (watch sends a "fav" toggle
   request; the Clay page has per-favorite remove toggles), and favorites
   beyond the configurable hide distance are left out of the response
   entirely — no payload bytes, no arrival-check API calls.
6. **Startup handshake:** the watch does *not* request at boot (it boots
   faster than the phone's JS and the request would vanish into a 15 s
   timeout). Instead pkjs sends `SettingsChanged: 1` from its `ready`
   handler, and the watch's settings-changed hook runs the first fetch.
7. **Every user-triggerable request has an in-flight guard**
   (`nearbyPending`, `arrivalsPending`) — mashed buttons must be no-ops,
   because each in-flight request pins live memory until its round trip
   ends.

## The crash history, compressed

Every one of these presented as `Alloy: Fatal Error / memory full`:

| # | Apparent cause | Real lesson | Fix |
|---|---|---|---|
| 1 | Session-length "leak" | `ellipsize()` did O(n) string churn per row per frame | `6ae75f8` binary search |
| 2 | Same crash returns while scrolling | Reducing churn isn't enough; draw() must allocate zero | `8cab132` precompute |
| 3 | Crash on refresh-mashing | In-flight request cycles pin live memory | `7d899ed` guards |
| 4 | Instant crash at launch | **Code size is heap**; #2's precompute also moved a big allocation burst to response time with ~0 headroom | `86b4966` + `d7ca0d0` thin client |

The meta-lesson: at near-zero headroom the crash site moves with every
rebuild, so plausible fixes keep "working" briefly. Measure headroom
before trusting any diagnosis (playbook §B/§F).

## Seeing memory numbers (works on all firmware)

`src/c/mdbl.c` sets `kModdableCreationFlagLogInstrumentation` — free when
nobody is listening, and when you run `pebble logs --phone <IP>` the watch
prints a CSV line every second:

```
instruments: 0,0,1,0,0,0,57748,4152,4200,20096,21488,288,6144,0,104,7,0,0,0
```

Columns, in order:

| # | Field | | # | Field |
|---|---|---|---|---|
| 1 | Pixels drawn | | 11 | Slot available |
| 2 | Frames drawn | | 12 | Stack used |
| 3 | Timers | | 13 | Stack available |
| 4 | Files | | 14 | Garbage collections |
| 5 | Poco display list used | | 15 | Keys used |
| 6 | Piu command list used | | 16 | Modules loaded |
| 7 | App bytes free (Pebble app heap) | | 17 | Parser used |
| 8 | Chunk used | | 18 | Floating point |
| 9 | Chunk available | | 19 | Promises settled |
| 10 | Slot used | | | |

"…used/available" pairs are current-use vs current-capacity in bytes;
capacities grow inside the 32 KB arena, so `chunk avail + slot avail +
stack avail` approaching 32 K means the arena is saturated. At a crash the
log also prints the literal `fxAbort memory full:` line — start `pebble
logs` *before* `pebble install` to catch launch-time events.

Healthy post-response numbers on 32 KB firmware (2026-07-07, thin-client
app, 9 favorites + nearby stops): chunk ≈ 5.0/5.9 KB, slot ≈ 17.6/19.4 KB,
stack 288/6144, zero aborts.
