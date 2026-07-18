# design.md — Transit Glance: styles & behaviors catalog

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
| LIST (`MODE_LIST`) | Header “Transit Glance”, then favorites (★, nearest first, hidden entirely beyond the hide-distance setting) followed by nearby stops; any row — favorite or not — is dimmed when nothing is arriving | App start; Back from ARRIVALS |
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
| `fontAgency` | Gothic-Bold 14 | The agency code leading each list subtitle (“**SF** · 320 m · …”), so it reads as a label rather than as the first word of the line. Same size as `fontSub`, so it shares that baseline and the rest of the subtitle simply starts after it (`row.agencyW`). The pair is in the SDK’s Alloy font table (`xsHost.c` — Gothic has a bold at 14/18/24/28/36); an absent pair builds fine and blanks the screen at runtime. Costs one more Font object of watch heap |
| `fontBig` | Leco-Bold 26 | Minutes number on arrivals rows |
| `fontLine` | Gothic-Bold 24 | Route/line number on arrivals rows |
| `fontNarrow` | Leco-Bold 20 | Minutes-column entries that don’t fit `fontBig`: the “Now” label and any wait of 100+ minutes (the phone never caps `min`). Smallest Leco size, so it matches `fontBig`’s typeface (user preference, 2026-07-12); its extra width over the old Gothic-Bold 24 alias is absorbed by `ARRIVAL_MIN_EDGE` (§4). Costs a second Font object of watch heap — paid for by removing the watch-side favorites-migration sender. Gothic-Bold 24 (fontLine alias, free but mismatched) and Bitham-Black (only size is 30pt; bleeds into route number and destination) were both tried and rejected |

Available families: Gothic (regular/bold), Bitham, Roboto, Leco (best for
numbers), Droid — **only specific sizes exist per family** (constraint 2
above). If you grow a font, re-check the row-height metrics in §4 and the
hardcoded text y-offsets in `draw()` (`y + 2`, `y + 22`, `y + 26`).

## 3. Colors (`src/embeddedjs/main.js:39-72`)

| Constant | RGB | Used for |
|---|---|---|
| `BLACK` | 0,0,0 | Row titles, minutes numbers |
| `WHITE` | 255,255,255 | Screen background; text on accent |
| `ACCENT` | 0,85,255 (blue) | Header bar, selected-row highlight |
| `GRAY` | 120,120,120 | Dimmed rows (title + subtitle), status text, footer hint |
| `SUB_GRAY` | 60,60,60 | List subtitles (non-dim rows) and destination text on arrivals — higher contrast than GRAY |
| `LINE_COLORS` | 6 colors: blue, red, green, purple, orange, teal | Route numbers without a color code, assigned by string hash (`colorForLine`) so e.g. “38” vs “38R” read apart |
| `LINE_COLOR_CODES` | g 0,140,60 · y 215,170,0 · r 200,30,30 · o 210,110,0 · b 0,90,200 | Route names whose arrival carries a color code `k` from the phone — today that’s BART’s color-named lines, drawn in their line color (full name on the arrivals screen). Yellow is darkened for readability on white |
| `AGENCY_COLORS` | SF 198,12,48 (Muni red) · BA 0,100,164 (BART blue) · CT 227,24,55 (Caltrain red) · AC 0,131,62 (AC Transit green) · GG 200,70,30 (Golden Gate orange) · SM 0,87,158 (SamTrans blue) · SB 0,150,160 (SF Bay Ferry teal — its livery is a blue, but BART/SamTrans already read as blue and AC as green, so a teal keeps the code distinct and evokes water) | The **agency code leading each list subtitle**, drawn in that operator’s brand color so “which system is this” reads before the text does. Approximations of each livery/wordmark, darkened where needed to stay legible as 14px text on white. Muni and Caltrain are both genuinely red, BART and SamTrans both genuinely blue — the two-letter **code** identifies the agency and the color only reinforces it. Applied **only on an ordinary row**: a selected row is white-on-accent (a dark brand blue on the blue bar would be unreadable) and a dimmed row stays uniformly gray, which is the entire signal that nothing is arriving. Unlisted agencies (any `ExtraAgencies` code) fall back to `SUB_GRAY`. Costs one precomputed row field (`row.agencyW`) so `draw()` still allocates nothing |
| `STAR_COLOR` | 240,165,15 (amber) | The favorite ★ on a list row, drawn as its own piece of the title so it can carry its own color — midway between yellow and orange, dark enough to hold up as a glyph on white. White when the row is selected (readable on the accent bar). It does **NOT** gray out on a dimmed row: being a favorite has nothing to do with whether a bus is coming, and the star is what you scan the list for |
| `TOKEN_GRAY` | = `GRAY` (120,120,120) | The trailing direction token and its middot (“ · N”, “ · I”), drawn as its own piece of the title. It identifies the stop but is not part of what the stop is *called*, and at full black it competed with the name. White when selected |

Change the palette freely — colors are `render.makeColor(r,g,b)` calls,
created once at module load (never in `draw()`). Selected rows are always
white-on-ACCENT regardless of dim state, so keep ACCENT dark enough for
white text.

## 4. Layout metrics (`src/embeddedjs/main.js:74-86`)

| Constant | Value | Meaning |
|---|---|---|
| `HEADER_H` | 28 px | Header bar height (fits Gothic-Bold 18 at y=4) |
| `HEADER_PAD` | 6 px | Side margin inside the blue bar, matching the row margin |
| `HEADER_BUSY_W` | derived | Width of the “…” refresh indicator + gap. Reserved out of the title budget because `drawHeader()` draws it *after* the centered title, so a full-width title would otherwise push it off the bar |
| `HEADER_TEXT_W` | derived | `screen.width − 2·HEADER_PAD − HEADER_BUSY_W` — the header title’s ellipsize budget. The title is centered, so this alone decides when a stop name truncates |
| `ROW_H` | 40 px | List row height (title at y+2, subtitle at y+22) |
| `ARRIVAL_ROW_H` | 44 px | Arrivals row height (line at y, dest at y+26) |
| `VISIBLE_ROWS` | derived | `floor((screen.height − HEADER_H) / ROW_H)` |
| `LIST_TEXT_W` | derived | `screen.width − 12` — list text budget before ellipsizing |
| `ARRIVAL_MIN_EDGE` | derived | Shared right-alignment edge for ALL minutes strings (units digits line up to the pixel; user mock, 2026-07-12): `6 + max(width("88", fontBig), width("888", fontNarrow) − 1)` — a 3-digit wait may overhang the 2-digit edge by 1 px. Per-row `a.minX` (in-frame lazy-fit block) right-aligns each string to it, with +1 px for `fontNarrow` strings (their ink sits 1 px left of fontBig’s at equal advance, user-tuned) and +2 px more for waits whose last digit is 1 (the “1” glyph leaves its right side of the advance empty; realigns on refresh when it ticks down — user-tuned) |
| `ARRIVAL_TEXT_X` | derived | `ARRIVAL_MIN_EDGE + 9` — one fixed column for every route number and destination (no per-row pushing; 9 not 10 is user-tuned) |
| `NOW_X` / `NOW_NO_X` / `NOW_W_X` / `NOW_SLIVER_X` | derived | The “Now” label’s draw positions, all module constants and all hardware-measured/user-tuned 2026-07-12: right-aligned to `ARRIVAL_MIN_EDGE` then +2 px (`fontNarrow`’s +1 plus one more); drawn as a split “No”+“w” with “No” kerned +1 px toward the “w” (tightens the o–w gap); a 1×14 px sliver at `NOW_X+41`, `y+3` completes Leco-20’s lowercase-w final stroke (the glyph bitmap is one column short — 2 px wide vs 3 for every other stroke; uppercase “NOW” was rejected: the “W” has angled strokes). Do not replace with a single `drawText("Now")` |
| `ARRIVAL_TEXT_W` | derived | Remaining width for line/destination text |
| `NARROW_Y_SHIFT` | `3` px | Vertical drop applied to every `fontNarrow` draw in the arrivals row (“Now” and any 3-digit/100+ minute wait) so its baseline lines up with the route number/code (`fontLine`) beside it — `fontNarrow` (Leco-Bold 20) sits shorter than `fontLine`/`fontBig` (24/26) at the same `y` (user-tuned, 2026-07-12) |

Everything derives from `screen.width`/`screen.height` — keep it that way
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
of punching a white hole in it — the overlap is detected geometrically
in-frame (does the selected row’s rect reach the clock band), so it stays
allocation-free. `updateClock()` is driven by a **minute-aligned `Timer`**
(`Timer.set` to the next minute boundary, then `Timer.repeat(…, 60000)`) —
**not** a `secondchange` listener. A per-second wakeup churned ~80 B/s of
heap for a display that only changes once a minute, which pushed the tiny
chunk heap to near-zero free at every GC peak and was the cause of “memory
full” crashes during normal use (playbook §B; measured chunk-free jumped
from ~124 B to ~1.9 KB after the switch). `timeX` is remeasured in-frame
(via the `timeDirty` flag) so steady-state draws still allocate nothing.

## 5. Static strings

| Text | Where |
|---|---|
| Header title “Transit Glance” (+ “…” appended after the title while a refresh is in flight — both screens, the arrivals header gets it too; “…” because its glyph is proven in Gothic-Bold 18; arrow glyphs like ↻ are not in the font and render blank) | `drawHeader()` / `drawHeaderBusy()`, `main.js` |
| “★ hold Select to unfavorite” / “Select to ★ favorite” | `HINT_IS_FAV` / `HINT_NOT_FAV`, `main.js` |
| "Offline · updated Nm ago" (arrivals footer, replaces the favorite hint while showing last-known arrivals with no network; N = whole minutes since fetch) | `OFFLINE_PREFIX` + age, built in `buildOfflineText()` / `tickArrivals()`, `main.js` (precomputed into `state.offlineText`, off the draw path) |
| "No live data" (arrivals body, when the last-known arrivals all age out while offline) | `tickArrivals()`, `main.js` |
| "No phone connection" (arrivals body, when a stop is opened while the phone link is down and there is no prior data to count down) | offline fallback timer in `fetchArrivals()`, `main.js` |
| “Loading…”, “Finding stops…”, “No stops nearby”, “No arrivals”, “Connecting…”, “Waiting for phone…”, “Error: …” | `state.status` / `state.arrivalsStatus` setters throughout `main.js` |
| “Set API key in app settings”, “No phone location”, “Bad API key”, “Rate limited”, “Network error”, “511 timeout” | phone side: `src/pkjs/index.js`, `src/pkjs/transit511.js` |
| “Now” (arrival due) | `prepareArrivals()`, `main.js:234` |
| Clock time (bottom-right, all screens; 12-hour, no leading zero, no AM/PM, e.g. “3:45”) | `updateClock()`, `main.js` — see §4 clock overlay |
| BART line names (“Green”, “Yellow”, “Red”, “Orange”, “Blue”) | compressed to G/Y/R/O/B initials on the **phone** (`bartLineLetter()`, `transit511.js:231`) in **list subtitle tokens only** — the arrivals screen keeps the full name, drawn in the matching line color via the `k` code (see §3); “Beige” (Coliseum–OAK) passes through untouched |
| Stop name carries a **single-letter direction token** — `"Bayshore · N"`, `"San Bruno & Wayland · I"` (N/S/E/W, **I** = inbound, **O** = outbound) | built on the **phone**, `stopLabel()` in `src/pkjs/index.js`; separator `TOKEN_SEP` = `" · "`, mirrored as `DIR_SEP` in `main.js` — **keep the two in step**. (An em dash was tried first and rendered fine on hardware, but read heavier than the row wanted; the middot matches the subtitle’s separator.) One letter, not the full IB/OB: on the title the token is not there to be *read*, it is there to tell two otherwise identical rows apart at a glance, and every character it costs is one the stop’s actual name doesn’t get. The subtitle spells the same direction out in full (row below). The token is part of the stop’s *identity*, so it lives in the name and therefore disambiguates **everywhere** the name appears — including the Clay settings page, which shows **no subtitle at all** and where two identical “Bayshore Caltrain St” toggles are simply unusable. It gets its **own reserved width** (name compressed to `LIST_NAME_MAX − 3`), and the watch **re-protects it from the ellipsize**: fitting the whole label would cut from the END of the string, which is exactly the token, so `fitVisibleRows()` fits the *name* to what the token leaves and appends the token after. Sources, folded into one vocabulary: **Caltrain** spells it into the stop *name* (“… Station Northbound”, `BOUND_RE`); everyone else says it only in the live **`DirectionRef`** (`dirToken()`). A code serving **both** directions gets no token — none would distinguish it |
| Subtitle format `"SF · 320 m · IB · 8,45,30"` (agency · distance · direction(s) · **every** serving line, or `· no arrivals` when dimmed) | built on the **phone**, `buildRows()` + `dirLinesSuffix()` in `src/pkjs/index.js`; distance in `formatDistM()` (meters under 1 km, else `x.y km`); direction/lines from the agency-wide stop-info map (`getStopInfo()`, `transit511.js`), lines tokenized by `lineToken()`. Directions cap at 2. **Lines never truncate and never show a trailing `+`** — “something else also stops here, good luck” is the one thing a rider cannot act on, and the watch already ellipsizes a subtitle that overruns its row. `LINES_CHAR_BUDGET` survives only as a **payload backstop** (60 ch, far above the measured Bay Area worst case of 29): `respond()` sheds whole rows past `ROWS_BUDGET`, so an unbounded subtitle would silently drop stops off the end of the list. Measured 2026-07-14: the densest real page-0 lists (Powell/Market, Embarcadero) come to ~1,170 B of the 1,600 B budget with all 14 rows intact. The direction shows **here in full AND on the title as one letter**, deliberately: spelled out where there is room to read it, abbreviated where it only has to distinguish |
| Caltrain filler stripped from names | Every CT stop is “*place* Caltrain Station *bound*”, and the row already carries “CT ·” in its subtitle — so “ Caltrain Station” is pure width, half a row saying nothing. “Bayshore Caltrain Station Northbound” → “Bayshore N” | `AGENCY_FILLER_RE`, `index.js` |
| BART shows **one row per station and direction** — “Balboa Park · N”, “Balboa Park · S” | 511 gives every BART *platform* its own stop id, and those ids are **neither** a station **nor** a direction: 12th Street has three ids and Balboa Park two, all under one name (so a platform-per-row list showed a station two or three times with nothing to choose between); 12th Street and Daly City each have **two northbound platforms**, so a direction token alone wouldn’t separate them either; and at 12 of the 50 stations (Bay Fair, Coliseum) one platform serves **both** directions. Collapsing every station to a single undirected row was tried on 2026-07-14 and **reverted the same day** — 38 of the 50 stations DO have direction-specific platforms, and direction is the one distinction a rider actually rides on. Direction is the right axis and the **parent station** is the right way to query it: `Extensions.ParentStation` is itself a valid StopMonitoring stopcode (901809 → all 43 upcoming trains, both ways, each tagged `DirectionRef`), whereas a single platform’s feed is only *some* of that direction’s trains. So the stop code is synthetic — `<station>-<N|S>` (`DIR_CODE_SEP`) — and `getArrivals()` splits the direction back off, asks 511 for the station, and filters by `DirectionRef`. A terminus’s unserved direction simply comes back with nothing arriving and dims, which is true. **BART only**: Muni publishes no ParentStation (its two sides of a street are genuinely different places to stand), and Caltrain’s is a slug (`22nd_street`) over children that are already the two directional platforms, which its NAMES say | `SPLIT_BY_DIRECTION` + `parseStops()` / `getArrivals()`, `transit511.js` |
| Settings-page labels & descriptions (incl. “Favorite stops” section, “Hide favorites beyond (km)”) | `src/pkjs/config.js`; dynamic favorites section built in `showConfiguration`, `index.js:118-138` |

Watch-side strings cost heap; keep them short. Subtitle/label formatting
changes belong on the phone, not the watch (thin-client rule).

## 6. Button behavior (`src/embeddedjs/main.js:437-493`)

| Button | LIST screen | ARRIVALS screen |
|---|---|---|
| Up | Move selection up; **at top: pull-to-refresh** — the list **stays on screen AND stays interactive** (scroll/select keep working; blocking input for the round trip was rejected as bad UX) with a “…” indicator after the header title while a `fresh:1` rebuild runs. The rows stay live until the response **arrives**, then are released in `protocol.onBeforeParse` — synchronously before the parse — so the parse still lands beside freed heap (a rows parse needs >1.6 KB of chunk — playbook §B ninth recurrence); the framebuffer shows the old rows for the few ms until the rebuild repaints. Refresh resets scroll to the top | Scroll up; **at top: manual refresh** — the arrivals **stay on screen, interactive, and ticking** (no freeze) with a “…” header while the request is out, exactly like the list; they are released in `protocol.onBeforeParse` only for a real data response, so a failed (offline) refresh keeps them and counts them down instead of erroring (see §7) |
| Down | Move selection down; **at bottom: load more stops** — append the next page of farther stops (`fetchMore()` → phone `buildMoreRows`), up to `MAX_LIST_ROWS`=14 total, no refresh | Scroll down; **at bottom: load more arrival times** — raise the requested count (`state.arrLimit`, +`ARR_STEP` up to `ARR_MAX`=10), no refresh |
| Select | Open arrivals for highlighted stop | **Tap to ★ favorite; HOLD 0.5 s (`LONGPRESS_MS`) to unfavorite** — a stray tap on a starred stop does nothing (accidental unfavorites during fast use prompted this). The unfavorite fires **mid-hold at the threshold** (a `Timer` armed on press, cancelled by early release), so the footer hint flips while the button is still down; releasing early cancels. Toggles **visibility** only (never deletes) via a `fav` request to the **phone** (which owns the list). The request carries the state it wants (`w:1`/`w:0`, `protocol.setFav`), **not a flip** — it used to be a blind toggle of whatever the phone had stored, so a watch showing a stale ★ flag would *unstar* the stop the user was trying to star (see §8) |
| Back | Exit app (`watch.exit()`) | Return to list |

Neither screen refreshes on **Down** anymore (it was a wasted API call): Down
always means “show me more” — more stops (wider radius) on the list, more
arrivals on the arrivals screen. Manual refresh survives only as **Up at the
very top** of either screen. The arrivals screen is scrollable
(`state.arrTop`, `VISIBLE_ARRIVALS` rows visible). “Load more” **appends** on
both screens (more stops / more arrivals) rather than widening a radius, so
it keeps working in dense areas; both are bounded by the caps in §9
(`MAX_LIST_ROWS`, `ARR_MAX`) and each AppMessage page still fits its §9
wire budget — the watch accumulates the pages in RAM.

Both manual-refresh paths (Up at the top of either screen) share a **3 s
cooldown** (`REFRESH_COOLDOWN_MS`, `state.refrOkAt`, main.js): the phone
answers from cache in ~200 ms, so the in-flight guards alone admitted ~5
full request cycles a second under a mashed Up and crashed the watch
(playbook §B, seventh recurrence). Presses inside the cooldown are no-ops.

Actions fire on press (`down === true`), releases ignored. Because
`"back"` is registered, single-tap auto-exit is replaced — LIST-screen
exit is restored manually via `watch.exit()`. Any new button-triggered
request **must** keep its in-flight guard (`state.nearbyPending`,
`state.arrivalsPending`, `state.favPending`) **and** a cooldown when the
response can arrive faster than a human can press (guards serialize, they
don’t rate-limit) — button-mashing without them has crashed the watch
(CLAUDE.md §12 item 12; playbook §B/§G). Beneath all of that, protocol.js
**serializes every request** — one on the wire at a time, the rest queued
(playbook §B, twelfth recurrence) — so rapid cross-action presses (e.g.
open a stop, then instantly favorite it) cost a moment of latency rather
than concurrent memory.

## 7. Timing & refresh cadence

| Behavior | Value | Where |
|---|---|---|
| Arrivals auto-refresh while screen open | 60 s | `Timer.repeat` in `openArrivals()`, `main.js:305` |
| Arrivals offline countdown (minutes tick down with no network) | every wall-clock minute, and immediately on a failed refresh | `tickArrivals()`, `main.js` — each arrival is anchored to an absolute due time (`a.whenMs`, reconstructed in `prepareArrivals()` from the `min` the phone sent plus `state.arrivalsAt`); the displayed minute is re-derived as `round((whenMs - now) / 60 s)` (mirrors the phone's `serveArrivals`), so it tracks seconds internally and never drifts a whole minute. Ticks are driven by the existing minute-aligned clock `Timer` (via `updateClock()`, **no new timer**) and by `fetchArrivals().catch`. This ticks **online too** (arrivals count down smoothly between the 60 s server refreshes) and offline keeps counting from the last-known data instead of erroring. Only `a.min`/`a.minStr`/`a.minFont` change on a tick; a `a.minDirty` flag has `draw()` recompute only `a.minX` in-frame (line/dest untouched). Arrivals >1 min past due are dropped (same threshold as `serveArrivals`); if that empties the list while offline the body reads "No live data". A refresh whose response is slow (Bluetooth off / phone unreachable) does **not** wait out the 15 s `REQUEST_TIMEOUT_MS`: an `OFFLINE_FALLBACK_MS` (4 s) timer in `fetchArrivals()` drops to this offline tick early (or, on a cold open with no prior data, shows "No phone connection"), while leaving the request in flight so a recovered link still replaces the estimate with live data. This is deliberately **link-state-agnostic** — `watch.connected.app`/`.pebblekit` did not reliably flip on a Bluetooth-off drop, so the fallback bounds the wait by time instead of trying to detect the disconnect |
| Arrivals refresh — live release, no freeze (manual, “load more”, auto-refresh) | duration of the round trip (~1–2 s warm) | `fetchArrivals()`, `main.js` — the arrivals stay **LIVE, interactive, and ticking** through the round trip (no screen freeze; the old design hard-gated `draw()` on `state.refreshing`, which hid the arrivals for the whole 15 s request timeout when the link was down), so a **failed** refresh can keep counting them down offline (see the offline-countdown row above); they are released in `protocol.onBeforeParse` **only when a real data response (`"type":"arrivals"`) is about to be parsed** (playbook §B tenth recurrence), so an error/timeout keeps its arrivals. This mirrors the LIST screen's live-through-the-round-trip release model. Scroll position survives the reload |
| Arrivals reconnect re-fetch | on the `connected` watch event and the settings-changed ping | `watch.addEventListener("connected", …)` + `protocol.onSettingsChanged` → `refreshCurrent()`, `main.js` — a mid-session Bluetooth reconnect used to leave the running app showing stale data until it was closed and reopened (nothing re-fetched: the list has no periodic refresh and pkjs doesn’t reliably re-ping on reconnect). Both handlers now re-fetch whichever screen is showing; in-flight guards serialize repeated fires. **Exception: a paginated LIST is not reloaded on the `connected` event** (`state.paginated`) — a reconnect reload returns page-0 only, so it would drop every “load more” stop and, with SF Muni off (page-0 collapses to ~just favorites), leave the user at the bottom of favorites mid-scroll. Pull-to-refresh (Up-at-top) and a settings change still reload and re-baseline |
| Manual-refresh cooldown (Up at top, both screens) | 3 s | `REFRESH_COOLDOWN_MS`, `main.js` — see §6 |
| Phone-side full-arrivals cache (absorbs manual + auto refresh) | 45 s | `ARRIVALS_TTL_MS`, `transit511.js:367` |
| Agency-wide stop-info cache (lines/directions per stop + favorite has-arrivals) | 10 min fresh, then **served stale while it refreshes** | `STOP_INFO_TTL_MS` + `getStopInfo()`, `transit511.js` — one StopMonitoring call per agency, no stopcode, and the **fattest endpoint in the API** (Muni is tens of thousands of visits). **Persisted per agency** (`stopinfo.v3.<AGENCY>`, ~145 KB for Muni) and served stale-while-revalidate like the stop lists: fresh serves directly, stale serves the cached map **immediately** and refreshes behind it, only an absent map blocks (first-ever launch). Before this it was in-memory only, so — pkjs being torn down when the watchapp closes — **every** launch re-downloaded all of these and blocked the rows response on the whole fan-out (`buildRows` withInfo), the dominant cost of a cold launch. Serving a stale map is safe here: its lines/directions change on a service-change timescale, and its one time-sensitive use (the “· no arrivals” dimming) only **grays** a row, never hides it — a wrongly-dimmed stop is still shown and tappable, and the background refresh corrects it. The per-agency calls also fire **concurrently** (not serially) in `buildRows`/`getFavoriteStatus`, and concurrent callers now **share one download** (`stopInfoRefreshing`/`stopInfoWaiters`) |
| Persisted rows list (serve-as-final) | 3 min (`ROWS_FRESH_MS`) | `index.js` — a plain `nearby` request is answered instantly from this cache **as final: no `stale:1`, no revalidation** (the watch’s `scheduleRevalidate()` machinery remains in `main.js` but never triggers). The deferred-revalidation design (stale:1 → fresh follow-up 5 s later, eleventh recurrence) died 2026-07-12: its second full rows parse ~11 s into boot aborted “memory full” deterministically at the fully-carved arena (playbook §B, sixteenth recurrence). Past 3 min the cache is treated as a miss and the launch takes the normal single-parse fresh path (a “Locating…” wait instead of an instant list). Freshness beyond that is manual: pull-to-refresh sends `fresh:1` directly (seventh recurrence). Widened (“load more”) lists are not cached |
| Stop-list cache | 7 days | `STOP_CACHE_TTL_MS`, `transit511.js:38` |
| Watch request timeout | 15 s | `REQUEST_TIMEOUT_MS`, `protocol.js:48` |
| Phone HTTP timeout | 20 s | `getJSON()`, `transit511.js:45` |
| Geolocation | low accuracy, 10 s timeout, 2 min max age | `handleRequest()`, `index.js:302` |

**Rate-limit math before changing any of these:** 511 allows 60
requests/hour total. The 60 s auto-refresh + 45 s cache pair means one
open arrivals screen costs ≤ 60/hr worst case by itself — shortening
either value can blow the budget (CLAUDE.md §12 item 6). Cached arrivals
still tick down correctly (absolute times recomputed at serve time), so a
longer cache degrades freshness less than you’d expect.

## 8. Favorites (owned by the PHONE)

Favorites live in phone localStorage (`favorites.v1` —
`[{agency, code, name, hide?}]`), not on the watch. **Star toggles are
visibility, never deletion**: Select on the watch’s arrivals screen and
the settings page’s show/hide toggles both flip the `hide` flag (a brand
new star creates the record). A hidden favorite’s stop can still appear
as an ordinary unstarred nearby row when physically close — starring it
there unhides it. Deletion is settings-page only: per-favorite 🗑
toggles, confirmed by a dialog at save time (`clayCustomFn`).

| Behavior | Value | Where |
|---|---|---|
| Max favorites stored | 20 (storage cap — hidden records accumulate until trashed) | `MAX_FAVORITES`, `index.js` |
| Hide a favorite from the list | (a) farther than `hideFavKm` setting (default 19 km / ~12 mi) — **× `railRadiusX` for BART/Caltrain favorites** (`RAIL_AGENCIES` = BA, CT, SB — the two rail agencies plus SF Bay Ferry; `railScale()` gives the per-agency reach and `getFavoriteStatus` returns `far:1`, so rail knowledge stays inside the provider) — reappears when near; (b) `hide` flag (watch unstar or settings toggle). Both keep it saved and cost no payload bytes or API calls while hidden | `buildRows()` + `maxCheckM` arg to `getFavoriteStatus()`, `index.js` / `transit511.js` |
| Delete a favorite | settings page 🗑 toggle + save; `window.confirm` dialog in the webview (degrades to no-dialog if Clay’s DOM changes — see `clayCustomFn`) | `showConfiguration` / `webviewclosed`, `index.js` |
| Dim a row (favorite or nearby stop) | nothing currently arriving (subtitle gains “· no arrivals”); determined by absence from the agency-wide stop-info map (skipped when that map failed to load — unknown stays undimmed) — no per-stop API calls | `buildRows()` + `buildMoreRows()`, `index.js`; `getStopInfo()`, `transit511.js` |
| New favorite position | added to the front of the saved list | `fav` handler, `index.js` |
| A favorite reached by scrolling **keeps its star** | “Load more” pages carry the `f` flag too (`buildMoreRows`), so a starred stop that only turns up deep in the list — one past the hide line, which therefore never made the favorites block — still shows ★. This costs the pagination nothing: `off` counts the rows the phone has handed over, starred or not, and `fetchMore()` advances `state.moreOff` by the rows it receives | `buildMoreRows()`, `index.js`; `fetchMore()`, `main.js` |
| Star state is **set, not toggled** | The watch sends the state it wants (`w:1`/`w:0`); the phone applies it idempotently. As a blind flip it was only correct while the watch’s ★ flag was — and the rows cache (below) could serve rows built *before* a favorite existed, so re-starring an apparently-unstarred stop silently **hid** it. Legacy watch builds send no `w` and still get the old flip | `protocol.setFav()`, `main.js`/`protocol.js`; `fav` handler, `index.js` |
| Rows cache is **invalidated** whenever favorites or settings change | The cached list embeds the favorites block and every row’s ★ flag, and it is served **as final** (no revalidation). Nothing dropped it on a favorite change until 2026-07-14: starring a stop, quitting, and relaunching inside the 3-minute window replayed the pre-favorite rows — the stop came back unstarred, and re-starring it hid it (row above). Dropped, not patched: a newly starred stop may not even be among the cached rows | `clearRowsCache()`, `index.js` |
| Favorite records **self-heal** on each list build | `name` is recomposed through `stopLabel()` (records written before it existed read “Bayshore Caltrain St” twice over, with nothing telling the two platforms apart), and `code` is migrated when the stop it named has been retired — a BART favorite saved against a *platform* before stations were collapsed (`canon` from `getFavoriteStatus`); left alone it would resolve to nothing forever. Records that the migration lands on one stop are then merged | `buildRows()` + `dedupeFavs()`, `index.js` |
| A favorite beyond the hide line still shows as an **ordinary** row | It is dropped from the favorites block (`far:1`), but it is **not** suppressed from the nearby block — doing both made a station starred from a deep “load more” page (radius grows to 200 km, past the 19 km `hideFavKm`) vanish from the list *entirely*, starred and unstarred alike, with no way to reach it from the watch | `favKeys` / `shownAsFav()`, `index.js` |
| One-time migration | removed from the watch 2026-07-12 (completed on the only device this app runs on) to free bytecode; the phone still accepts a `mig` field on nearby requests | `importLegacyFavs()` in `index.js` |

## 9. List content & caps

| Behavior | Value | Where |
|---|---|---|
| Row order | favorites (nearest first, **capped at the 10 nearest** — `FAV_ROWS_MAX`, raised from 6 with the 2026-07-12 budget relaxation below; dist-unknown favorites sort last and cap out first) then nearby stops (nearest first); total capped at 14 (`WATCH_LIST_CAP`, mirrors the watch’s `MAX_LIST_ROWS`). Capped-out favorites stay saved and reappear when nearer. 13 uncapped favorites once filled 1143 B alone and crashed the watch (playbook §B, fifteenth recurrence) | `buildRows()`, `index.js` |
| “Nearest” = **effective distance** | Both blocks (favorites and nearby) order by `eff` = real distance ÷ `railRadiusX` for BART/Caltrain, ÷ 1 for every other agency (`railScale()`; the provider returns `eff` beside `dist`, so `index.js` never learns which agencies are rail). At 5× a station 3 km out ranks like a 600 m bus stop and interleaves with them; at the 1× default `eff` == `dist` and ordering is exactly as it was. Rows always **display the real distance** — `eff` is a sort key and is never shown. Payload shedding pops the effective-farthest tail, so a scaled-in station is not shed ahead of a bus stop that ranks below it | `railScale()` + `findNearbyStops()` / `getFavoriteStatus()`, `transit511.js`; `favRows` `_d`, `index.js` |
| Watch list retention | **`LIST_RETAIN_MAX` = 24 retained rows; loading is unlimited.** Down at the bottom appends for as long as stops exist; once the list is full, appending **evicts the oldest non-favorite rows off the top** (`trimRetained()` — favorites stay pinned at the head; selection and the scroll window shift with the rows). Memory is bounded by the cap, not by how far you scroll. Rows you scrolled past are gone if you scroll back up (Up at the top reloads the list from where you are). Pagination uses `state.moreOff`, a monotonic cursor, **not** `rows.length`, so eviction never rewinds it. Was `MAX_LIST_ROWS`=14; **removing the cap entirely on 2026-07-13 crashed real hardware with “memory full”** (playbook §B, seventeenth recurrence — the load-more page parses beside the retained list). 24 is a conservative step up from the known-safe 14 and is **unmeasured** — raise it only against the §F instrumentation | `LIST_RETAIN_MAX` + `trimRetained()`, `main.js` |
| Nearby stop count | `maxStops` setting (default 8) is a **starting default, not a ceiling**: it shapes the opening screen (extended through dense clusters, `WATCH_LIST_CAP`=14 rows on page 0). **Down at the bottom appends farther stops without limit** (retention is capped and slides — see the retention row below). The phone paginates via `buildMoreRows` (`off` = non-favorites already shown; `hardCeiling` override on `selectNearbyStops` reaches past the default 14 candidates). Loading only stops when the phone returns an empty page, i.e. nothing left within `MORE_RADIUS_MAX_M` | `selectNearbyStops()` + `HARD_STOP_CEILING`, `transit511.js`; `fetchMore()`, `main.js` |
| Search radius | `radiusM` setting, default 500 m for the page-0 list; “load more” paginates from a **growing** radius: `MORE_RADIUS_M`=5000 m for the first page, **doubling per page** (5 km, 10, 20, …) up to `MORE_RADIUS_MAX_M`=200 km, so Down never hits a distance wall. It was a flat 5 km until 2026-07-13  — once you’d seen every stop inside it, every further Down returned an empty page and the watch latched “no more stops” for good. Widening costs no 511 calls (agency stop lists are already cached; radius is just a filter). **BART/Caltrain search out to `radiusM` × `railRadiusX`** (`railScale()`), so a far station is in the candidate set at all; the same scaling ranks it (row above). The rail filter `dist ≤ radiusM × mult` is exactly `eff ≤ radiusM`, so the candidate set is “everything with effective distance ≤ radius, ordered by effective distance”  — widening the radius only **appends** stops that rank after those already shown, which is what keeps index-based `off` pagination duplicate-free even at 30×. Scoped to favorites only until 2026-07-13, when the multiplier was deliberately extended to unstarred stops as well | settings, `index.js`; `buildMoreRows`, `index.js` |
| Rows payload budget | **1600 B for page-0 lists** (`ROWS_BUDGET` — fits all 14 rows at ~100 B each); **1000 B for “load more” pages** (`MORE_BUDGET` — fits a full 8-stop `MORE_PAGE`; still tighter than page 0 because a load-more response parses beside the retained full list). **Relaxed 2026-07-12 from 880 B / 400 B** — 32 KB-arena trades (playbook §B seventh/thirteenth/fifteenth recurrences; the 400 was sized to a measured ~750 B worst-case free chunk) lifted by the 72 KB heap on firmware ≥ v4.21.0. Revert both (and `FAV_ROWS_MAX` to 6) for any 32 KB-firmware device. Enforced on the **final serialized payload** in `respond()` (`id`/`stale:1` overhead included; budgeting before they were appended once put 884 B on the wire and crashed the watch mid-parse). The budget is **absolute**: farthest non-favorite stops shed first, then favorites farthest-first as last resort (shed floor is 1 row — “favorites never shed” let 13 favorites ship a 1143 B payload that crashed the watch parse, playbook §B fifteenth recurrence) | `ROWS_BUDGET`/`MORE_BUDGET` + `respond()`, `index.js` |
| Arrivals per stop | default 6; **Down “load more” raises it** to `ARR_MAX`=10 (`req.lim` → `MAX_ARRIVALS` cap on the phone) | parse loop `transit511.js` (`limit`); `state.arrLimit`, `main.js` |

## 10. Text truncation lengths

| Text | Cap | Where |
|---|---|---|
| Nearby stop name | **raw** at collection (bounded at 64 only to cap memory), then the `stopLabel()` → `compressStopName()` pipeline below to ≤24 (`LIST_NAME_MAX`, raised from 20 on 2026-07-14 — the direction token spends 3 of them, and letters are what make a stop recognizable; the cap approximates what actually FITS the row, because `compressStopName` only drops street types once the name exceeds it). It was cut to 28 chars at collection until 2026-07-14, which **amputated the direction Caltrain spells into its names**: “Bayshore Caltrain Station Northbound” (35 ch) reached the display pipeline as “Bayshore Caltrain Station No” and came out as “Bayshore Caltrain St” — identical to its southbound twin | `findNearbyStops()`, `transit511.js`; `stopLabel()`, `index.js` |
| Favorite name from cached stop list | same: raw (bounded at 64), then the same `stopLabel()` pipeline; falls back to the saved favorite name on a cache miss. Was 24 chars — same amputation as above | `getFavoriteStatus()`, `transit511.js`; `buildRows()`, `index.js` |
| Arrivals header (stop name) | none — fitted to pixels (`HEADER_TEXT_W`), not chars. Was an 18-char cap (`shortName()`), which ellipsized names long before they reached the edges of the bar; the phone already caps names at 28/24 chars (rows above), so the header string stays bounded without it | fitted in `draw()`, `main.js` |
| Route/line | 10 chars, tokenized per agency by `lineToken()`: bus route numbers are already short (cut at 4); **BART** takes its colour initial in list subtitles only (see §5) and keeps the full “Yellow-N” on the arrivals screen; **Caltrain** publishes a *service pattern* rather than a route — its `LineRef` is “Local Weekday” — so it maps to Local / Ltd / Bullet. The blanket 4-char cut used to render every Caltrain subtitle as the meaningless “Loca” | `lineToken()`, `transit511.js` |
| Destination (arrivals screen) | cleaned, then ≤24 chars (`DEST_MAX`) | `cleanDest()`, `transit511.js`. 511 pads destinations with the same noise the stop names carry, and a blunt 24-char slice amputated the distinguishing part — “Berryessa / North San Jose” → “Berryessa / North San Jo”, every Caltrain destination → “… Caltrain Statio”. Now: strip Caltrain’s “Caltrain Station …bound” filler (the screen is already one direction), drop a trailing parenthetical (“Millbrae (Caltrain Transfer Platform)” → “Millbrae”), and only if still over the cap abbreviate a leading compass word so the tail survives (“… North San Jose” → “… N San Jose”). The 24 is a payload bound; the watch fits the result to the row and ellipsizes anything still over |

**Stop names are compressed, not cut** (`compressStopName()`, `index.js` —
applied to every list row in `buildRows`/`buildMoreRows`; the arrivals
header reuses the row’s name, so it inherits this). The old rule — hard
16-char cut whenever the list exceeded 8 rows — spent the row’s ~17
renderable chars on street-type words and killed the distinguishing cross
street (“Mansell St & San”, user report 2026-07-12). The pipeline, each
step only if the name still exceeds `LIST_NAME_MAX` = 20: (1) abbreviate
street-type words everywhere (“Powell Street” → “Powell St”; this step is
unconditional), (2) drop street types that end an intersection segment
(“San Bruno Ave & Mansell St” → “San Bruno & Mansell” — a leading
Saint-style “St” is safe: only a *trailing* type with a space before it is
dropped), (3) hard-cut at 20 and trim any dangling “&”. Names already ≤20
keep their types, so “4th St & Market St” stays unambiguous (SF has both
4th St and 4th Ave); only too-long names trade that suffix for the cross
street. This must stay phone-side: a watch-side expansion dictionary would
cost bytecode = heap (playbook §B).

On-screen fitting on top of these caps is `ellipsize()` (binary-search,
called only inside `begin()/end()`, results cached per row **while the row
is in the visible scroll window and released once it scrolls away** — both
screens; a permanent cache retained ~1 KB of fitted duplicates on a full
list and crashed a refresh parse, playbook §B eighth recurrence). Raising
the phone-side caps raises payload size — re-check the payload budgets in §9.

The truncation marker is a **period** (`TRUNC`, `main.js`), not an ellipsis:
the marker’s width comes out of the text’s budget, and a “.” is several
pixels narrower than a “…”, so more of the name survives. This is *not* the
same glyph as the “…” busy indicator in §5 — that one means “refresh in
flight” and stays an ellipsis.

## 11. Settings (Clay — `src/pkjs/config.js`, defaults `DEFAULT_SETTINGS` in `index.js`)

| Setting | Default | Notes |
|---|---|---|
| `apiKey` | "" (dev: seeded from `localSecrets`) | Phone-only, never sent to watch |
| `agencies` | SF, BA, AC, GG, SM, SB | Checkboxes (SB = SF Bay Ferry) + free-form `ExtraAgencies` codes |
| `radiusM` | 500 | Nearby search radius (× `railRadiusX` for BART/Caltrain) |
| `railRadiusX` | 1 (slider 1–30) | How much farther a train or ferry is worth going than a bus. Scales BART/Caltrain/ferry **reach** (nearby search radius `radiusM` × this; favorites hide line `hideFavKm` × this) and **rank** (real distance ÷ this), for favorites and unstarred stops alike — see §8 and §9. Displayed distances stay real. 1 = off |
| `maxStops` | 8 | Soft cap, see §9 |
| `hideFavKm` | 19 (slider 1–100) | Favorites beyond this are left off the watch list, see §8 |
| Favorite stops section | dynamic | Per saved favorite: a `Show_<agency>_<code>` show/hide toggle (sets/clears `hide`) plus a `Del_<agency>_<code>` 🗑 delete toggle (confirmed at save). Appended before the submit button each time the page opens (`showConfiguration`) |

Settings live on the phone only; the watch just gets a `SettingsChanged`
ping and re-runs the nearby search. To add one: `config.js` field →
`webviewclosed` reader → `DEFAULT_SETTINGS` (CLAUDE.md §8).

## 12. Startup behavior (`main.js:401-407`)

- Before the first response the list is empty with status “Connecting…”
  (or “Waiting for phone…” if pebblekit isn’t connected) — the watch keeps
  no persistent data, so there is nothing to render until the phone
  answers.
- If the phone’s rows cache is under 3 min old (`ROWS_FRESH_MS`), the
  first reply is that cached list, served as final — no revalidation
  follows (see §7’s persisted-rows entry; the old 5 s deferred
  revalidation crashed the watch, playbook §B sixteenth recurrence).
  Older cache = the launch waits through the normal locate + fetch
  (“Connecting…” until the single fresh reply lands).
- The **phone initiates** the first fetch via a `SettingsChanged` ping
  from its `ready` handler — the watch never requests at boot (race, see
  CLAUDE.md §6). Recovery if the ping is lost: Up at the top of the list.
