# 08 — Data Model (SQLite)

Owner: `windows-service`. Engine: SQLite in **WAL** mode (Component 16). All
tables are local; ids come from `shared/src/ids.ts`.

## Tables (implemented — `windows-service/src/db/schema.ts`)

Status: `sessions`, `events`, `findings`, `runs`, `run_steps`, and `meta` are
implemented and covered by tests. `runs`/`run_steps` are written by the replay
engine (`Store.saveRun`, upsert after every change) and read by
`GET /v1/runs/:id`. Ingestion is idempotent on `events.id` and
`sessions.id`, and each batch is one transaction. `workflows`, `screenshots`
and `environment_reports` are defined below and land with their owning phases
(workflow files currently live on disk, e.g. `examples/workflows/`; screenshots
are recorded as SCREENSHOT events with sha256 + size only).


### `sessions`
| column        | type    | notes                              |
|---------------|---------|------------------------------------|
| `id`          | TEXT PK | session id                         |
| `started_at`  | INTEGER | epoch ms                           |
| `ended_at`    | INTEGER | nullable                           |
| `mode`        | TEXT    | safety mode                        |
| `target_kind` | TEXT    | `mock` \| `authorized` \| `observe`|
| `target_host` | TEXT    | host only                          |
| `metadata`    | TEXT    | JSON                               |

### `events`
| column      | type    | notes                                     |
|-------------|---------|-------------------------------------------|
| `id`        | TEXT PK |                                           |
| `session_id`| TEXT FK | → sessions.id                             |
| `seq`       | INTEGER | monotonic per session                     |
| `ts`        | INTEGER | epoch ms                                  |
| `tab_id`    | INTEGER | nullable                                  |
| `kind`      | TEXT    | event kind                                |
| `category`  | TEXT    | category                                  |
| `workflow`  | TEXT    | nullable workflow label                   |
| `severity`  | TEXT    | info/warn/error                           |
| `redacted`  | INTEGER | 1 (must be true to persist)               |
| `data`      | TEXT    | JSON (redacted)                           |

Indexes: `(session_id, seq)`, `(session_id, kind)`, `(ts)`, `(workflow)`.

### `workflows`
Saved replay workflow files (see `docs/04-replay-format.md`).

### `runs` / `run_steps`
Replay run records and per-step results (see replay format). `runs.target`
(JSON) stores the replay target including its **authorization record**, so the
authorization basis of every run is traceable. Added as a backward-compatible
column migration (`ADDED_COLUMNS` in `schema.ts`); `SCHEMA_VERSION` changes
only for breaking changes.

### `findings`
Analyzer output (see `docs/02` categories). Non-conclusive by construction:
each row has `observed_pattern`, `evidence`, `frequency`, `context`,
`possible_explanation`, `first_ts`, `last_ts`.

### `screenshots`
| `id` | `session_id` | `event_id` | `path` | `sha256` | `trigger_action` | `ts` |

### `environment_reports`
Per-session environment snapshot (Component 8) for cross-session comparison.

## IndexedDB (extension side)

The extension keeps a short-lived ring buffer in IndexedDB for offline
buffering only; the service's SQLite database is the durable store. The buffer
is drained to the service on reconnect (Component 2 / Phase 4).

## Retention

Operator-controlled. Service exposes purge-session and vacuum operations. No
automatic off-box movement of any data.
