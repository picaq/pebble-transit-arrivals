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
| LIST (`MODE_LIST`) | Header "Transit Glance", then favorites (★, nearest first, hidden entirely beyond the hide-distance setting) followed by nearby stops; any row — favorite or not — is dimmed when nothing is arriving | App start; Back from ARRIVALS |
| ARRIVALS (`MODE_ARRIVALS`) | Header = truncated stop name, scrollable arrival rows (~4 visible, `VISIBLE_ARRIVALS`), footer favorite hint | Select on a list row; Back returns |

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
| `fontLine` | Gothic-Bold 24 | Route/line number on arrivals rows |
| `fontNarrow` | Leco-Bold 20 | Minutes-column entries that don't fit `fontBig`: the "Now" label and any wait of 100+ minutes (the phone never caps `min`). Smallest Leco size, so it matches `fontBig`'s typeface (user preference, 2026-07-12); its extra width over the old Gothic-Bold 24 alias is absorbed by `ARRIVAL_MIN_EDGE` (§4). Costs a second Font object of watch heap — paid for by removing the watch-side favorites-migration sender. Gothic-Bold 24 (fontLine alias, free but mismatched) and Bitham-Black (only size is 30pt; bleeds into route number and destination) were both tried and rejected |

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
| `HEADER_PAD` | 6 px | Side margin inside the blue bar, matching the row margin |
| `HEADER_BUSY_W` | derived | Width of the "…" refresh indicator + gap. Reserved out of the title budget because `drawHeader()` draws it *after* the centered title, so a full-width title would otherwise push it off the bar |
| `HEADER_TEXT_W` | derived | `screen.width − 2·HEADER_PAD − HEADER_BUSY_W` — the header title's ellipsize budget. The title is centered, so this alone decides when a stop name truncates |
| `ROW_H` | 40 px | List row height (title at y+2, subtitle at y+22) |
| `ARRIVAL_ROW_H` | 44 px | Arrivals row height (line at y, dest at y+26) |
| `VISIBLE_ROWS` | derived | `floor((screen.height − HEADER_H) / ROW_H)` |
| `LIST_TEXT_W` | derived | `screen.width − 12` — list text budget before ellipsizing |
| `ARRIVAL_MIN_EDGE` | derived | Shared right-alignment edge for ALL minutes strings (units digits line up to the pixel; user mock, 2026-07-12): `6 + max(width("88", fontBig), width("888", fontNarrow) − 1)` — a 3-digit wait may overhang the 2-digit edge by 1 px. Per-row `a.minX` (in-frame lazy-fit block) right-aligns each string to it, with +1 px for `fontNarrow` strings (their ink sits 1 px left of fontBig's at equal advance, user-tuned) and +2 px more for waits whose last digit is 1 (the "1" glyph leaves its right side of the advance empty; realigns on refresh when it ticks down — user-tuned) |
| `ARRIVAL_TEXT_X` | derived | `ARRIVAL_MIN_EDGE + 9` — one fixed column for every route number and destination (no per-row pushing; 9 not 10 is user-tuned) |
| `NOW_X` / `NOW_NO_X` / `NOW_W_X` / `NOW_SLIVER_X` | derived | The "Now" label's draw positions, all module constants and all hardware-measured/user-tuned 2026-07-12: right-aligned to `ARRIVAL_MIN_EDGE` then +2 px (`fontNarrow`'s +1 plus one more); drawn as a split "No"+"w" with "No" kerned +1 px toward the "w" (tightens the o–w gap); a 1×14 px sliver at `NOW_X+41`, `y+3` completes Leco-20's lowercase-w final stroke (the glyph bitmap is one column short — 2 px wide vs 3 for every other stroke; uppercase "NOW" was rejected: the "W" has angled strokes). Do not replace with a single `drawText("Now")` |
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
allocation-free. `updateClock()` is driven by a **minute-aligned `Timer`**
(`Timer.set` to the next minute boundary, then `Timer.repeat(…, 60000)`) —
**not** a `secondchange` listener. A per-second wakeup churned ~80 B/s of
heap for a display that only changes once a minute, which pushed the tiny
chunk heap to near-zero free at every GC peak and was the cause of "memory
full" crashes during normal use (playbook §B; measured chunk-free jumped
from ~124 B to ~1.9 KB after the switch). `timeX` is remeasured in-frame
(via the `timeDirty` flag) so steady-state draws still allocate nothing.

## 5. Static strings

| Text | Where |
|---|---|
| Header title "Transit Glance" (+ "…" appended after the title while a refresh is in flight — both screens, the arrivals header gets it too; "…" because its glyph is proven in Gothic-Bold 18; arrow glyphs like ↻ are not in the font and render blank) | `drawHeader()` / `drawHeaderBusy()`, `main.js` |
| "★ hold Select to unfavorite" / "Select to ★ favorite" | `HINT_IS_FAV` / `HINT_NOT_FAV`, `main.js` |
| "Loading…", "Finding stops…", "No stops nearby", "No arrivals", "Connecting…", "Waiting for phone…", "Error: …" | `state.status` / `state.arrivalsStatus` setters throughout `main.js` |
| "Set API key in app settings", "No phone location", "Bad API key", "Rate limited", "Network error", "511 timeout" | phone side: `src/pkjs/index.js`, `src/pkjs/transit511.js` |
| "Now" (arrival due) | `prepareArrivals()`, `main.js:234` |
| Clock time (bottom-right, all screens; 12-hour, no leading zero, no AM/PM, e.g. "3:45") | `updateClock()`, `main.js` — see §4 clock overlay |
| BART line names ("Green", "Yellow", "Red", "Orange", "Blue") | compressed to G/Y/R/O/B initials on the **phone** (`bartLineLetter()`, `transit511.js:231`) in **list subtitle tokens only** — the arrivals screen keeps the full name, drawn in the matching line color via the `k` code (see §3); "Beige" (Coliseum–OAK) passes through untouched |
| Subtitle format `"SF · 320 m · IB/OB · 8,45,30+"` (agency · distance · direction(s) · serving lines, or `· no arrivals` when dimmed) | built on the **phone**, `buildRows()` + `dirLinesSuffix()` in `src/pkjs/index.js`; distance formatting in `formatDistM()` (meters under 1 km, else `x.y km`); direction/lines from the agency-wide stop-info map (`getStopInfo()`, `transit511.js`) — directions capped at 2, lines capped by a 14-char budget (`LINES_CHAR_BUDGET`; `+` marks more — all of BART's one-letter lines fit, four-char tokens cap around three), line tokens sliced to 4 chars |
| Settings-page labels & descriptions (incl. "Favorite stops" section, "Hide favorites beyond (km)") | `src/pkjs/config.js`; dynamic favorites section built in `showConfiguration`, `index.js:118-138` |

Watch-side strings cost heap; keep them short. Subtitle/label formatting
changes belong on the phone, not the watch (thin-client rule).

## 6. Button behavior (`src/embeddedjs/main.js:437-493`)

| Button | LIST screen | ARRIVALS screen |
|---|---|---|
| Up | Move selection up; **at top: pull-to-refresh** — the list **stays on screen AND stays interactive** (scroll/select keep working; blocking input for the round trip was rejected as bad UX) with a "…" indicator after the header title while a `fresh:1` rebuild runs. The rows stay live until the response **arrives**, then are released in `protocol.onBeforeParse` — synchronously before the parse — so the parse still lands beside freed heap (a rows parse needs >1.6 KB of chunk — playbook §B ninth recurrence); the framebuffer shows the old rows for the few ms until the rebuild repaints. Refresh resets scroll to the top | Scroll up; **at top: manual refresh** — frame-hold: arrivals are released at request time and `draw()` self-gates on `state.refreshing`, so input is frozen for the round trip (see §7) |
| Down | Move selection down; **at bottom: load more stops** — append the next page of farther stops (`fetchMore()` → phone `buildMoreRows`), up to `MAX_LIST_ROWS`=14 total, no refresh | Scroll down; **at bottom: load more arrival times** — raise the requested count (`state.arrLimit`, +`ARR_STEP` up to `ARR_MAX`=10), no refresh |
| Select | Open arrivals for highlighted stop | **Tap to ★ favorite; HOLD 0.5 s (`LONGPRESS_MS`) to unfavorite** — a stray tap on a starred stop does nothing (accidental unfavorites during fast use prompted this). The unfavorite fires **mid-hold at the threshold** (a `Timer` armed on press, cancelled by early release), so the footer hint flips while the button is still down; releasing early cancels. Toggles **visibility** only (never deletes) via a `fav` request to the **phone** (which owns the list) |
| Back | Exit app (`watch.exit()`) | Return to list |

Neither screen refreshes on **Down** anymore (it was a wasted API call): Down
always means "show me more" — more stops (wider radius) on the list, more
arrivals on the arrivals screen. Manual refresh survives only as **Up at the
very top** of either screen. The arrivals screen is scrollable
(`state.arrTop`, `VISIBLE_ARRIVALS` rows visible). "Load more" **appends** on
both screens (more stops / more arrivals) rather than widening a radius, so
it keeps working in dense areas; both are bounded by the caps in §9
(`MAX_LIST_ROWS`, `ARR_MAX`) and each AppMessage page still fits the 880 B
payload — the watch accumulates the pages in RAM.

Both manual-refresh paths (Up at the top of either screen) share a **3 s
cooldown** (`REFRESH_COOLDOWN_MS`, `state.refrOkAt`, main.js): the phone
answers from cache in ~200 ms, so the in-flight guards alone admitted ~5
full request cycles a second under a mashed Up and crashed the watch
(playbook §B, seventh recurrence). Presses inside the cooldown are no-ops.

Actions fire on press (`down === true`), releases ignored. Because
`"back"` is registered, single-tap auto-exit is replaced — LIST-screen
exit is restored manually via `watch.exit()`. Any new button-triggered
request **must** keep its in-flight guard (`state.nearbyPending`,
`state.arrivalsPending`, `state.favPending`) **and** a cooldown when the
response can arrive faster than a human can press (guards serialize, they
don't rate-limit) — button-mashing without them has crashed the watch
(CLAUDE.md §12 item 12; playbook §B/§G). Beneath all of that, protocol.js
**serializes every request** — one on the wire at a time, the rest queued
(playbook §B, twelfth recurrence) — so rapid cross-action presses (e.g.
open a stop, then instantly favorite it) cost a moment of latency rather
than concurrent memory.

## 7. Timing & refresh cadence

| Behavior | Value | Where |
|---|---|---|
| Arrivals auto-refresh while screen open | 60 s | `Timer.repeat` in `openArrivals()`, `main.js:305` |
| Arrivals frame-hold on every fetch (manual, "load more", auto-refresh) | duration of the round trip (~1–2 s warm) | `fetchArrivals()`, `main.js` — the current arrivals are **released before** the request so the response parses beside an empty list (playbook §B tenth recurrence); the frame stays on screen with the header "…" indicator, and the scroll position survives the reload |
| Manual-refresh cooldown (Up at top, both screens) | 3 s | `REFRESH_COOLDOWN_MS`, `main.js` — see §6 |
| Phone-side full-arrivals cache (absorbs manual + auto refresh) | 45 s | `ARRIVALS_TTL_MS`, `transit511.js:367` |
| Agency-wide stop-info cache (lines/directions per stop + favorite has-arrivals) | 10 min | `STOP_INFO_TTL_MS`, `transit511.js:244` — one StopMonitoring call per agency, no stopcode. These per-agency calls are fired **concurrently** (not serially) in `buildRows`/`getFavoriteStatus` — the sequential version was the main field latency |
| Persisted rows list (serve-as-final) | 3 min (`ROWS_FRESH_MS`) | `index.js` — a plain `nearby` request is answered instantly from this cache **as final: no `stale:1`, no revalidation** (the watch's `scheduleRevalidate()` machinery remains in `main.js` but never triggers). The deferred-revalidation design (stale:1 → fresh follow-up 5 s later, eleventh recurrence) died 2026-07-12: its second full rows parse ~11 s into boot aborted "memory full" deterministically at the fully-carved arena (playbook §B, sixteenth recurrence). Past 3 min the cache is treated as a miss and the launch takes the normal single-parse fresh path (a "Locating…" wait instead of an instant list). Freshness beyond that is manual: pull-to-refresh sends `fresh:1` directly (seventh recurrence). Widened ("load more") lists are not cached |
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
| Hide a favorite from the list | (a) farther than `hideFavKm` setting (default 19 km / ~12 mi) — **× `railRadiusX` for BART/Caltrain favorites** (`RAIL_AGENCIES` = BA, CT; `getFavoriteStatus` computes the per-agency line and returns `far:1`, so rail knowledge stays inside the provider) — reappears when near; (b) `hide` flag (watch unstar or settings toggle). Both keep it saved and cost no payload bytes or API calls while hidden | `buildRows()` + `maxCheckM` arg to `getFavoriteStatus()`, `index.js` / `transit511.js` |
| Delete a favorite | settings page 🗑 toggle + save; `window.confirm` dialog in the webview (degrades to no-dialog if Clay's DOM changes — see `clayCustomFn`) | `showConfiguration` / `webviewclosed`, `index.js` |
| Dim a row (favorite or nearby stop) | nothing currently arriving (subtitle gains "· no arrivals"); determined by absence from the agency-wide stop-info map (skipped when that map failed to load — unknown stays undimmed) — no per-stop API calls | `buildRows()` + `buildMoreRows()`, `index.js`; `getStopInfo()`, `transit511.js` |
| New favorite position | added to the front of the saved list | `fav` handler, `index.js` |
| One-time migration | removed from the watch 2026-07-12 (completed on the only device this app runs on) to free bytecode; the phone still accepts a `mig` field on nearby requests | `importLegacyFavs()` in `index.js` |

## 9. List content & caps

| Behavior | Value | Where |
|---|---|---|
| Row order | favorites (nearest first, **capped at the 6 nearest** — `FAV_ROWS_MAX`; dist-unknown favorites sort last and cap out first) then nearby stops (nearest first); total capped at 14 (`WATCH_LIST_CAP`, mirrors the watch's `MAX_LIST_ROWS`). Capped-out favorites stay saved and reappear when nearer. 13 uncapped favorites once filled 1143 B alone and crashed the watch (playbook §B, fifteenth recurrence) | `buildRows()`, `index.js` |
| Nearby stop count | `maxStops` setting (default 8), extended through dense clusters, hard ceiling 14. **Down "load more" appends** farther stops up to `MAX_LIST_ROWS`=14 total on the watch (the phone paginates via `buildMoreRows`, `off` = non-favorites already shown, `hardCeiling` override on `selectNearbyStops` reaches past the default 14 candidates) | `selectNearbyStops()` + `HARD_STOP_CEILING`, `transit511.js`; `fetchMore()`, `main.js` |
| Search radius | `radiusM` setting, default 500 m for the page-0 list; "load more" paginates from a wider `MORE_RADIUS_M`=5000 m search so farther stops become reachable. The `railRadiusX` multiplier deliberately does **not** touch the nearby search — it extends favorites only (see §8); an earlier version appended unstarred far stations here and was reverted 2026-07-12 by user choice | settings, `index.js`; `buildMoreRows`, `index.js` |
| Rows payload budget | 880 B for page-0 lists (raised from 700 when subtitles grew direction/lines); **400 B for "load more" pages** (`MORE_BUDGET`, ≈5 stops/page — the one response parsed beside a retained full list, sized to the measured ~750 B worst-case free chunk, playbook §B thirteenth recurrence). Enforced on the **final serialized payload** in `respond()` (`id`/`stale:1` overhead included; budgeting before they were appended once put 884 B on the wire and crashed the watch mid-parse). The budget is **absolute**: farthest non-favorite stops shed first, then favorites farthest-first as last resort (shed floor is 1 row — "favorites never shed" let 13 favorites ship a 1143 B payload that crashed the watch parse, playbook §B fifteenth recurrence) | `respond()` + `MORE_BUDGET`, `index.js` |
| Arrivals per stop | default 6; **Down "load more" raises it** to `ARR_MAX`=10 (`req.lim` → `MAX_ARRIVALS` cap on the phone) | parse loop `transit511.js` (`limit`); `state.arrLimit`, `main.js` |

## 10. Text truncation lengths

| Text | Cap | Where |
|---|---|---|
| Nearby stop name | 28 chars at collection (payload bound), then the `compressStopName()` pipeline below to ≤20 (`LIST_NAME_MAX`) | `findNearbyStops()`, `transit511.js`; `compressStopName()`, `index.js` |
| Favorite name from cached stop list | 24 chars (falls back to the saved favorite name on a cache miss), then the same `compressStopName()` pipeline | `getFavoriteStatus()`, `transit511.js`; `buildRows()`, `index.js` |
| Arrivals header (stop name) | none — fitted to pixels (`HEADER_TEXT_W`), not chars. Was an 18-char cap (`shortName()`), which ellipsized names long before they reached the edges of the bar; the phone already caps names at 28/24 chars (rows above), so the header string stays bounded without it | fitted in `draw()`, `main.js` |
| Route/line | 10 chars (BART: 1-letter initials in list subtitles only, see §5) | `transit511.js:423` |
| Destination | 24 chars | `transit511.js:428` |

**Stop names are compressed, not cut** (`compressStopName()`, `index.js` —
applied to every list row in `buildRows`/`buildMoreRows`; the arrivals
header reuses the row's name, so it inherits this). The old rule — hard
16-char cut whenever the list exceeded 8 rows — spent the row's ~17
renderable chars on street-type words and killed the distinguishing cross
street ("Mansell St & San", user report 2026-07-12). The pipeline, each
step only if the name still exceeds `LIST_NAME_MAX` = 20: (1) abbreviate
street-type words everywhere ("Powell Street" → "Powell St"; this step is
unconditional), (2) drop street types that end an intersection segment
("San Bruno Ave & Mansell St" → "San Bruno & Mansell" — a leading
Saint-style "St" is safe: only a *trailing* type with a space before it is
dropped), (3) hard-cut at 20 and trim any dangling "&". Names already ≤20
keep their types, so "4th St & Market St" stays unambiguous (SF has both
4th St and 4th Ave); only too-long names trade that suffix for the cross
street. This must stay phone-side: a watch-side expansion dictionary would
cost bytecode = heap (playbook §B).

On-screen fitting on top of these caps is `ellipsize()` (binary-search,
called only inside `begin()/end()`, results cached per row **while the row
is in the visible scroll window and released once it scrolls away** — both
screens; a permanent cache retained ~1 KB of fitted duplicates on a full
list and crashed a refresh parse, playbook §B eighth recurrence). Raising
the phone-side caps raises payload size — re-check the 880 B budget in §9.

The truncation marker is a **period** (`TRUNC`, `main.js`), not an ellipsis:
the marker's width comes out of the text's budget, and a "." is several
pixels narrower than a "…", so more of the name survives. This is *not* the
same glyph as the "…" busy indicator in §5 — that one means "refresh in
flight" and stays an ellipsis.

## 11. Settings (Clay — `src/pkjs/config.js`, defaults `DEFAULT_SETTINGS` in `index.js`)

| Setting | Default | Notes |
|---|---|---|
| `apiKey` | "" (dev: seeded from `localSecrets`) | Phone-only, never sent to watch |
| `agencies` | SF, BA, AC, GG, SM | Checkboxes + free-form `ExtraAgencies` codes |
| `radiusM` | 500 | Nearby search radius |
| `railRadiusX` | 1 (slider 1–30) | BART/Caltrain **favorites** hide line = `hideFavKm` × this, see §8 (Clay description quotes examples for the 19 km default: 3× = 57 km … 30× = 570 km) |
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
- If the phone's rows cache is under 3 min old (`ROWS_FRESH_MS`), the
  first reply is that cached list, served as final — no revalidation
  follows (see §7's persisted-rows entry; the old 5 s deferred
  revalidation crashed the watch, playbook §B sixteenth recurrence).
  Older cache = the launch waits through the normal locate + fetch
  ("Connecting…" until the single fresh reply lands).
- The **phone initiates** the first fetch via a `SettingsChanged` ping
  from its `ready` handler — the watch never requests at boot (race, see
  CLAUDE.md §6). Recovery if the ping is lost: Up at the top of the list.
