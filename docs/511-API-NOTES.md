# 511 SF Bay API notes

Working reference for `src/pkjs/transit511.js`. Official docs:
https://511.org/open-data/transit (spec PDF linked from that page).

## Basics

- Base URL: `https://api.511.org/transit`
- Auth: `api_key=<token>` query param on every call. Free token:
  https://511.org/open-data/token
- **Rate limit: 60 requests / 3600 s per key** (default; can request more).
- Always pass `format=json`. Responses are gzip-compressed and **begin with
  a UTF-8 BOM (`\uFEFF`)** — strip it before `JSON.parse`.

## Operator codes used by this app

| Code | Agency |
|---|---|
| SF | San Francisco Muni |
| BA | BART |
| AC | AC Transit |
| GG | Golden Gate Transit (GF = Golden Gate Ferry) |
| SM | SamTrans |
| CT | Caltrain (example “extra” code) |

Authoritative, current list (codes occasionally change — verify before
hardcoding new ones):

```
GET /transit/operators?api_key=KEY&format=json
```

## Endpoints used

### Stops (static, cached 7 days on the phone)

```
GET /transit/stops?api_key=KEY&operator_id=SF&format=json
```

Response is a SIRI/NeTEx envelope; stops live at
`Contents.dataObjects.ScheduledStopPoint[]` with `id`, `Name`,
`Location.{Latitude,Longitude}` (strings), and an `Extensions` object
carrying `PlatformCode` / `ParentStation`. Muni returns ~3,500 stops —
never forward this raw to the watch.

### A “stop” is a platform, and agencies disagree about how to say so

Measured against the live feeds, 2026-07-14. This is the single most
confusing thing about the stop lists, and it is why two rows could look
identical:

| | Stops | Name carries direction? | `ParentStation`? |
|---|---|---|---|
| **Muni** (`SF`) | 3,229 | no | **none at all** |
| **BART** (`BA`) | 103 platforms → **50 stations** | no | yes, a real numeric stopcode |
| **Caltrain** (`CT`) | 60 | **yes** — “Bayshore Caltrain Station *Northbound*” | yes, but a slug (`22nd_street`) |

- **BART** addresses every *platform* as its own stop, and a platform id is
  **neither a station nor a direction**: “12th Street / Oakland City Center”
  is three ids and “Balboa Park” two, all under one name — *and* 12th Street
  and Daly City each have **two northbound platforms** (different line
  groups), while at 12 of the 50 stations (Bay Fair, Coliseum) a single
  platform serves **both** directions. 38 of the 50, though, are
  direction-specific.

  The usable axis is (station, direction), and `Extensions.ParentStation` is
  the way to query it: the parent id is itself a valid StopMonitoring
  `stopcode` — `901809` (Balboa Park) returns all 43 upcoming trains, both
  directions, each tagged with `DirectionRef`. **A single platform’s feed is
  only *some* of that direction’s trains**, so per-platform queries cannot
  answer “what’s the next northbound train here”. `transit511.js` therefore
  emits a synthetic stop code per station-direction (`901809-N`) and filters
  the parent’s feed by `DirectionRef` (`SPLIT_BY_DIRECTION`).
- **Caltrain**’s `ParentStation` is a slug, *not* a stopcode, and its two
  children are the northbound/southbound platforms you genuinely have to
  choose between. It needs no help: the direction is already in the name.
- **Muni** publishes no `ParentStation`, so nothing collapses. Its two
  sides of a street are different places to stand.

Note 511 sometimes gives *genuinely identical names to different stops*:
`San Jose Ave & Geneva Ave` is five distinct codes within 180 m, and
`Market St & 5th St` is two. No naming scheme can separate those — only the
distance and the serving-lines list differ.

### StopMonitoring (real-time predictions)

```
GET /transit/StopMonitoring?api_key=KEY&agency=SF&stopcode=15553&format=json
```

Predictions live at
`ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit[]`
(`StopMonitoringDelivery` is sometimes an array — handle both). Each visit’s
`MonitoredVehicleJourney` has `LineRef`, `DestinationName` (sometimes an
array), and `MonitoredCall` with `ExpectedArrivalTime` /
`ExpectedDepartureTime` / `Aimed*` ISO timestamps. Cancelled-trip info is
also included in this feed.

`LineRef` values are agency-specific, and only *some* agencies mean “route”
by it (`lineToken()` normalizes them):

- **Muni / AC** — route numbers and letters (“38R”, “J”). Short already.
- **BART** — names its lines by **color**: “Green”, “Yellow”, “Red”,
  “Orange”, “Blue”, plus “Beige” for the Coliseum–OAK shuttle. The live
  values carry a direction suffix (“Yellow-N”). `transit511.js` compresses
  the five color-named lines to their initial letter in list-subtitle
  tokens and attaches a display-color code for the watch; arrivals keep the
  full name (`bartLineLetter()`).
- **Caltrain** — publishes a **service pattern, not a route**: the only
  value seen is `"Local Weekday"` (and `PublishedLineName` is *empty*). A
  blanket 4-char cut rendered every Caltrain subtitle as the meaningless
  “Loca”; it now maps to Local / Ltd / Bullet, which is what a Caltrain
  rider actually chooses between.

### DirectionRef

The direction vocabulary differs per agency (sampled live 2026-07-14):

| Agency | `DirectionRef` values |
|---|---|
| BART (`BA`) | `N` / `S` |
| Caltrain (`CT`) | `N` / `S` |
| Muni (`SF`) | `IB` / `OB` (plus a little `N` / `S`) |

For Muni and BART this is the **only** place direction exists, so stop
labels take their N/S/IB/OB token from here (`dirToken()`), folding
Caltrain’s spelled-out “…bound” names onto the same vocabulary. A stop code
reporting **both** directions gets no token — none would distinguish it.

**The agency-wide call (no `stopcode`) reports each visit against the
PLATFORM it calls at.** For BART those `MonitoringRef`s are platform codes
the collapsed stop list no longer contains, so `getStopInfo()` folds them
onto the station through the same alias map that built the list. Without
that fold every BART station is missing from the map — which the app reads
as “nothing is arriving”, dimming them all and stripping their line lists.

## Other available endpoints (not used yet, useful for features)

- `/transit/VehicleMonitoring?agency=` — live vehicle positions.
- `/transit/lines?operator_id=` — routes per agency.
- `/transit/patterns?operator_id=&line_id=` — ordered stop lists per route.
- `/transit/stopplaces?operator_id=` — richer stop metadata.
- `/transit/servicealerts` / GTFS-RT feeds — alerts, trip updates (protobuf).
- `operator_id=RG` — consolidated regional GTFS feed.

## Attribution

511.org provides data free of charge but **requires acknowledgement of
511.org as the data provider** in published apps.
