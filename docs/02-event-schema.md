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
- `FORM_ACTIVITY` — change/submit on a field: structural descriptor plus `filled: true|false`. Field **values are never read**; sensitive fields (password, OTP, card, IBAN, token, …) are recorded as `sensitive: true` without even a filled bit.
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

`redacted` MUST be `true` before an event is persisted. The recorder's
`toLabEvent` conversion always runs `shared/src/redaction` and then sets it. The
service re-validates and re-runs redaction defensively:

- an event that fails validation (e.g. `redacted !== true`) is **rejected and
  reported** per event in the ingestion response (`invalidDetail[]` with
  `code: "INVALID_EVENT"`), never stored;
- an event whose payload still looks sensitive after redaction is stored with
  its `data` replaced by a quarantine marker (the raw payload never reaches disk).

Note: the post-redaction check also scans JSON numbers, so a number of 9+ digits
inside `data` (e.g. an epoch-ms timestamp) triggers quarantine. Put times in the
envelope (`ts`), never in `data`. See `docs/06-privacy-model.md`.

## Recorder view (standardized recorder schema)

Canonical definition: `shared/src/events/recorded.ts`. The extension's recorder
works with `RecordedEvent`, whose fields are the standardized recorder schema.
It converts losslessly to the wire envelope above (the service contract is
unchanged):

| RecordedEvent | LabEvent (wire)        | Notes |
|---------------|------------------------|-------|
| `event_id`    | `id`                   | sortable id |
| `session_id`  | `sessionId`            | |
| `seq`         | `seq`                  | gap-free per session (assigned after dedup) |
| `timestamp`   | `ts`                   | epoch ms |
| `tab_id`      | `tabId`                | optional |
| `page`        | `data.page`            | **path only** — query string and fragment are dropped, path redacted |
| `workflow`    | `workflow`             | detected label, `UNKNOWN` when ambiguous |
| `action`      | `data.action` → `kind` | see mapping below |
| `target`      | `data.target`          | structural element descriptor, never a value |
| `metadata`    | `data.metadata`        | redacted; raw-content keys (`value`, `innerText`, …) stripped |
| `severity`    | `severity`             | default `info` (`error` for `error` actions) |

Recorder actions → event kinds:

| action | kind |
|---|---|
| `session_start`, `session_end` | `SESSION_CHANGE` |
| `tab_created`, `tab_activated`, `tab_updated`, `tab_closed` | `TAB_LIFECYCLE` |
| `navigate` | `NAVIGATION` |
| `page_load`, `page_state` | `PAGE_STATE` |
| `dom_change` | `DOM_CHANGE` |
| `click` | `CLICK` |
| `input`, `change`, `submit` | `FORM_ACTIVITY` |
| `screenshot` | `SCREENSHOT` |
| `http` | `HTTP_STATUS` |
| `workflow_transition` | `WORKFLOW_TRANSITION` |
| `error` | `ERROR` |

Example (a click in the mock's reservations view):

```jsonc
{
  "event_id": "01M3E3772WR1AV800WAX1XZBX3",
  "session_id": "session_01M3E36Z…",
  "seq": 42,
  "timestamp": 1790400813248,
  "tab_id": 7,
  "page": "/",
  "workflow": "CANCELLATION",
  "action": "click",
  "target": { "tag": "button", "selector": "button[data-cancel]" },
  "metadata": {}
}
```

### Recorder pipeline guarantees

- **Debounce:** DOM mutations are summarized per quiet period (default
  500 ms, max wait 5 s); deliveries are debounced (default 2 s, max 10 s).
- **Batching / queue:** events are micro-batched into an IndexedDB queue and
  delivered in batches (default 50, max 500 per request).
- **Retry:** transient failures back off exponentially with jitter (1 s → 60 s);
  auth/origin/contract failures pause delivery **without dropping data**.
- **Deduplication:** by `event_id` and by identical content within 250 ms
  (session/transition events excluded); dedup happens before `seq` assignment.
- **Workflow transitions:** a `workflow_transition` event (`metadata.from/to`)
  precedes the first event of a new workflow in a tab.
- **Environment facts (optional):** `session_start.metadata.environment` and
  the first `page_state.metadata.environment` of a tab carry read-only
  diagnostic facts ([06-privacy-model](06-privacy-model.md#environment--fingerprint-report-component-8));
  the analyzer's environment report cites these events.
