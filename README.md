# Transit Glance — Pebble Time 2 starter app + framework

Live Bay Area transit arrivals and departures on your wrist, NextBus-style:
the watch shows nearby stops (plus your ★ favorites), and opening a stop shows
live predictions that refresh automatically. Supports **SF Muni, BART,
AC Transit, Golden Gate Transit, and SamTrans** out of the box via the free
511.org regional API, with a settings toggle for each and a field to add any
other 511 operator (Caltrain, VTA, WETA ferries, …).

This repo doubles as a **boilerplate for future Pebble apps built with
Claude**: `CLAUDE.md` contains the machine-facing development guide
(environment rules, project conventions, doc links); this README covers the
tasks only a human can do. The app is written in **JavaScript** using
Pebble's modern **Alloy** framework (no C required).

```
├── README.md                 ← you are here (human setup tasks)
├── CLAUDE.md                 ← hand this to Claude when developing
├── package.json              ← app manifest (name, UUID, message keys)
├── docs/511-API-NOTES.md     ← transit API reference & quirks
└── src/
    ├── embeddedjs/           ← runs ON THE WATCH (UI, buttons, favorites)
    │   ├── manifest.json     ← every watch module must be listed here
    │   ├── main.js           ← screens, rendering, button handling
    │   ├── favorites.js      ← ★ favorites persisted in watch storage
    │   └── protocol.js       ← watch side of the watch↔phone protocol
    └── pkjs/                 ← runs ON YOUR PHONE (network, settings)
        ├── index.js          ← proxy + settings + request router
        ├── config.js         ← settings page (Clay)
        └── transit511.js     ← 511.org client (nearby stops, arrivals)
```

## Human-initiated tasks (do these once)

### 1. Install the Pebble SDK

The original Pebble SDK is defunct (Pebble Inc. shut down in 2016); this
project uses the community **Rebble** toolchain. Full instructions for your
OS: https://developer.repebble.com/sdk

**Verified path on Ubuntu / WSL Ubuntu 22.04:**

```bash
sudo apt install nodejs npm libsdl2-2.0-0 libglib2.0-0 libpixman-1-0 \
                  zlib1g libsndio7.0 python3.10-venv
curl -LsSf https://astral.sh/uv/install.sh | sh   # installs uv (adds it to PATH)
uv tool install pebble-tool
pebble sdk install latest
```

(`python3.10-venv` isn't in Rebble's own docs, but `pebble sdk install` fails
without it — the SDK installer builds a Python venv that needs `ensurepip`.)

Verify with:

```bash
pebble --version   # expect: Pebble Tool v5.x (active SDK: v4.17 or newer)
```

Alloy projects require a recent SDK (4.9+).

**If you're on WSL**, also install a way to open URLs in your Windows
browser — `pebble emu-app-config` (step 5) and similar commands shell out to
`webbrowser.open_new()`, which fails inside WSL with no browser binary:

```bash
sudo apt install -y wslu
export BROWSER=wslview   # add to ~/.zshrc / ~/.bashrc to make permanent
```

### 2. Personalize the manifest

- In `package.json`, set `name`, `author`, and `displayName`.
- Generate a UUID and paste it into `pebble.uuid`:

  ```bash
  python3 -c "import uuid; print(uuid.uuid4())"
  ```

> **If the build complains about project scaffolding** (e.g. missing manifest
> fields): run `pebble new-project --alloy scratch`, compare its generated
> `package.json` / `src/embeddedjs/manifest.json` with this repo's, and merge
> any fields your SDK version expects — keeping this repo's `messageKeys`,
> `capabilities`, `dependencies`, and the `modules` list.
>
> This repo already includes the `wscript` and `src/c/mdbl.c` files that
> `pebble build`/`pebble package install` require for a `"moddable"`-type
> project — don't delete them even though this app has no hand-written C
> code; they're generic boilerplate the SDK's build system needs to exist.

> **Note:** until you replace the placeholder UUID above, running *any*
> `pebble` command from inside this directory will crash with `ValueError:
> badly formed hexadecimal UUID string` (pebble-tool tries to parse
> `package.json` for analytics on every invocation). Fix the UUID first.

### 3. Install the two Pebble packages

From the project root:

```bash
pebble package install @moddable/pebbleproxy   # phone proxy (GPS/location)
pebble package install @rebble/clay            # settings page
```

### 4. Get a free 511.org API key

1. Request a token at https://511.org/open-data/token (email verification).
2. The key arrives by email. **Do not commit it to the repo.** Copy
   `.env.example` to `.env` and paste the key in as `TRANSIT_511_API_TOKEN`:

   ```bash
   cp .env.example .env
   # then edit .env and set TRANSIT_511_API_TOKEN=<your key>
   ```

   `.env` is git-ignored. Then run:

   ```bash
   node scripts/inject-api-key.js
   ```

   This writes `src/pkjs/localSecrets.js` (also git-ignored), which
   `index.js` uses to pre-fill the Clay settings page's API key field the
   first time you open it — before you've saved anything for real. Re-run
   the script whenever you change `.env`, and before `pebble build` (the
   phone JS runtime has no `process.env`, so this has to happen on the
   host). This is purely a local dev convenience — the key you actually
   ship with is whatever's saved via the settings page (step 6), and it's
   stored only on your phone, never on the watch or in the repo.

Note the default limit: **60 API requests per hour per key**. The app is
designed around this (stop lists cached for 7 days; arrivals refresh at most
once per minute), but if you hammer refresh you can hit it. You can email
511 (address on their open-data page) to request a higher limit.

### 5. Build and try it in the emulator

```bash
pebble build
pebble install --emulator emery      # emery = Pebble Time 2
pebble logs --emulator emery         # watch + phone console output
```

Open the settings page in the emulator to enter your API key:

```bash
pebble emu-app-config
```

Paste the API key, choose agencies, save. The emulator reports a simulated
location; on real hardware your phone's GPS is used.

### 6. Install on your Pebble Time 2

1. On your phone, open the Pebble app → enable the **Developer Connection**
   (see https://developer.repebble.com/guides/tools-and-resources/developer-connection.md)
   and note the phone's IP address.
2. With phone and computer on the same Wi-Fi:

   ```bash
   pebble install --phone <PHONE_IP>
   ```

3. In the Pebble phone app, open Transit Glance's **settings (gear icon)**,
   enter your 511 API key, pick your agencies, save.

**Rebuilding after code changes:** once the app is already installed on your
watch, pushing an update is the same install command — no uninstall step
needed, it just overwrites the previous version:

```bash
pebble build
pebble install --phone <PHONE_IP>
pebble logs --phone <PHONE_IP>        # optional: watch + phone console output
```

Developer Connection must still be toggled on and the Pebble app in the
foreground on the phone, or `pebble install` fails with
`[Errno 111] Connection refused`.

### 7. Using the app

| Button | Stop list screen | Arrivals screen |
|---|---|---|
| Up | Move selection (refresh nearby stops if already at top) | Manual refresh |
| Down | Move selection | Manual refresh |
| Select | Open stop's arrivals | ★ favorite / unfavorite the stop |
| Back | Exit app | Return to stop list |

Favorites appear at the top of the list with a ★ and persist on the watch.

## Troubleshooting

For watch-side crashes, blank screens, and memory errors, the canonical
guide is [docs/WATCH-DEBUGGING-PLAYBOOK.md](docs/WATCH-DEBUGGING-PLAYBOOK.md)
— it classifies the known failure signatures and documents the debugging
workflow that actually works on this hardware. The list below covers
setup/environment issues.

- **"This project is very outdated, and cannot be handled by this SDK"** —
  `pebble-tool` requires a `wscript` file (and, for `"moddable"` projects, a
  `src/c/*.c` native entry point) to exist, even though this app is pure
  JS. Already present in this repo; if you deleted them, regenerate with
  `pebble new-project --alloy scratch` and copy `wscript` + `src/c/mdbl.c`
  back in unmodified.
- **`npm error notarget No matching version found for @moddable/pebbleproxy@^1.0.0`**
  (or similar for `@rebble/clay`) — the version range in `package.json`
  doesn't match anything published. Check the real versions with
  `npm view @moddable/pebbleproxy versions` / `npm view @rebble/clay versions`
  and use the latest in `package.json`'s `dependencies`.
- **`pebble sdk install` fails building a venv** ("ensurepip is not
  available") — install `python3.10-venv` (or your system's matching
  `python3.X-venv` package) and retry.
- **`pebble emu-app-config` (or anything else browser-based) fails with
  "Couldn't find a suitable web browser"** — expected on a fresh WSL
  install with no browser binary. Install `wslu` and
  `export BROWSER=wslview` so it opens in your Windows browser instead. If
  you additionally hit `TypeError: NamedTemporaryFile() got an unexpected
  keyword argument 'delete_on_close'`, that's a `pebble-tool` bug on Python
  <3.12 (it uses a 3.12-only kwarg) — remove that argument from
  `open_config_page` in the installed `pebble_tool/util/browser.py`, or
  upgrade to Python 3.12+ for `pebble-tool`'s own venv.
- **"Set API key in app settings"** — step 4/6 not done, or the key was
  mistyped. Keys are UUID-shaped strings.
- **"Rate limited"** — you exceeded 60 requests/hour. Wait, or request a
  higher limit from 511.
- **First nearby search is slow** — the phone downloads and caches each
  enabled agency's full stop list on first use (Muni's is ~3,500 stops).
  Subsequent searches are instant and offline. Disable agencies you don't
  ride to speed up the cold start.
- **Module-not-found error at runtime on the watch** — a file in
  `src/embeddedjs/` isn't listed in `src/embeddedjs/manifest.json`.
- **A stop shows "No arrivals"** — some 511 operators only publish
  predictions for stops with imminent service; BART predictions are
  station-level. Also verify the agency's operator code against
  `https://api.511.org/transit/operators?api_key=KEY&format=json`.
- **Nothing loads on real hardware** — confirm the watch is connected to the
  phone and the Pebble app is running; the watch's network and GPS both go
  through the phone.
- **`Alloy: Fatal Error / memory full` on the watch** — a genuine XS
  allocator failure (distinct from a plain crash), but on this watch it
  showed up despite plenty of *total* free heap — the real cause was
  fragmentation, not exhaustion. The concrete culprit found here: `main.js`'s
  `ellipsize()` used to trim long names one character at a time, doing a
  fresh string concat *and* a fresh substring on every character trimmed —
  dozens of throwaway allocations per call, run for every row on every
  `draw()`. Busy stops (more/longer text) and heavy scrolling/refreshing (more
  `draw()` calls) made it measurably worse, matching what looked like a
  vague, session-length-dependent memory leak. Fixed by binary-searching the
  cut point instead (O(log n) allocations instead of O(n)). General lesson
  for this codebase: watch RAM is small enough that repeated small
  allocations inside anything called from `draw()` are worth auditing, even
  when the *total* memory used looks nowhere near the limit.
- **`pebble install --phone`/`pebble ping` time out on `fetch_watch_info`,
  even though the Developer Connection port (9000) is reachable** — the
  request goes out but nothing ever comes back; this is a stuck watch↔phone
  Bluetooth session, not a code or network-routing problem. Escalating fixes,
  roughly in order of least to most disruptive: confirm the watch shows
  "Connected" (not just paired) in the Pebble app; toggle Developer
  Connection off and back on; force-quit and reopen the Pebble app; toggle
  the phone's Bluetooth radio off/on at the OS level; fully unpair and
  re-pair the watch. If none of those clear it, a full **phone restart** is
  the next step and has fixed this outright in testing here.
- **`pebble install --emulator emery` never connects** — the watch draws its
  first screen fine, but `watch.connected.pebblekit` never goes true and
  every `pebble-tool` command needing a live connection (`ping`, `logs`,
  `screenshot`) times out identically. Verified with a stock, unrelated Alloy
  scaffold app: it hits the exact same wall on `emery` while connecting
  instantly on `--emulator basalt`. This is a `qemu-pebble`/`pebble-tool`
  limitation with Pebble Time 2 (`emery`) emulation in this SDK release, not
  an app bug — for Pebble Time 2 development, test on real hardware via
  `pebble install --phone <PHONE_IP>` instead.

## Extending

- **More agencies (Bay Area):** just type extra 511 operator codes (e.g.
  `CT` Caltrain, `SC` VTA) into the "Extra agency codes" setting — no code
  changes needed.
- **Other regions / providers:** implement a sibling of
  `src/pkjs/transit511.js` exporting `findNearbyStops()` and `getArrivals()`
  with the same shapes, then switch providers in `src/pkjs/index.js`. The
  watch code is provider-agnostic.
- **New features with Claude:** open this repo and point Claude at
  `CLAUDE.md`. It encodes the environment rules (two JS runtimes, manifest
  modules, message-size limits, rate-limit budget) plus a pre-flight
  checklist, so generated changes stay buildable.

## Data attribution

Transit data © 511 SF Bay / Metropolitan Transportation Commission.
511.org requires acknowledgement as the data provider in published apps.
