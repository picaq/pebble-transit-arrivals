# Watch Debugging Playbook — crashes, blank screens, memory errors

**Read this before debugging any watch-side failure.** Hours have been lost
in this repo fixing plausible-but-wrong causes. Every pattern below was hit
for real on Pebble Time 2 hardware or the SDK 4.17 toolchain, and each one
initially looked like something else. This is a decision tree: classify the
symptom first, then follow only that section.

Written 2026-07 from real debugging sessions. If you learn something new
that contradicts or extends this file, **update this file** in the same
change — that's how it stays trustworthy.

---

## Step 0 — classify the symptom before hypothesizing

| Symptom | Actual class | Go to |
|---|---|---|
| Blank white/grey screen after a *successful* build+install | Uncaught exception during module evaluation (usually an invalid Poco font pair). **Not** a rendering bug. | §A |
| `Alloy: Fatal Error / memory full` on the watch | XS allocator failure. Often **fragmentation from allocation churn**, not a leak, and not exhaustion. | §B |
| `pebble ping`/`install`/`logs` hang, then `TimeoutError` on `fetch_watch_info` | Environment/toolchain problem. **Never app code.** Do not touch the source. | §C |
| Crash appears "after a while" / "sometimes" / "on some stops" | Unpinned repro. Pin it down (§D step 1) before anything else. | §D |

Two rules that override everything:

1. **Two-fix rule.** If the failure survives two targeted fixes, stop
   hypothesizing. Each fix so far in this repo's history was real and
   well-reasoned — and wrong about the crash. The third wasted fix is where
   the hours go. Switch to the bisection workflow (§D, or the
   `/bisect-watch-crash` skill).
2. **Pin the repro first.** "It crashes" is not a repro. "It crashes only on
   stops with many arrivals, after ~3 refreshes" is — and that precision is
   what actually located the real bug here (allocation churn scaling with
   text volume and draw count). Get the *specific triggering action* before
   writing any fix.

---

## §A — Blank screen after successful install

A successful `pebble build` + install followed by a blank screen means the
watch script **threw during module evaluation and aborted before any drawing
or button setup ran**. You get no error anywhere: watch-side `console.log`
never surfaces through `pebble logs` in this SDK, so silence proves nothing.

Checklist, in order:

1. **Audit every `new render.Font(family, size)` call** — this is the #1
   cause. An unlisted (family, size) pair throws `xsUnknownError("font not
   found")` synchronously, and these calls sit at module top level in
   `src/embeddedjs/main.js`. Valid pairs are a hardcoded table in the SDK's
   `xs/platforms/pebble/xsHost.c` (`modFindPebbleFont` / `gFonts`) — check
   there, not the docs. Known-good examples: `Gothic-Regular`/`Gothic-Bold`
   at 9/14/18/24/28/36, `Leco-Bold` at 20/26/32/36/38, `Leco-Regular` only
   at 42. There is **no compile-time check**.
2. **Check `src/embeddedjs/manifest.json`** — any embeddedjs module file not
   listed under `"modules"` is a runtime module-not-found abort.
3. **Wrap top-level init in try/catch temporarily** and render the error
   message with a known-good font (Gothic-Bold 18) — see §F for the
   draw-to-screen debug technique, since logs are unavailable.
4. Still blank? Confirm the pipeline itself with the stock
   `pebble new-project --alloy` scaffold's minimal `main.js`; if that's blank
   too, it's environment, not this app.

`pebble screenshot --phone <IP> out.png` (or `--emulator basalt`) is the
fastest way to confirm what's actually on screen.

---

## §B — "Alloy: Fatal Error / memory full"

This is a literal, specific abort reason from the XS allocator
(`fxAbort` in `xsError.c`) — distinct from "unhandled exception". Facts
established on real hardware in this repo:

- **It fires with plenty of total free heap.** At the crash that cost the
  most time, the firmware's own heap log read `Total Size <122600B> Used
  <55072B>` — over half free. The cause was **fragmentation**: thousands of
  small throwaway allocations churned the heap until one allocation couldn't
  find a contiguous block.
- **Churn looks exactly like a leak.** More scrolling, more refreshes, more
  text on screen → crashes sooner. That session-length dependence sent three
  fixes at "leaks" (a real timer bug, a real queue bound, a real buffer cap
  — all genuinely worth fixing, none the cause).
- The actual culprit was `ellipsize()` in `main.js` doing O(n) string
  concat+slice allocations per call, for every row, on every `draw()`.
  Fixed by binary-searching the cut point (commit `6ae75f8`).
- **Reducing churn is not enough — the crash came back.** After the O(n)→
  O(log n) ellipsize fix, the same "memory full" recurred on the list screen
  during scrolling: the list `draw()` still allocated ~10 strings per row
  per redraw (prefix concat, ellipsize probes, subtitle concat,
  `formatDist`), and lists had gotten longer (up to 14 stops). The durable
  fix was making `draw()` **allocation-free**: all display strings are
  precomputed when data changes (`rebuildRows()`, `prepareArrivals()`) and
  cached (`state.stopTitle`, `state.stopIsFav` — the footer previously
  re-read and `JSON.parse`d favorites from localStorage on every redraw).
  Hold any fix in this class to that standard: zero allocations in the
  render path, not fewer.
- **The crash survived even an allocation-free `draw()` — the real trigger
  was request concurrency.** Third recurrence (2026-07-07): the pinned
  repro was *hammering Down on the arrivals screen*, where Up/Down means
  "manual refresh" and `fetchArrivals()` had no in-flight guard. Each press
  launched a full concurrent request cycle (pending-map entry, timeout
  timer, queued payload, then a ~1 KB response string, `JSON.parse`,
  display prep) — and unlike GC-able churn, all of it is **live** until its
  round trip completes, so a burst of presses spikes genuinely referenced
  memory past the XS pool. Fixed with an in-flight guard
  (`state.arrivalsPending`, mirroring the existing `locationPending`) plus
  a `MAX_PENDING` backstop in protocol.js. Lesson: churn and leaks aren't
  the only suspects — **any user-triggerable action that starts a
  request/sensor cycle needs an in-flight guard**, because buttons can be
  mashed faster than round trips complete. Also a repro-pinning lesson: the
  first report said "list screen while scrolling"; the precise trigger
  ("pressing Down too much *within a stop*") pointed at a completely
  different code path. Get the exact screen and button before theorizing.
- **The underlying reason all of the above kept recurring: the XS VM is a
  single 32 KB arena, and your compiled JS code lives inside it.** Fourth
  recurrence (2026-07-07, instant "memory full" ~0.5 s after launch, on
  processing the first nearby response): measured with the allocation-gauge
  technique (§F), the app had **3,328 bytes** of free heap right after
  imports and <1 KB after boot. The firmware default VM is one 32 KB arena
  shared by stack + slots + chunks, and the mod archive (`mc.xsa` bytecode,
  ~13 KB for this app) is loaded into that same arena — deleting the app
  body freed heap byte-for-byte (measured: −8.5 KB bytecode → +6.9 KB
  heap). **Every byte of embedded JS you write costs ~a byte of runtime
  heap.** This is why plausible runtime fixes (lazy fitting, in-frame
  measurement, smaller bursts) changed nothing: at ~0 headroom, whichever
  allocation lands first faults, so the "cause" moves with every rebuild.
  Suspect this whenever a memory crash won't localize: run the gauge (§F)
  first — if free heap after imports is only a few KB, stop hunting leaks.
- **Fix: request bigger VM heaps from `src/c/mdbl.c`** via
  `ModdableCreationRecord` (`stack`/`slot`/`chunk`, bytes). Rules from
  firmware source (`src/fw/applib/moddable/moddable.c` in
  coredevices/pebbleos): if any of the three is nonzero, **all three must
  be nonzero**, else the machine is silently never created and the app
  exits to the watchface at launch with no error. If the sum exceeds 32 KB
  the heaps are allocated separately from the ~122 KB emery app heap with
  growth disabled. **Requires watch firmware ≥ v4.21.0** (2026-07-03):
  older firmware has a shadowed-variable bug that silently ignores the
  sizes and uses the 32 KB default (fixed in commit `76cd732`); the
  `flags` field works on all versions. On old firmware the only lever is
  shrinking embedded code.

Debugging order:

1. **Audit the `draw()` call graph for allocation churn first**, not leaks.
   Anything called per-row per-frame must not allocate proportionally to
   string length or list size. Red flags: string concatenation in loops,
   `slice`/`substring` in loops, array/object/closure creation inside the
   render path, `JSON.stringify` in the render path.
2. **Audit concurrency next**: can any button press, timer, or event start
   a request or sensor cycle while the previous one is still in flight?
   Every such site needs an in-flight guard (`locationPending`,
   `arrivalsPending`) — in-flight cycles pin live memory that GC cannot
   reclaim, and a mashed button stacks them (this was the actual trigger
   behind the 2026-07 crashes; see above).
3. Then audit true leaks: every `Timer.set`/`Timer.repeat` needs a
   guaranteed `Timer.clear` path (screen close, promise settle — see
   commit `8cabdc8`); `pending` maps and queues need timeouts/bounds;
   `Location` must be closed in both `onSample` and `onError` and guarded
   against concurrent requests (commit `f9984eb`).
4. If two fixes haven't stopped it → §D bisection or a discriminating
   repro experiment (e.g. "scroll only, never refresh" vs "refresh only"),
   whichever is cheaper. Do not write a third speculative fix.

---

## §C — Tooling hangs: `fetch_watch_info` TimeoutError

**This is never an app bug.** Do not read or modify source code for it.
A stock scaffold reproduces it identically.

- **On `--emulator emery`:** the SDK 4.17 / pebble-tool 5.0.39 QEMU machine
  model for emery (cortex-m33) is broken — the app installs and draws in
  the QEMU window, but PebbleKit never connects and
  `ping`/`logs`/`screenshot` all time out. **Unfixable from this repo; do
  not re-diagnose.** The emulator can therefore verify exactly two things:
  the install succeeds, and (by a human looking at the window) the first
  screen renders. Everything else needs real hardware.
- **Do not try `--emulator basalt` for this app.** `targetPlatforms` is
  `["emery"]` and Alloy only supports emery/gabbro, so a basalt install
  fails with a bare "App install failed." (verified 2026-07-07) — that
  message means "no binary for this platform", not a broken build, and even
  `-v -v` won't say so. basalt is only useful for toolchain-level sanity
  (`pebble ping`, pypkjs) with a stock `pebble new-project --alloy`
  scaffold.
- **On `--phone <IP>`:** if port 9000 connects but `WatchVersion` never gets
  a reply, it's a stuck watch↔phone Bluetooth dev-connection session. Things
  proven **not** to fix it: toggling Developer Connection, force-quitting
  the Pebble app, toggling Bluetooth, re-pairing the watch. What fixed it:
  **restarting the phone.** Go straight there; ask the user to do it (it's a
  physical step).

---

## §D — Bisection workflow (what actually found the real bug)

Use when: the two-fix rule triggers, or the cause is genuinely unclear.
The `/bisect-watch-crash` skill walks this interactively; the procedure:

1. **Pin the repro.** Get from the user (or establish yourself) the exact
   trigger: which stop, how many refreshes, how much scrolling, how long a
   session. At each test below, report *how/when* it failed, not just
   pass/fail — changed failure behavior is diagnostic.
2. **Preserve the working tree** (commit, or branch + stash).
3. **Pick the last-known-good commit** (from user report or changelog).
4. **Install the candidate under a scratch identity** so it can sit next to
   the released app: temporarily change `pebble.uuid` in `package.json` to a
   fresh UUID (`uuidgen`) and suffix the app name (e.g. "Transit DBG").
   Never commit this change.
5. **Verify the known-good commit actually passes the repro** on the same
   hardware. If it doesn't, your baseline or repro is wrong — stop and fix
   that first.
6. **Walk commits** (linear history: step forward one at a time from good,
   or `git bisect` for longer ranges). Per commit:
   `pebble build && pebble install --phone <IP>`, run the pinned repro,
   record commit / result / failure detail in a table.
   Real-hardware testing is a **human step** — hand the user the exact repro
   script for each round and wait for the report.
7. **First bad commit found:** `git show` it and audit *only that diff*
   against the §B/§F pattern list. The bug is in the diff; resist widening.
8. **Restore** the real UUID/name and working tree; uninstall the DBG app.

---

## §E — Signals you cannot trust (verified misleading)

| Signal | Why it lies |
|---|---|
| `pebble build`'s "Free RAM available" report | Never changed across builds regardless of code added. Uninformative for any memory bug. |
| A memory crash "moving" between rebuilds | At near-zero headroom (see §B, 32 KB arena), whichever allocation lands first faults — the crash site shifts with any code change, including your fix attempts. Measure headroom (§F) before trusting any localization. |
| Watch-side `console.log` via `pebble logs` | Never surfaces in this SDK. Absence of output carries zero information. Phone-side (pkjs) logs *do* surface. |
| Total heap free at crash time | "memory full" fires from fragmentation with >50% free. |
| The `emery` emulator | Broken (§C). Its failures say nothing about your code. |
| Build/install success | Font errors, manifest omissions, and module-eval exceptions all pass the build and crash at runtime. |

---

## §F — Getting debug output when logs don't work

Since watch `console.log` is invisible:

- **XS instrumentation over `pebble logs` (best memory tool).** In
  `src/c/mdbl.c`, pass `kModdableCreationFlagLogInstrumentation` in the
  `ModdableCreationRecord` flags (already done in this repo; the firmware
  auto-disables it when no log listener is attached, so it's free to leave
  on). Then `pebble logs --phone <IP>` streams per-sample lines with Chunk
  used/available, Slot used/available, Stack used/available, App bytes
  free, GC count, modules loaded — and at a crash you get the literal
  `fxAbort memory full` line plus the firmware heap report. Start `pebble
  logs` in the background *before* `pebble install` so you catch launch.
- **localStorage crash markers (find the crash site).** Write a phase
  marker (`localStorage.setItem("diag", "resp 14 stops")`) before each
  step of the suspect path; after the crash, install a tiny reader build
  (same UUID keeps localStorage) that draws
  `localStorage.getItem("diag")`. The last marker written is where it
  died. Found the fourth §B recurrence's crash site in two rounds.
- **Allocation gauge (measure free heap without instrumentation).** At the
  point of interest, loop `hold.push(new ArrayBuffer(256))` writing a
  progress marker each iteration; the allocator abort ends the run and the
  persisted marker *is* the headroom measurement. One number per run, but
  needs nothing from the host.
- **Autonomous repro loop for launch crashes.** `pebble install` auto-
  launches the app, so `install && sleep 6 && pebble screenshot` verifies
  a launch crash (or its absence) with no human on the watch — this made
  an 8-round bisection and A/B experiments cheap. Scroll/button repros
  still need human hands.
- **Draw diagnostics on screen.** Keep a small `debugLines` array, render it
  with a known-good font (Gothic-Regular 14) from `draw()`, and confirm with
  `pebble screenshot`. Wrap suspect init in try/catch and surface
  `e.message` this way.
- **Use the status line.** `state.status` / `state.arrivalsStatus` already
  render; piping checkpoint markers through them costs nothing.
- **Phone-side logs work.** Anything observable from pkjs (message traffic,
  request timing) → `console.log` in `src/pkjs/` + `pebble logs --phone <IP>`.
- The firmware's own heap-usage log line (`Total Size <...> Used <...>`)
  appears at crash time and is trustworthy for *totals* (but see §E).
- For real stepping/breakpoints on the watch VM: xsbug — see
  https://developer.repebble.com/guides/debugging/debugging-alloy-with-xsbug.md

---

## §G — Prevention checklist for new watch code

Beyond CLAUDE.md §11:

- `draw()` and everything reachable from it allocate **nothing**: no string
  concat/slice, no objects/arrays/closures, no `JSON.parse`, no storage
  reads. Precompute display strings when the data changes
  (`rebuildRows()` / `prepareArrivals()`), cache derived flags on `state`.
  This is a hard rule, not a budget — "fewer allocations" has already
  failed once (§B).
- Every `new render.Font(...)` pair verified against `xsHost.c`'s table.
- Every timer has an owner responsible for clearing it on every exit path,
  including promise rejection and screen close.
- Sensors (`Location`) are one-shot: `close()` in both callbacks, plus an
  in-flight guard so repeated button presses can't stack instances.
- Every user-triggerable request path (button-driven refreshes included) has
  an in-flight guard, and protocol.js's `MAX_PENDING` backstop stays in
  place — mashed buttons must produce no-ops, not stacked request cycles.
- **Embedded JS code size is runtime heap.** The mod bytecode loads into
  the same VM arena the heap lives in (§B). Keep `src/embeddedjs/` lean;
  after growing it meaningfully, re-run the §F gauge (or check the
  instrumentation "App bytes free" / chunk numbers) to confirm headroom.
  With firmware ≥ v4.21.0 the `mdbl.c` creation record buys ~72 KB of VM,
  but don't treat that as license to bloat — older firmware gets 32 KB.
- Test on **real hardware** before declaring memory/render changes done —
  the emulator situation (§C) means emulator-only testing proves little for
  emery-specific behavior, and memory-churn bugs need real session-length
  usage (scroll a long list, open a busy stop, let it auto-refresh several
  times) to show up.
