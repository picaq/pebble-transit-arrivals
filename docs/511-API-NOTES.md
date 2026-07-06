# 511 SF Bay API notes

Working reference for `src/pkjs/transit511.js`. Official docs:
https://511.org/open-data/transit (spec PDF linked from that page).

## Basics

- Base URL: `https://api.511.org/transit`
- Auth: `api_key=<token>` query param on every call. Free token:
  https://511.org/open-data/token
- **Rate limit: 60 requests / 3600 s per key** (default; can request more).
- Always pass `format=json`. Responses are gzip-compressed and **begin with
  a UTF-8 BOM (`\uFEFF`)** — strip it before `JSON.parse`.

## Operator codes used by this app

| Code | Agency |
|---|---|
| SF | San Francisco Muni |
| BA | BART |
| AC | AC Transit |
| GG | Golden Gate Transit (GF = Golden Gate Ferry) |
| SM | SamTrans |
| CT | Caltrain (example "extra" code) |

Authoritative, current list (codes occasionally change — verify before
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
`Contents.dataObjects.ScheduledStopPoint[]` with `id`, `Name`, and
`Location.{Latitude,Longitude}` (strings). Muni returns ~3,500 stops —
never forward this raw to the watch.

### StopMonitoring (real-time predictions)

```
GET /transit/StopMonitoring?api_key=KEY&agency=SF&stopcode=15553&format=json
```

Predictions live at
`ServiceDelivery.StopMonitoringDelivery.MonitoredStopVisit[]`
(`StopMonitoringDelivery` is sometimes an array — handle both). Each visit's
`MonitoredVehicleJourney` has `LineRef`, `DestinationName` (sometimes an
array), and `MonitoredCall` with `ExpectedArrivalTime` /
`ExpectedDepartureTime` / `Aimed*` ISO timestamps. Cancelled-trip info is
also included in this feed.

## Other available endpoints (not used yet, useful for features)

- `/transit/VehicleMonitoring?agency=` — live vehicle positions.
- `/transit/lines?operator_id=` — routes per agency.
- `/transit/patterns?operator_id=&line_id=` — ordered stop lists per route.
- `/transit/stopplaces?operator_id=` — richer stop metadata.
- `/transit/servicealerts` / GTFS-RT feeds — alerts, trip updates (protobuf).
- `operator_id=RG` — consolidated regional GTFS feed.

## Attribution

511.org provides data free of charge but **requires acknowledgement of
511.org as the data provider** in published apps.
