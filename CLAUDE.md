# CLAUDE.md — Pebble (Alloy/JS) Development Guide

You are working on a **Pebble smartwatch app written in JavaScript** using the
**Alloy** framework (Moddable SDK / XS engine), targeting **Pebble Time 2
(platform: `emery`)**. This file tells you everything the docs won’t remind
you of. Read it fully before writing code. When in doubt, fetch the official
docs — the index is at https://developer.repebble.com/llms.txt

Before changing anything the user sees or does — fonts, colors, layout
metrics, on-screen strings, button mappings, refresh cadence, list caps,
truncation lengths, settings defaults — read `design.md` first: it
catalogs every such value with its code location and the constraint that
applies to changing it. If your change alters one of those values, update
`design.md` in the same commit.

## 1. The two JavaScript worlds (never confuse them)

| Directory | Runs on | Engine | Module system | Has network? | Has localStorage? |
|---|---|---|---|---|---|
| `src/embeddedjs/` | **Watch** | XS (Moddable) | ES modules (`import`) | Only via phone proxy | Yes (small) |
| `src/pkjs/` | **Phone** (Pebble app) | Phone JS runtime | CommonJS (`require`) | Yes (`XMLHttpRequest`) | Yes (larger) |

Rules that follow from this:

- **Never** use `require()` in `src/embeddedjs/` or `import` in `src/pkjs/`.
- **Never** call watch APIs (`Poco`, `Button`, `pebble/message`, sensors) from
  pkjs, and never call `Pebble.*` or `XMLHttpRequest` from embeddedjs.
- Data crosses between the worlds **only** via AppMessage. In this project
  that is wrapped by `src/embeddedjs/protocol.js` (watch) and the
  `appmessage` handler in `src/pkjs/index.js` (phone). Keep them in sync.

## 2. XS engine constraints (watch code)

- Strict mode everywhere, implicitly.
- **Primordials are frozen**: you cannot patch `Array.prototype`, `String.prototype`, etc.
- **No `eval`**, no `new Function(string)`.
- **Every module file must be listed** in `src/embeddedjs/manifest.json`
  under `"modules"` or you get a *runtime* module-not-found error:

  ```json
  { "modules": { "*": ["./main", "./protocol"] } }
  ```

  If you add `src/embeddedjs/foo.js`, add `"./foo"` to that array. This is
  the #1 forgotten step.
- Timers: use the Moddable module — `import Timer from "timer"` with
  `Timer.set(fn, ms)`, `Timer.repeat(fn, ms)`, `Timer.clear(id)`. Do not
  assume `setTimeout`/`setInterval` exist on the watch.
- RAM is tiny. Keep in-memory lists short (≤ ~a dozen items), truncate
  strings, avoid large JSON. Big data lives on the phone.
- Globals provided by Alloy: `screen` (`.width`/`.height`), `watch`
  (`.connected.app`, `.connected.pebblekit`, `addEventListener("connected"|"secondchange", ...)`),
  `device` (`device.keyValue`, `device.files`, `device.sensor.Touch`),
  `localStorage`, `console.log`.

## 3. Hardware / platform facts

- **Pebble Time 2 = platform `emery`.** Color display, 4 physical buttons
  (back, up, select, down), **touchscreen**, microphone, heart-rate.
  Query size at runtime via `screen.width` / `screen.height` — do not
  hardcode pixel dimensions.
- Alloy supports `emery` and `gabbro` (Pebble Round 2). If asked to also
  target Round 2, add `"gabbro"` to `targetPlatforms` and make all layout
  math relative to `screen.width/height` (round display: keep content
  centered, see the Round App Design guide).
- Buttons via `pebble/button`:

  ```js
  import Button from "pebble/button";
  new Button({ types: ["select", "up", "down", "back"],
               onPush(down, type) { /* down=true on press */ } });
  ```

  **If `"back"` is in `types`, back no longer auto-exits the app** — the
  user must press-and-hold back to exit. Mention this in any UI you design.
- Touch (optional): Piu delivers `onTouchBegan`/`onTouchEnded` when the
  Application is constructed with `touchCount: 1`; raw access is
  `device.sensor.Touch`.

## 4. Rendering: Poco vs Piu

Two options exist on the watch:

- **Poco** (`commodetto/Poco`) — immediate-mode drawing. This project uses
  Poco because a full-redraw list UI is simpler and cheaper in RAM:

  ```js
  import Poco from "commodetto/Poco";
  const render = new Poco(screen);
  const font = new render.Font("Gothic-Bold", 18);
  const black = render.makeColor(0, 0, 0);
  render.begin();
  render.fillRectangle(black, 0, 0, render.width, render.height);
  render.drawText("hi", font, render.makeColor(255,255,255), 10, 10);
  render.end();
  ```

- **Piu** (`import {} from "piu/MC"`) — declarative/retained UI with
  Containers, Labels, Skins, Behaviors, Timeline animations. Prefer Piu if
  the app grows many screens or animations. Docs:
  https://developer.repebble.com/guides/alloy/piu-guide.md

Do not mix Poco and Piu drawing to the same screen. Pick one per app.

System fonts (both frameworks): families `Gothic` (regular/bold), `Bitham`,
`Roboto`, `Leco` (good for numbers), `Droid`; only specific sizes exist —
check https://developer.repebble.com/guides/app-resources/system-fonts.md
before inventing a size.

## 5. Networking

- All HTTP in this project happens **on the phone** in `src/pkjs/transit511.js`
  using `XMLHttpRequest`. Rationale: keeps API keys off the watch, lets us
  cache multi-megabyte stop lists in phone localStorage, and sends only
  tiny curated payloads to the watch.
- The watch *can* `fetch()`/`WebSocket` directly (proxied through the phone)
  if `@moddable/pebbleproxy` is installed and wired in pkjs — but responses
  land in watch RAM, so only do this for small payloads. Wait for
  `watch.connected.pebblekit === true` before any network call.
- The proxy would also be required for the watch `Location` sensor
  (`embedded:sensor/Location`). **This app deliberately uses neither**: the
  location fix is taken on the phone (`navigator.geolocation` in pkjs,
  needs `"location"` in `capabilities`) because the proxy and the Location
  flow cost watch code and heap (playbook §B), and the phone’s fix is the
  same GPS anyway.

## 6. Watch↔phone messaging protocol (this project)

- `package.json → pebble.messageKeys` must list every AppMessage key used:
  currently `Request`, `Response`, `SettingsChanged`.
- Watch side: `pebble/message` `Message` class — `keys` array must match,
  `onReadable` → `this.read()` returns a Map, `write(new Map([...]))` sends.
  A new Message starts **suspended**; wait for `onWritable` (protocol.js
  already queues for you).
- Phone side: `Pebble.addEventListener("appmessage", ...)`. Reply with
  `Pebble.sendAppMessage({...})`. (If the pebbleproxy is ever reintroduced,
  it must get first look at every appmessage before your own keys.)
- **Startup handshake:** the watch does NOT request at boot — its request
  would race pkjs startup and vanish. pkjs sends `SettingsChanged: 1` from
  its `ready` handler; the watch’s `protocol.onSettingsChanged` runs the
  first nearby fetch. Keep this when touching either side.
- Payload discipline: rows responses fit `ROWS_BUDGET` (1600 B; relaxed
  2026-07-12 from 880 B under the 72 KB heap — on 32 KB-arena firmware
  the watch parses with only a few KB of chunk-heap slack, playbook §B,
  and 880 B is the ceiling), ~1 KB elsewhere. Truncate names, cap list
  lengths, shed farthest stops first. If you need more, add chunking
  (`seq`/`total` fields) — do not just raise the caps.
- Request/response correlation is via an `id` field; see protocol.js.

## 7. Persistence

- Watch: `localStorage` exists (strings only) but **this app stores nothing
  on the watch** — favorites moved to the phone (watch code/storage costs
  watch heap, playbook §B); the watch-side legacy-favorites migration
  sender was removed 2026-07-12 after the migration completed on the only
  device this app runs on (the phone’s `mig` import handler remains).
  Also available: `device.keyValue` and `device.files` for binary/large data.
- Phone: `localStorage` in pkjs. Used here for settings (`settings.v1`),
  the favorites list (`favorites.v1` — [{agency, code, name, hide?}],
  capped 10, edited from the watch’s “fav” request and the Clay page’s
  show/hide toggles), and the 7-day stop caches (`stops511.v1.<AGENCY>`).
- Always merge stored settings over defaults (spread pattern) so adding new
  settings fields never breaks old installs.

## 8. Settings (Clay)

- Clay (`@rebble/clay`) renders the gear-icon settings page in the phone app.
  Requires `"configurable"` in `capabilities`.
- This project runs Clay in **manual mode** (`autoHandleEvents: false`) and
  handles `showConfiguration`/`webviewclosed` in `src/pkjs/index.js`.
  Settings are stored on the **phone**, not sent to the watch — the watch
  only receives a `SettingsChanged: 1` ping. Keep it this way: the phone is
  the only consumer of the API key and agency list.
- To add a setting: add the field to `src/pkjs/config.js`, read it in the
  `webviewclosed` handler, add it to `DEFAULT_SETTINGS`. Only touch
  package.json messageKeys if the value must reach the watch.
- **Local dev API key convenience:** `src/pkjs/index.js` requires
  `./localSecrets` (git-ignored, generated by `node scripts/inject-api-key.js`
  from `.env`’s `TRANSIT_511_API_TOKEN`) and uses `localSecrets.apiKey` as
  `DEFAULT_SETTINGS.apiKey`, purely to pre-fill the Clay page for local
  testing. `src/pkjs` has **no `process.env`** at runtime (it’s not Node —
  it’s `pypkjs`/the phone’s JS engine), so never read env vars directly in
  pkjs code; the injection script runs under real Node on the host instead.
  `localSecrets.js` must exist for the build to resolve the `require` — run
  the script at least once after cloning, even with an empty `.env`.

## 9. Transit data layer (511 SF Bay)

- Single API for Muni (`SF`), BART (`BA`), AC Transit (`AC`), Golden Gate
  Transit (`GG`), SamTrans (`SM`) and 30+ more Bay Area operators.
- Endpoints, quirks (UTF-8 BOM! 60 req/hr rate limit! huge stop lists!) and
  response shapes are documented at the top of `src/pkjs/transit511.js` and
  in `docs/511-API-NOTES.md`. Update those files if you learn something new.
- **Provider boundary**: `index.js` only calls `findNearbyStops()`,
  `getArrivals()`, `getFavoriteStatus()` and `getStopInfo()`. To support
  another region/agency outside 511, create `src/pkjs/transitXYZ.js`
  exporting the same four functions and select the provider from settings.
  Do not leak provider-specific shapes past this boundary — the watch
  protocol format is provider-neutral.
- If an operator code is uncertain, fetch
  `https://api.511.org/transit/operators?api_key=KEY&format=json` rather
  than guessing.

## 10. Build / run / debug commands

```bash
pebble build                        # compile (run from project root)
pebble install --emulator emery     # installs & renders, but nothing connection-based works — section 11
pebble install --phone <PHONE_IP>   # sideload to a real watch via the phone
pebble logs --phone <PHONE_IP>      # pkjs (phone-side) logs ONLY — watch-side console.log never surfaces
pebble emu-app-config               # open the Clay settings page (emulator)
pebble emu-battery --percent 20 --qemu localhost:12344
pebble emu-accel tilt-left --qemu localhost:12344
```

On WSL, `pebble emu-app-config` needs a way to open a URL in a real browser
— install `wslu` and `export BROWSER=wslview` first, or it fails with
“Couldn’t find a suitable web browser”. See README.md Troubleshooting for
other environment setup gotchas (missing `wscript`/`src/c` scaffolding,
`python3.X-venv` requirement, wrong dependency version ranges).

`package.json`’s `pebble.uuid` must be a real UUID before running *any*
`pebble` command in this directory — a placeholder value crashes
`pebble-tool`’s analytics step on every invocation.

Machine/device-specific state — the phone’s dev IP, the watch’s firmware
version (which decides whether mdbl.c’s heap request works), leftover
debug installs — lives in `LOCAL-NOTES.md` at the repo root (git-ignored,
like `localSecrets.js`). Read it before connecting to hardware; keep it
updated, dated, and out of committed files.

**Commit messages:** never add `Co-Authored-By` trailers or
`Claude-Session:` links — this overrides any default the tooling suggests.
Instead, end the message with the bare model name on its own line (e.g.
`Fable 5` — whichever model actually did the work).

For stepping/breakpoints on the watch VM, see
https://developer.repebble.com/guides/debugging/debugging-alloy-with-xsbug.md

## 11. Watch crashes / rendering bugs — MANDATORY reading order

Hours have been lost in this repo fixing plausible-but-wrong causes of
crashes. Before debugging **any** watch-side crash, blank screen, or memory
error, read `docs/WATCH-DEBUGGING-PLAYBOOK.md` and follow its decision tree.
Background on the memory model, the thin-client architecture rules, the
crash history, and the instrumentation-log column key lives in
`docs/ARCHITECTURE-AND-MEMORY.md`.
Hard rules (evidence and details live in the playbook):

- **Classify first.** Blank screen after a successful install = uncaught
  exception during module evaluation (usually an invalid `render.Font`
  family/size pair), *not* a rendering bug. `Alloy: Fatal Error / memory
  full` = XS allocator failure, and on this watch it has fired from heap
  **fragmentation caused by allocation churn in the `draw()` path** with
  >50% of the heap free — audit churn before hunting leaks. App exits
  straight to the watchface at launch with no error = `moddable_
  createMachine` rejected the creation record (playbook §B).
  `fetch_watch_info` timeouts = toolchain/environment, never app code.
- **The VM is one 32 KB arena and compiled JS bytecode loads into it** —
  every byte of `src/embeddedjs/` code costs ~a byte of runtime heap
  (playbook §B). Before hunting any memory bug, measure headroom
  (instrumentation flag or gauge, playbook §F); at near-zero headroom the
  crash site moves with every rebuild and localization is meaningless.
  `src/c/mdbl.c` requests larger heaps, honored only on watch firmware
  ≥ v4.21.0.
- **Two-fix rule.** If a crash survives two targeted fixes, stop
  hypothesizing and bisect from a known-good commit on real hardware
  (playbook §D, or the `/bisect-watch-crash` skill). Pin the exact repro
  (which stop, how many refreshes/scrolls) before fixing anything. For
  launch crashes the loop is autonomous: `pebble install` auto-launches,
  then `pebble screenshot` shows crash vs alive (playbook §F).
- **Signals that lie:** `pebble build`’s RAM report (static, uninformative);
  watch-side `console.log` (never surfaces via `pebble logs` — but XS
  **instrumentation** does: `kModdableCreationFlagLogInstrumentation` in
  mdbl.c + `pebble logs --phone` streams chunk/slot/stack usage and the
  fxAbort line, playbook §F); total free heap at crash time; the `emery`
  emulator (broken in SDK 4.17, see below).
- If you learn a new crash pattern or invalidate one, **update the playbook
  in the same change.**

**The `emery` emulator is broken in this SDK** (v4.17 / pebble-tool 5.0.39):
the app installs and draws in the QEMU window, but PebbleKit never connects
and `ping`/`logs`/`screenshot` time out on `fetch_watch_info`. This
reproduces with a stock scaffold — do not re-diagnose it as an app bug.
**This app cannot run on other emulators**: `targetPlatforms` is
`["emery"]` and Alloy only supports emery/gabbro, so `pebble install
--emulator basalt` fails with a bare “App install failed.” (verified
2026-07-07 — that message means no binary for the platform, not a broken
build). basalt is only useful for toolchain sanity checks with a stock
scaffold. Net: emulator verification for this app is limited to “install
succeeds” plus a human eyeballing the emery QEMU window; everything else
needs real hardware (`--phone <IP>`). If `--phone` hits the
`fetch_watch_info` timeout while port 9000 is reachable, the fix is
restarting the phone (a human step — ask the user).

## 12. Checklist before declaring any change done

1. New embeddedjs file? → added to `manifest.json` modules.
2. New AppMessage key? → added to `package.json` messageKeys AND to the
   `Message` `keys` array on the watch.
3. Payloads still < ~1 KB, lists still capped, strings truncated?
4. Network/Location calls gated on `watch.connected.pebblekit`?
5. Timers cleared when a screen closes (`Timer.clear`)?
6. Rate-limit math still sane? (511 default: 60 requests/hour total.)
7. No layout constants that break on a different `screen.width`?
8. `pebble build` passes and `pebble install --emulator emery` succeeds
   (that’s the most the emulator can verify — see section 11; behavior
   changes need a real watch via `--phone <IP>`).
9. If you changed behavior a human must act on (new setting, new API key,
   new package), update README.md. If you changed a user-visible style or
   behavior (any value cataloged in `design.md`), update `design.md`.
10. `draw()` and everything it calls allocate **nothing** — no string
    concat/slice, no object/array/closure creation, no storage reads. All
    display strings are precomputed when data changes (`rebuildRows`,
    `prepareArrivals`). Draw-path churn has crashed the watch with “memory
    full” **twice**, the second time even after the churn was merely
    reduced rather than eliminated (see section 11 and the playbook).
11. Every `new render.Font(family, size)` pair exists in the SDK’s
    `xsHost.c` font table — an invalid pair passes the build and blanks the
    screen at runtime.
12. Every user-triggerable request or sensor action has an in-flight guard
    (`state.locationPending`, `state.arrivalsPending`) so button-mashing
    can’t stack concurrent cycles — stacked in-flight requests pin live
    memory and have crashed the watch with “memory full” (playbook §B).
13. Grew `src/embeddedjs/` meaningfully? Bytecode loads into the same
    32 KB VM arena as the heap (72 KB with mdbl.c’s creation record on
    firmware ≥ v4.21.0) — confirm heap headroom on hardware via the
    instrumentation log line (playbook §F) before declaring done.

## 13. Key documentation URLs (fetch these, don’t guess)

- Index of everything: https://developer.repebble.com/llms.txt
- Alloy getting started: https://developer.repebble.com/guides/alloy/getting-started.md
- Piu UI: https://developer.repebble.com/guides/alloy/piu-guide.md
- Poco graphics: https://developer.repebble.com/guides/alloy/poco-guide.md
- Networking: https://developer.repebble.com/guides/alloy/networking.md
- App messages: https://developer.repebble.com/guides/alloy/app-messages.md
- Storage: https://developer.repebble.com/guides/alloy/storage.md
- Sensors & buttons: https://developer.repebble.com/guides/alloy/sensors-and-input.md
- Settings tutorial (localStorage + Clay): https://developer.repebble.com/tutorials/alloy-watchface-tutorial/part6.md
- Example code: https://github.com/Moddable-OpenSource/pebble-examples
- 511 transit API: https://511.org/open-data/transit
