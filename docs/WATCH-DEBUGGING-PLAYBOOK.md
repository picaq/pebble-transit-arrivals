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

Debugging order:

1. **Audit the `draw()` call graph for allocation churn first**, not leaks.
   Anything called per-row per-frame must not allocate proportionally to
   string length or list size. Red flags: string concatenation in loops,
   `slice`/`substring` in loops, array/object/closure creation inside the
   render path, `JSON.stringify` in the render path.
2. Then audit true leaks: every `Timer.set`/`Timer.repeat` needs a
   guaranteed `Timer.clear` path (screen close, promise settle — see
   commit `8cabdc8`); `pending` maps and queues need timeouts/bounds;
   `Location` must be closed in both `onSample` and `onError` and guarded
   against concurrent requests (commit `f9984eb`).
3. If two fixes haven't stopped it → §D bisection. Do not write a third fix.

---

## §C — Tooling hangs: `fetch_watch_info` TimeoutError

**This is never an app bug.** Do not read or modify source code for it.
A stock scaffold reproduces it identically.

- **On `--emulator emery`:** the SDK 4.17 / pebble-tool 5.0.39 QEMU machine
  model for emery (cortex-m33) is broken — the app draws but PebbleKit never
  connects and `ping`/`logs`/`screenshot` all time out. **Unfixable from this
  repo; do not re-diagnose.** Use `--emulator basalt` for platform-agnostic
  logic (Poco/layout/protocol), and real hardware for anything else.
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
| Watch-side `console.log` via `pebble logs` | Never surfaces in this SDK. Absence of output carries zero information. Phone-side (pkjs) logs *do* surface. |
| Total heap free at crash time | "memory full" fires from fragmentation with >50% free. |
| The `emery` emulator | Broken (§C). Its failures say nothing about your code. |
| Build/install success | Font errors, manifest omissions, and module-eval exceptions all pass the build and crash at runtime. |

---

## §F — Getting debug output when logs don't work

Since watch `console.log` is invisible:

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

- No per-character or per-item string building in anything reachable from
  `draw()`. Budget: O(log n) allocations max per text fitted (see
  `ellipsize()`), zero allocations preferred for static text.
- Every `new render.Font(...)` pair verified against `xsHost.c`'s table.
- Every timer has an owner responsible for clearing it on every exit path,
  including promise rejection and screen close.
- Sensors (`Location`) are one-shot: `close()` in both callbacks, plus an
  in-flight guard so repeated button presses can't stack instances.
- Test on **real hardware** before declaring memory/render changes done —
  the emulator situation (§C) means emulator-only testing proves little for
  emery-specific behavior, and memory-churn bugs need real session-length
  usage (scroll a long list, open a busy stop, let it auto-refresh several
  times) to show up.
