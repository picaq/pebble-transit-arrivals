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
- **Fifth recurrence (2026-07-07, same day): warm refreshes crashed while
  boot survived.** The watch retained the parsed rows payload
  (`state.rowsSrc`) to re-derive ★ flags later — ~2-3 KB of chunk heap
  held permanently, so the *second* response of a session parsed beside
  the first and tipped the heap. Boot always worked (nothing retained
  yet), making it look intermittent. Rule: **the watch keeps only display
  data; parsed payload trees must become garbage in the same handler that
  received them.** Derived state that changes later (fav flags) is
  updated in place on the display rows, not rebuilt from a kept payload.
- **Sixth recurrence (2026-07-10): a per-second `secondchange` listener
  churned the heap.** A bottom-right clock overlay registered
  `watch.addEventListener("secondchange", updateClock)`. Even though
  `updateClock` early-returned on the 59 no-op ticks a minute, *having the
  listener fire every second* allocated ~80 B/s of chunk heap (event
  dispatch + handler invocation), which climbed to near-saturation between
  GCs — instrumentation showed chunk-free hitting **~124 B at every peak**,
  so any real allocation (JSON.parse of a response, appending rows, a busy
  arrivals screen) faulted. It read as "memory full easily" during normal
  use. Gating the *body* on `Date.now()` instead of `new Date()` did **not**
  help (the churn was the per-second wakeup, not the Date). The fix:
  drive the clock from a **minute-aligned `Timer`** (`Timer.set` to the next
  boundary, then `Timer.repeat(…, 60000)`) — chunk-free went from ~124 B to
  **~1.9 KB stable**, better than the healthy reference. Lesson: **a display
  that changes once a minute must not wake once a second.** Periodic
  listeners/timers are continuous churn; match the wakeup cadence to how
  often the output actually changes, and measure with §F — the per-second
  climb between GCs is the signature.
- **Seventh recurrence (2026-07-10, captured live over instrumentation):
  rapid Up-presses on the list — an in-flight guard serializes request
  cycles but does NOT rate-limit them.** Pull-to-refresh was answered from
  the phone's stale rows cache in ~200 ms (no GPS, no network), so every
  press ran a complete cycle — parse ~880 B, rebuild 10 display rows,
  refit visible text, spawn the fresh:1 follow-up — and mashing produced
  ~5 cycles/s: 15 GCs/s, the slot pool driven to **16 B free** (19,424 of
  19,440 used), and the abort landed while parsing a rows response with
  ~2.1 KB chunk free in a saturated arena. Two compounding bugs: (1) the
  880 B rows budget ran *before* `id`/`stale:1` were appended, so the wire
  payload was actually 884 B; (2) pull-to-refresh with a list already on
  screen was served the stale cache first — a full-cost parse of the exact
  list the user was looking at, before the real fresh request even ran.
  Fixes: budget enforced on the final serialized payload in `respond()`
  (index.js); pull-to-refresh sends `fresh:1` directly when rows are
  showing; a 3 s cooldown on both manual-refresh buttons
  (`REFRESH_COOLDOWN_MS`, main.js). Lesson: **guards and cooldowns are
  different defenses** — a guard stops *stacking*, but when the phone
  answers from cache the round trips complete fast enough that back-to-back
  cycles churn the heap just as fatally. Every user-triggerable request
  path needs both.
- **Eighth recurrence (2026-07-10, hours after the seventh, captured live):
  a within-budget response crashed the parse — the retained list was the
  problem, not the payload.** Repro: "load more" grew the list to its
  14-row cap (8 of them favorites), the user scrolled the whole list, then
  pull-to-refreshed: chunk pool at 6,376 of 6,664 used (**288 B free**),
  and an 879 B rows response faulted mid-parse. Guards, cooldown, and
  budget all held. The unbounded retained state was the **fitted-text
  cache**: every row ever scrolled past kept its ellipsized title+subtitle
  copies forever, beside the originals (~1 KB across 14 rows; the arrivals
  screen cached the same way). Fix: `fitVisibleRows()` and the arrivals
  draw loop now **release** fitted copies once a row leaves the visible
  window — retained fitted text is bounded by the window size, not the
  list length; re-scrolling refits in-frame (2 strings per scroll step).
  Lesson: **a lazily built per-item cache needs eviction by the same
  window that builds it** — "fit once, keep forever" is a slow retained
  leak on any list longer than the screen.
- **Ninth recurrence (2026-07-10, same repro as the eighth): the parse
  spike is bigger than intuition says — measure it, then make room for it
  by construction.** The windowed-eviction fix verifiably worked (the log
  shows chunk use dropping 6,204 → 4,896 as the user scrolled back up),
  yet the same pull-to-refresh crashed again with **~1.6 KB chunk free**
  while parsing an 872 B response. Three captured crashes bracket the cost
  of handling one ~870 B rows response at **>1.6 KB of chunk** (the raw
  string arrives in chunk heap, JSON.parse duplicates every string value,
  plus temporaries — and fragmentation raises the effective bar). Fix:
  manual pull-to-refresh now **releases the list before requesting**
  (`state.rows = []`, screen shows "Finding stops…" for the few seconds
  the fresh compute takes) so the response parses beside an empty list —
  the boot condition, which has never faulted. (Refined same day into a
  **frame-hold**: paint one frame with a header "…" indicator, then release
  the rows — Poco only repaints on `begin()/end()`, so the framebuffer
  keeps showing the old list while its heap is already free; every draw()
  path must be suppressed until the response lands, or the hold blanks.
  Same memory math, no visible blanking. Refined AGAIN 2026-07-11 for the
  list screen after the user rejected the frozen input: the invariant is
  release-before-**parse**, not release-before-*request* — with protocol.js
  serializing requests, a `protocol.onBeforeParse` hook fires when the
  response has arrived, synchronously before `JSON.parse`, and releases the
  rows there. The list stays live and scrollable for the whole round trip;
  peak coexistence is rows + the ≤880 B wire string, which was never the
  crash point — the crash was always the parse spike beside retained rows.
  The ARRIVALS screen keeps the request-time frame-hold.) Lessons: (1)
  budget ~2× the
  wire size in free chunk for any watch-side JSON parse, and if that isn't
  reliably available, **free the old data before the new data arrives**
  rather than replace-then-collect; (2) when a fix is verified working but
  the crash persists, the next fix must come from the measured numbers,
  not another plausible mechanism — that's the two-fix rule's actual
  meaning.
- **Tenth recurrence (2026-07-10, evening): the arrivals screen had the
  same parse-beside-retained-data fault the list had.** Repro: "load
  more" to 10 arrivals, scroll to top, refresh — the response parsed
  beside the retained 10-arrival list and faulted, exactly the ninth
  recurrence's arithmetic on the other screen. Fix: the frame-hold was
  generalized — `draw()` now **self-gates** on `state.refreshing` (one
  gate covers every draw path instead of auditing each caller),
  `drawHeaderBusy()` stamps the "…" indicator with a partial Poco update
  of just the header band, and `fetchArrivals()` releases the arrivals
  before every request (manual, "load more", and the 60 s auto-refresh).
  Screen transitions (`openArrivals`, `closeArrivals`) clear the hold, or
  an ignored late response would leave draw() gated forever. Lesson:
  when a memory defense is added to one screen, **grep for the sibling
  screen with the same data flow before the user finds it** — every
  request/response surface needs the same release-before-parse shape.
- **Eleventh recurrence (2026-07-10, night, captured twice): the stale-
  list revalidation raced the user's navigation — crash ~1 s after
  launch whenever the user selected a stop quickly, regardless of the
  stop.** Boot sequence both times: stale rows reply (815 B) parsed →
  user opened a stop → arrivals parsed → then the **immediate fresh:1
  revalidation response** (805 B) parsed beside the retained stale rows
  AND the arrivals, one second into boot with the chunk pool still
  ungrown — instruments showed 172-340 B chunk free and 30+ GCs in that
  second. Fix: the revalidation is **deferred** (`REVALIDATE_DELAY_MS`,
  5 s) and runs through the frame-hold `refreshList()` path (rows
  released before the parse), retrying while the user is off the list
  screen or a request is in flight; any manual fresh refresh cancels it.
  Lessons: (1) a background refresh that "just replaces the data" is a
  full parse cycle and needs the same release-before-parse shape as a
  user-triggered one; (2) launch is the heap's worst second (pools
  ungrown, everything parsing at once) — don't schedule optional work
  into it.
- **Twelfth recurrence (2026-07-10, night): three DIFFERENT request types
  overlapped in the boot second — per-action guards don't compose into a
  global limit.** Repro: launch → Select into a stop → Select again to
  favorite it, all within ~1 s: stale rows parse (877 B) + arrivals cycle
  (388 B) + fav cycle ran concurrently with the VM pools still ungrown,
  and the abort landed around a **29-byte** fav response — proof that no
  payload was the problem; the overlapping cycles' pinned memory was.
  (The deferred revalidation from the eleventh fix verifiably did not
  fire — this was a user-manufactured pileup.) Fix: protocol.js now
  **serializes all requests** — exactly one on the wire at a time
  (`inFlight` + the queue; timeouts release the wire, late responses
  don't double-release, requests that time out while queued are dropped
  unsent). Mashing now costs queueing latency, never memory. Lesson:
  per-action in-flight guards (`arrivalsPending`, `favPending`, …) bound
  each button, but a fast user IS the concurrency — the transport must
  enforce the global one-cycle rule itself.
- **Thirteenth recurrence (2026-07-10, late night): the "load more" page
  is the one response that MUST parse beside a retained list — so its
  size, not the list's, is the variable to cut.** Captured: a 773 B
  more-rows page faulted with 748 B of chunk free beside the ~10-row
  list. Appending can't use the frame-hold (release-then-reload) shape —
  the existing rows are the point. Fix (phone-only): `respond()` takes a
  per-call budget and `buildMoreRows` passes `MORE_BUDGET` = 400 B, sized
  from the measured numbers (~750 B worst-case free chunk at load-more
  time, parse ≈ 2× wire) — ~5 stops per page, one more Down press to
  reach the cap. Lesson: for every response type, ask "what is retained
  while THIS parses?" — pages that append must fit the headroom that
  exists *with* the data they're joining, not the boot headroom.
- **Fourteenth recurrence (2026-07-10, end of session) — THE ENDPOINT: the
  arena itself ran out, and the defenses helped spend it.** A 391 B
  arrivals response faulted with 1.6 KB of chunk free but **688 B of slot
  free and 164 B of unallocated arena** (chunk 5,996 + slot 20,464 + stack
  6,144 = 32,604 of 32,768) — the slot pool needed to grow and could not.
  Slot capacity ratcheted up build-over-build within one evening (18,416 →
  19,440 → 20,464) as recurrences 7-13 were fixed: **defense code is
  bytecode and interned keys in the same arena as the heap** (keys count
  123 → 133 across the session). Each fix verifiably removed its trigger;
  their sum consumed the margin. When chunk is defended, the crash moves
  to slots — at arena saturation the failing pool is just whichever
  allocator asks next. **Rule: once the carved arena approaches 32 KB with
  pools near-full at idle, STOP writing watch-side defenses.** The levers
  left are firmware ≥ v4.21.0 (72 KB VM via mdbl.c — ends this entire
  §B recurrence class) or *removing* embedded code, not adding it.
  Open question for post-firmware: in this capture an arrivals request
  went ~12 s with no pkjs response logged before the crash sequence — if
  unanswered requests recur, investigate AppMessage loss; under the
  serialized protocol a lost response holds the wire for the full 15 s
  timeout and queues everything behind it.
  **Residual repro, pinned 2026-07-11 (full instrumentation capture):**
  boot → stale list (8 favorites + 2 nearby fit the 880 B page) → scroll
  to the bottom → "load more" fires → the ≤400 B more-rows page parses
  ~7 s later (the phone was busy with a 33 K-visit stop-info fetch) and
  aborts on **slot exhaustion**: slot pool at its ceiling (20,080 used of
  20,464; the pool had just grown 19,440 → 20,464), arena spare 108 B,
  chunk free 1.1 KB (irrelevant — the slot pool asked). Payload budgets
  all held; the baseline slot watermark (~18.8 KB at idle, mostly
  program structure) is what leaves no room. The user experiences this
  as "selecting into a stop crashes" because the load-more press is part
  of reaching a non-favorited stop. Confirms the endpoint: no payload or
  code fix changes this on 32 KB firmware.
  **The boot ceiling is condition-dependent — a passing boot does not
  certify a size (2026-07-12):** a working tree +251 B of mc.xsa over the
  day's baseline booted cleanly in one session and crashed "memory full"
  at boot, consistently, hours later with no code change (the phone-side
  payload and BLE timing shifted under it). Re-measured that evening: a
  +42 B tree crashed at boot 2/2 in the same minutes that the baseline
  booted fine — so the boot margin above the current footprint can be
  smaller than 42 B, and earlier same-week evidence that ~+100 B was the
  line was just that day's conditions. mc.xsa size deltas ORDER builds
  (bigger is strictly worse); they do not give a portable pass/fail
  number, and one clean boot screenshot proves nothing about tomorrow.
  Margin is recovered only by deleting bytecode: stripping four dead
  `console.log` calls (watch logs never surface — "signals that lie")
  bought 216 B. Rule: on 32 KB firmware, any net-positive bytecode
  change is at risk of failing boot on a bad day; pay for features by
  deleting code first, and park what still doesn't fit (branch
  `now-polish-post-firmware`) until the ≥ v4.21.0 firmware lands.
- **Fifteenth recurrence (2026-07-12, captured live): a payload-budget
  *exemption* grew until it WAS the payload — "favorites are never shed"
  let 13 visible favorites fill 1143 B on the wire.** `respond()`'s shed
  floor was `max(favCount, 1)`, so once the favorites block alone
  exceeded 880 B the loop stopped and the oversized payload shipped.
  Two user-visible symptoms, reported as one bug: every non-favorite was
  shed ("local stops don't load"), and the watch crashed "memory full" —
  the BOOT parse of 1153 B survived (empty list, boot condition), the
  revalidation/refresh parse beside the retained rows faulted seconds
  later, every time (ninth-recurrence arithmetic: parse ≈ 2× wire needs
  >2.2 KB chunk; ~2 KB free). Fix (phone-only): favorites capped at the
  nearest `FAV_ROWS_MAX`=6 on page 0 (capped-out ones stay saved and
  reappear when nearer), total rows capped at 14 (the watch's
  `MAX_LIST_ROWS`), favorite names compacted to 16 chars on >8-row lists,
  and the budget made **absolute** — the shed floor is now 1 row, so
  favorites shed farthest-first as the last resort. Lessons: (1) any
  "never shed / never drop" class must still bow to the wire budget —
  an exemption without its own cap is a payload bomb armed by user data
  growth (favorites accumulate); (2) a "feature stopped working" report
  (missing rows) and a crash can be the same defect — the shed loop was
  silently eating the rows *and* overrunning the budget from the same
  line.
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
  `flags` field works on all versions. Verified empirically 2026-07-11:
  a fitting-sum record (stack 4096 / slot 8192 / chunk 8192, sum well
  under 32 KB) is ignored identically — boot instruments still showed
  stack 6,144 and initial pools 8192/8176. There is no partial path: on
  old firmware the size fields simply never apply, so shrinking the
  stack request cannot hand arena to the slot pool. On old firmware the
  only lever is shrinking embedded code.

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
  Column-by-column key for the `instruments:` line, plus known-healthy
  reference numbers: `docs/ARCHITECTURE-AND-MEMORY.md`.
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
- **Match wakeup cadence to how often the output changes.** A periodic
  listener/timer is continuous heap churn even if its handler early-returns
  — a per-second `secondchange` clock that only updates once a minute drove
  a "memory full" regression (§B, sixth recurrence). Use a minute-cadence
  `Timer` for a minute display, not a second tick you throttle in JS.
- Sensors (`Location`) are one-shot: `close()` in both callbacks, plus an
  in-flight guard so repeated button presses can't stack instances.
- Every user-triggerable request path (button-driven refreshes included) has
  an in-flight guard, and protocol.js's `MAX_PENDING` backstop stays in
  place — mashed buttons must produce no-ops, not stacked request cycles.
  **A guard alone is not enough when responses come back fast**: cached
  phone replies round-trip in ~200 ms, so a guard still admits ~5 complete
  request cycles a second (§B, seventh recurrence). Manual-refresh paths
  also need a cooldown (`REFRESH_COOLDOWN_MS`).
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
