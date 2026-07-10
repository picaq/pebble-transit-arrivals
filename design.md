# design.md — Transit Glance: styles & behaviors catalog

Every user-visible style and behavior in the app, where it lives in the
code, and what to watch out for when changing it. Line numbers are
approximate (as of 2026-07-08); the constant names are the stable anchors.

**Keep this file current:** any change to a value documented here must
update this file in the same commit.

Two hard constraints apply to almost everything below (details in
CLAUDE.md §11–12 and `docs/WATCH-DEBUGGING-PLAYBOOK.md`):

1. **`draw()` allocates nothing.** New styles must not add string
   concatenation, object creation, or storage reads to the draw path —
   precompute in `prepareArrivals()` / `setRowsFromResponse()` /
   `fitVisibleRows()` instead.
2. **Every `new render.Font(family, size)` pair must exist in the SDK
   font table.** An invalid pair builds fine and blanks the screen at
   runtime. Check
   https://developer.repebble.com/guides/app-resources/system-fonts.md
   before changing a size.

## 1. Screens

| Screen | What it shows | Entry / exit |
|---|---|---|
| LIST (`MODE_LIST`) | Header "Transit Glance", then favorites (★, nearest first, dimmed when nothing is arriving, hidden entirely beyond the hide-distance setting) followed by nearby stops | App start; Back from ARRIVALS |
| ARRIVALS (`MODE_ARRIVALS`) | Header = truncated stop name, up to ~3 arrival rows, footer favorite hint | Select on a list row; Back returns |

All rendering is Poco (immediate mode, full redraw) in
`src/embeddedjs/main.js`. Switching to Piu is possible but is an
architecture change, not a style tweak (CLAUDE.md §4). The watch is a pure
thin client: rows arrive from the phone pre-merged, pre-sorted, and
pre-formatted (including the ★ `f` flag and dim `m` flag); the watch only
fits text to the screen and handles buttons.

## 2. Fonts (`src/embeddedjs/main.js:32-37`)

| Constant | Family, size | Used for |
|---|---|---|
| `fontHeader` | Gothic-Bold 18 | Header bar title |
| `fontRow` | Gothic-Bold 18 | List row title (stop name) |
| `fontSub` | Gothic-Regular 14 | Subtitles, destination line, status text, footer hint |
| `fontBig` | Leco-Bold 26 | Minutes number on arrivals rows |
| `fontNow` | Leco-Bold 20 | The "Now" label (smaller so it fits the minutes column) |
| `fontLine` | Gothic-Bold 24 | Route/line number on arrivals rows |

Available families: Gothic (regular/bold), Bitham, Roboto, Leco (best for
numbers), Droid — **only specific sizes exist per family** (constraint 2
above). If you grow a font, re-check the row-height metrics in §4 and the
hardcoded text y-offsets in `draw()` (`y + 2`, `y + 22`, `y + 26`).

## 3. Colors (`src/embeddedjs/main.js:39-72`)

| Constant | RGB | Used for |
|---|---|---|
| `BLACK` | 0,0,0 | Row titles, minutes numbers |
| `WHITE` | 255,255,255 | Screen background; text on accent |
| `ACCENT` | 0,85,255 (blue) | Header bar, selected-row highlight |
| `GRAY` | 120,120,120 | Dimmed rows (title + subtitle), status text, footer hint |
| `SUB_GRAY` | 60,60,60 | List subtitles (non-dim rows) and destination text on arrivals — higher contrast than GRAY |
| `LINE_COLORS` | 6 colors: blue, red, green, purple, orange, teal | Route numbers without a color code, assigned by string hash (`colorForLine`) so e.g. "38" vs "38R" read apart |
| `LINE_COLOR_CODES` | g 0,140,60 · y 215,170,0 · r 200,30,30 · o 210,110,0 · b 0,90,200 | Route names whose arrival carries a color code `k` from the phone — today that's BART's color-named lines, drawn in their line color (full name on the arrivals screen). Yellow is darkened for readability on white |

Change the palette freely — colors are `render.makeColor(r,g,b)` calls,
created once at module load (never in `draw()`). Selected rows are always
white-on-ACCENT regardless of dim state, so keep ACCENT dark enough for
white text.

## 4. Layout metrics (`src/embeddedjs/main.js:74-86`)

| Constant | Value | Meaning |
|---|---|---|
| `HEADER_H` | 28 px | Header bar height (fits Gothic-Bold 18 at y=4) |
| `ROW_H` | 40 px | List row height (title at y+2, subtitle at y+22) |
| `ARRIVAL_ROW_H` | 44 px | Arrivals row height (line at y, dest at y+26) |
| `VISIBLE_ROWS` | derived | `floor((screen.height − HEADER_H) / ROW_H)` |
| `LIST_TEXT_W` | derived | `screen.width − 12` — list text budget before ellipsizing |
| `ARRIVAL_TEXT_X` | derived | Minutes-column width: width of "88" in `fontBig` + margins |
| `ARRIVAL_TEXT_W` | derived | Remaining width for line/destination text |

Everything derives from `screen.width`/`screen.height` — keep it that way
(no absolute pixel positions; CLAUDE.md §12 item 7). Footer hint draws at
`screen.height − 18` and can overlap the last arrivals row on busy stops;
the arrivals loop only breaks when a row would overflow the screen, not
when it would hit the footer.

**Clock overlay** (all screens): the current time draws bottom-right on the
same `screen.height − 18` line as the footer hint, right-aligned to
`screen.width − 4`, in `fontSub` over a background box, and is
drawn **last** in `draw()` so it hovers on top of any row or the favorite
hint behind it (the box keeps it legible). On the LIST screen it can cover
the tail of the bottom row; that overlap is intended. Normally the box is
white with `BLACK` text, but when the selected row is the one the clock sits
over (the bottom-most visible row, filled in `ACCENT` blue) the box switches
to `ACCENT` with `WHITE` text so the clock blends into the selection instead
of punching a white hole in it — the overlap is detected geometrically
in-frame (does the selected row's rect reach the clock band), so it stays
allocation-free. `updateClock()` is
driven by `watch.addEventListener("secondchange", …)` and gated on the
minute so it only reformats/redraws once a minute; `timeX` is remeasured
in-frame (via the `timeDirty` flag) so steady-state draws still allocate
nothing.

## 5. Static strings

| Text | Where |
|---|---|
| Header title "Transit Glance" | `draw()`, `main.js:186` |
| "★ favorited — Select to remove" / "Select to ★ favorite" | `HINT_IS_FAV` / `HINT_NOT_FAV`, `main.js:87-88` |
| "Loading…", "Finding stops…", "No stops nearby", "No arrivals", "Connecting…", "Waiting for phone…", "Error: …" | `state.status` / `state.arrivalsStatus` setters throughout `main.js` |
| "Set API key in app settings", "No phone location", "Bad API key", "Rate limited", "Network error", "511 timeout" | phone side: `src/pkjs/index.js`, `src/pkjs/transit511.js` |
| "Now" (arrival due) | `prepareArrivals()`, `main.js:234` |
| Clock time (bottom-right, all screens; 12-hour, no leading zero, no AM/PM, e.g. "3:45") | `updateClock()`, `main.js` — see §4 clock overlay |
| BART line names ("Green", "Yellow", "Red", "Orange", "Blue") | compressed to G/Y/R/O/B initials on the **phone** (`bartLineLetter()`, `transit511.js:231`) in **list subtitle tokens only** — the arrivals screen keeps the full name, drawn in the matching line color via the `k` code (see §3); "Beige" (Coliseum–OAK) passes through untouched |
| Subtitle format `"SF · 320 m · IB/OB · 8,45,30+"` (agency · distance · direction(s) · serving lines, or `· no arrivals` when dimmed) | built on the **phone**, `buildRows()` + `dirLinesSuffix()` in `src/pkjs/index.js`; distance formatting in `formatDistM()` (meters under 1 km, else `x.y km`); direction/lines from the agency-wide stop-info map (`getStopInfo()`, `transit511.js`) — directions capped at 2, lines capped by a 14-char budget (`LINES_CHAR_BUDGET`; `+` marks more — all of BART's one-letter lines fit, four-char tokens cap around three), line tokens sliced to 4 chars |
| Settings-page labels & descriptions (incl. "Favorite stops" section, "Hide favorites beyond (km)") | `src/pkjs/config.js`; dynamic favorites section built in `showConfiguration`, `index.js:118-138` |

Watch-side strings cost heap; keep them short. Subtitle/label formatting
changes belong on the phone, not the watch (thin-client rule).

## 6. Button behavior (`src/embeddedjs/main.js:358-397`)

| Button | LIST screen | ARRIVALS screen |
|---|---|---|
| Up | Move selection up; **at top: pull-to-refresh** (re-run nearby search) | Manual refresh |
| Down | Move selection down | Manual refresh |
| Select | Open arrivals for highlighted stop | Toggle ★ favorite **visibility** (never deletes) — sends a `fav` request to the **phone** (which owns the list); footer hint updates when the reply lands |
| Back | Exit app (`watch.exit()`) | Return to list |

Actions fire on press (`down === true`), releases ignored. Because
`"back"` is registered, single-tap auto-exit is replaced — LIST-screen
exit is restored manually via `watch.exit()`. Any new button-triggered
request **must** keep its in-flight guard (`state.nearbyPending`,
`state.arrivalsPending`, `state.favPending`) — button-mashing without one
has crashed the watch (CLAUDE.md §12 item 12).

## 7. Timing & refresh cadence

| Behavior | Value | Where |
|---|---|---|
| Arrivals auto-refresh while screen open | 60 s | `Timer.repeat` in `openArrivals()`, `main.js:305` |
| Phone-side full-arrivals cache (absorbs manual + auto refresh) | 45 s | `ARRIVALS_TTL_MS`, `transit511.js:367` |
| Agency-wide stop-info cache (lines/directions per stop + favorite has-arrivals) | 10 min | `STOP_INFO_TTL_MS`, `transit511.js:244` — one StopMonitoring call per agency, no stopcode |
| Stop-list cache | 7 days | `STOP_CACHE_TTL_MS`, `transit511.js:38` |
| Watch request timeout | 15 s | `REQUEST_TIMEOUT_MS`, `protocol.js:48` |
| Phone HTTP timeout | 20 s | `getJSON()`, `transit511.js:45` |
| Geolocation | low accuracy, 10 s timeout, 2 min max age | `handleRequest()`, `index.js:302` |

**Rate-limit math before changing any of these:** 511 allows 60
requests/hour total. The 60 s auto-refresh + 45 s cache pair means one
open arrivals screen costs ≤ 60/hr worst case by itself — shortening
either value can blow the budget (CLAUDE.md §12 item 6). Cached arrivals
still tick down correctly (absolute times recomputed at serve time), so a
longer cache degrades freshness less than you'd expect.

## 8. Favorites (owned by the PHONE)

Favorites live in phone localStorage (`favorites.v1` —
`[{agency, code, name, hide?}]`), not on the watch. **Star toggles are
visibility, never deletion**: Select on the watch's arrivals screen and
the settings page's show/hide toggles both flip the `hide` flag (a brand
new star creates the record). A hidden favorite's stop can still appear
as an ordinary unstarred nearby row when physically close — starring it
there unhides it. Deletion is settings-page only: per-favorite 🗑
toggles, confirmed by a dialog at save time (`clayCustomFn`).

| Behavior | Value | Where |
|---|---|---|
| Max favorites stored | 20 (storage cap — hidden records accumulate until trashed) | `MAX_FAVORITES`, `index.js` |
| Hide a favorite from the list | (a) farther than `hideFavKm` setting (default 19 km / ~12 mi) — reappears when near; (b) `hide` flag (watch unstar or settings toggle). Both keep it saved and cost no payload bytes or API calls while hidden | `buildRows()` + `maxCheckM` arg to `getFavoriteStatus()`, `index.js` / `transit511.js` |
| Delete a favorite | settings page 🗑 toggle + save; `window.confirm` dialog in the webview (degrades to no-dialog if Clay's DOM changes — see `clayCustomFn`) | `showConfiguration` / `webviewclosed`, `index.js` |
| Dim a favorite | nothing currently arriving (subtitle gains "· no arrivals"); determined by absence from the agency-wide stop-info map — no per-favorite API calls | `buildRows()`, `index.js`; `getStopInfo()`, `transit511.js` |
| New favorite position | added to the front of the saved list | `fav` handler, `index.js` |
| One-time migration | the watch sends its legacy watch-side `favorites.v1` JSON with nearby requests (`mig` field) until one succeeds, then deletes it | `main.js`, `importLegacyFavs()` in `index.js` |

## 9. List content & caps

| Behavior | Value | Where |
|---|---|---|
| Row order | favorites (nearest first) then nearby stops (nearest first) | `buildRows()`, `index.js` |
| Nearby stop count | `maxStops` setting (default 8), extended through dense clusters, hard ceiling 14 | `selectNearbyStops()` + `HARD_STOP_CEILING`, `transit511.js:149-170` |
| Search radius | `radiusM` setting, default 500 m | settings, `index.js:31` |
| Rows payload budget | 880 B (raised from 700 when subtitles grew direction/lines) — farthest non-favorite stops shed first, favorites never shed | `buildRows()`, `index.js` |
| Arrivals per stop | max 6 | parse loop, `transit511.js:413` |

## 10. Text truncation lengths

| Text | Cap | Where |
|---|---|---|
| Nearby stop name | 28 chars (16 when >8 stops selected) | `transit511.js:213`, `:194` |
| Favorite name from cached stop list | 24 chars (falls back to the saved favorite name on a cache miss) | `transit511.js:321`, `buildRows()` |
| Arrivals header (stop name) | 18 chars | `shortName()`, `main.js:243` |
| Route/line | 10 chars (BART: 1-letter initials in list subtitles only, see §5) | `transit511.js:423` |
| Destination | 24 chars | `transit511.js:428` |

On-screen fitting on top of these caps is `ellipsize()` (binary-search,
called only inside `begin()/end()`, results cached per row). Raising the
phone-side caps raises payload size — re-check the 880 B budget in §9.

## 11. Settings (Clay — `src/pkjs/config.js`, defaults `index.js:28-34`)

| Setting | Default | Notes |
|---|---|---|
| `apiKey` | "" (dev: seeded from `localSecrets`) | Phone-only, never sent to watch |
| `agencies` | SF, BA, AC, GG, SM | Checkboxes + free-form `ExtraAgencies` codes |
| `radiusM` | 500 | Nearby search radius |
| `maxStops` | 8 | Soft cap, see §9 |
| `hideFavKm` | 19 (slider 1–100) | Favorites beyond this are left off the watch list, see §8 |
| Favorite stops section | dynamic | Per saved favorite: a `Show_<agency>_<code>` show/hide toggle (sets/clears `hide`) plus a `Del_<agency>_<code>` 🗑 delete toggle (confirmed at save). Appended before the submit button each time the page opens (`showConfiguration`) |

Settings live on the phone only; the watch just gets a `SettingsChanged`
ping and re-runs the nearby search. To add one: `config.js` field →
`webviewclosed` reader → `DEFAULT_SETTINGS` (CLAUDE.md §8).

## 12. Startup behavior (`main.js:401-407`)

- Before the first response the list is empty with status "Connecting…"
  (or "Waiting for phone…" if pebblekit isn't connected) — the watch keeps
  no persistent data, so there is nothing to render until the phone
  answers.
- The **phone initiates** the first fetch via a `SettingsChanged` ping
  from its `ready` handler — the watch never requests at boot (race, see
  CLAUDE.md §6). Recovery if the ping is lost: Up at the top of the list.
