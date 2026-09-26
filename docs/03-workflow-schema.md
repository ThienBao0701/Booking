# 03 — Workflow Schema

Canonical definition: `shared/src/workflow/types.ts`.

## Workflow labels

Extranet-style workflow labels the recorder detects and the analyzer reasons over:

`LOGIN` · `PROPERTY_SETUP` · `ROOM_SETUP` · `RATE_SETUP` · `RESERVATION`
· `CANCELLATION` · `MESSAGING` · `REVIEW` · `PHOTO` · `REPORTING` · `UNKNOWN`.

## Session record (recorder output)

Each recording session produces:

```jsonc
{
  "sessionId": "01J...",
  "startedAt": 1750000000000,
  "endedAt":   1750000600000,
  "mode": "OBSERVE",                 // safety mode in effect
  "target": { "kind": "mock", "host": "mock-extranet.local" },
  "tabs": [ { "tabId": 12, "openedAt": 1750000000100 } ],
  "timeline": [
    { "ts": 1750000063000, "workflow": "LOGIN",       "eventId": "01J..." },
    { "ts": 1750000081000, "workflow": "PROPERTY_SETUP", "eventId": "01J..." },
    { "ts": 1750000197000, "workflow": "ROOM_SETUP",  "eventId": "01J..." },
    { "ts": 1750000309000, "workflow": "RATE_SETUP",  "eventId": "01J..." },
    { "ts": 1750000494000, "workflow": "RESERVATION", "eventId": "01J..." },
    { "ts": 1750000592000, "workflow": "CANCELLATION","eventId": "01J..." }
  ],
  "metadata": { "extensionVersion": "0.1.0", "labVersion": "0.1.0" }
}
```

Rendered timeline (dashboard / report):

```
10:21:03  LOGIN
10:21:21  PROPERTY_PAGE
10:23:17  ROOM_EDIT
10:25:09  RATE_UPDATE
10:28:14  RESERVATION
10:29:52  CANCELLATION
```

## Workflow detection

Detection is heuristic and declarative: a small ruleset maps
(url pattern, page markers, event kind) → workflow label. Rules live in config,
not hard-coded logic, so they can be tuned without code changes (Engineering
Bible: business rules belong in configuration). A detection that is ambiguous
yields `UNKNOWN` rather than a guess.

## Per-step record

| Field       | Type    | Notes                                        |
|-------------|---------|----------------------------------------------|
| `sessionId` | string  |                                              |
| `timestamp` | integer | epoch ms                                     |
| `tabId`     | integer |                                              |
| `page`      | string  | logical page/route label                     |
| `action`    | string  | e.g. `navigate`, `click`, `submit`           |
| `element`   | object? | role/label/selector (no values)              |
| `workflow`  | enum    | workflow label                               |
| `metadata`  | object  | free-form, redacted                          |
