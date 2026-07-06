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

Follow https://developer.repebble.com/sdk for your OS. Verify with:

```bash
pebble --version
```

Alloy projects require a recent SDK (4.9+). Update with the instructions on
that page if yours is older.

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

### 3. Install the two Pebble packages

From the project root:

```bash
pebble package install @moddable/pebbleproxy   # phone proxy (GPS/location)
pebble package install @rebble/clay            # settings page
```

### 4. Get a free 511.org API key

1. Request a token at https://511.org/open-data/token (email verification).
2. The key arrives by email. **Do not commit it to the repo** — you'll enter
   it in the app's settings page (step 6), and it's stored only on your phone.

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

### 7. Using the app

| Button | Stop list screen | Arrivals screen |
|---|---|---|
| Up / Down | Move selection | Manual refresh |
| Select | Open stop's arrivals | ★ favorite / unfavorite the stop |
| Back (press) | Re-run nearby search | Return to stop list |
| Back (hold) | Exit app | Exit app |

Favorites appear at the top of the list with a ★ and persist on the watch.

## Troubleshooting

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
