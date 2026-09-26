# @lab/mock-extranet

A **safe, fully-local** mock of an Extranet-style partner portal (Component 11).
It is the default-authorized replay target for the lab: it holds no real
credentials, reaches no real system, and emits **production-shaped workflow
events** so the whole Automation Lab can be exercised without touching a
production account.

Zero runtime dependencies (`node:http`).

## Run

```bash
node --experimental-strip-types src/index.ts
# → http://127.0.0.1:4599  (MOCK_EXTRANET_HOST / MOCK_EXTRANET_PORT to override)
```

Open the UI at `/`. Each module (Login, Property, Rooms, Rates, Reservations,
Messages, Reviews, Photos, Reports) has forms with **stable ids and
`data-action` / `data-view` attributes** so the replay engine can target them.

## Modules → workflow labels

| Module | Action | Emitted workflow |
|--------|--------|------------------|
| Login | log in (username only) | `LOGIN` |
| Property | create / activate | `PROPERTY_SETUP` |
| Rooms | create | `ROOM_SETUP` |
| Rates | set rate | `RATE_SETUP` |
| Reservations | create | `RESERVATION` |
| Reservations | cancel | `CANCELLATION` |
| Messages | send | `MESSAGING` |
| Reviews | add | `REVIEW` |
| Photos | upload (metadata only) | `PHOTO` |
| Reports | generate | `REPORTING` |

## Safety / privacy in the mock itself

- **No passwords.** Login accepts a username only; there is no password field and
  nothing secret is ever stored.
- **Photos are metadata only** — filename + size, no bytes.
- **Messages/reviews** emit length/rating in the event feed, not the free text.

## API (JSON)

`POST /api/login|logout`, `POST /api/properties`, `POST /api/properties/:id/activate`,
`POST /api/rooms`, `POST /api/rates`, `POST /api/reservations`,
`POST /api/reservations/:id/cancel`, `POST /api/messages`, `POST /api/reviews`,
`POST /api/photos`, `POST /api/reports`; `GET /api/properties|rooms|reservations`,
`GET /api/events?since=N`, `GET /api/timeline`, `GET /healthz`.

## Tests

```bash
node --test --experimental-strip-types test/*.test.ts
```

Covers domain transitions, the login guard, the full workflow sequence (asserts
the documented label order), privacy of messaging, and the HTTP API end-to-end.
