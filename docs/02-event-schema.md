# 02 — Event Schema

Canonical definition: `shared/src/events/types.ts` (+ `validate.ts`).
This document explains the shape and the rules; the code is authoritative.

## Envelope

Every event shares one envelope:

| Field         | Type     | Notes                                                       |
|---------------|----------|-------------------------------------------------------------|
| `id`          | string   | ULID-like, globally unique (`shared/src/ids.ts`)            |
| `sessionId`   | string   | The recording session this event belongs to                |
| `seq`         | integer  | Monotonic per-session sequence (ordering key)              |
| `ts`          | integer  | Epoch milliseconds (UTC)                                    |
| `tabId`       | integer? | Browser tab id when applicable                             |
| `kind`        | enum     | One of the event kinds below                                |
| `category`    | enum     | Coarse grouping used by analyzer/dashboard filters          |
| `workflow`    | enum?    | Detected workflow label (see `docs/03-workflow-schema.md`) |
| `severity`    | enum     | `info` \| `warn` \| `error`                                 |
| `redacted`    | boolean  | True once redaction has run over `data`                     |
| `data`        | object   | Kind-specific payload (already redacted)                    |

## Event kinds

Aligned to Component 6 rule categories:

- `NAVIGATION` — url change, history push/replace, load complete.
- `TAB_LIFECYCLE` — created / activated / updated / removed.
- `PAGE_STATE` — ready-state / route / view detection.
- `DOM_CHANGE` — debounced mutation summary (counts + selectors, never values).
- `FORM_ACTIVITY` — focus/change/submit on a field (field **name only**, never value unless allow-listed non-sensitive).
- `CLICK` — element click (role/label/selector).
- `SESSION_CHANGE` — session start/end, auth-state transition (boolean only).
- `SCREENSHOT` — screenshot captured (path/hash + trigger action).
- `HTTP_STATUS` — observed request/response metadata (see below).
- `WORKFLOW_TRANSITION` — recorder detected a workflow boundary.
- `ERROR` — page error, failed request, extension/service error.

## HTTP observability payload (`HTTP_STATUS`)

Forensic/debugging metadata **only** — never request/response bodies, headers
with credentials, cookies, or tokens:

```jsonc
{
  "method": "GET",
  "endpointCategory": "reservations",   // coarse category, not full URL by default
  "urlHost": "mock-extranet.local",     // host only
  "status": 200,
  "requestMs": 12,
  "responseMs": 143,
  "redirected": false,
  "redirectCount": 0,
  "retryCount": 0,
  "failed": false
}
```

The system **observes** timing/status/redirects/retries. It never modifies,
forges, or evades server-side security controls (Component 7).

## Category enum

`navigation` · `tab` · `page` · `dom` · `form` · `interaction` · `session`
· `media` · `network` · `workflow` · `error`.

## Ordering & determinism

Consumers sort by (`sessionId`, `seq`). `ts` is for display and timing
analysis; `seq` is the authoritative order because two events can share a
millisecond. See `shared/src/time.ts`.

## Redaction contract

`redacted` MUST be `true` before an event is persisted. The content script sets
it after applying `shared/src/redaction`. The service re-validates and re-runs
redaction defensively; an event failing validation is quarantined to the error
log, never silently dropped. See `docs/06-privacy-model.md`.
