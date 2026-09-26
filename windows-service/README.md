# @lab/windows-service

Local background service: the hub between the extension, the automation engine
and (later) the dashboard. **Zero runtime dependencies** — `node:http`,
`node:sqlite`, `node:crypto`.

Implements Component 2 (background service), Component 13 (security), and
hosts the automation engine (Components 3 and 5: BrowserController + replay).
Windows auto-start: [docs/13-windows-service-setup.md](../docs/13-windows-service-setup.md).

## Run

```bash
pnpm run start:service      # foreground
pnpm run start:watchdog     # under the crash-recovery supervisor
pnpm run replay <workflow.json> [--dry-run] [--mode SIMULATE] [--param k=v]
```

Config comes from env (see repo `.env.example` and
[docs/11-installation.md](../docs/11-installation.md)): `LAB_SERVICE_HOST`
(loopback-only, enforced), `LAB_SERVICE_PORT`, `LAB_DATA_DIR`, `LAB_AUTH_TOKEN`
(auto-generated to `<dataDir>/auth-token.txt` if unset), `LAB_SAFETY_MODE`,
`LAB_ALLOWED_ORIGINS`, `LAB_LOG_LEVEL`.

## API (127.0.0.1 only)

All routes require `Authorization: Bearer <token>` except `/healthz`. All are
Host-validated (anti DNS-rebinding), Origin-validated (web origins rejected),
rate-limited, size-limited and time-limited.

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/healthz` | liveness (no auth) |
| GET  | `/v1/bridge/handshake` | contract check for the extension bridge (service, contract version, batch limit) |
| POST | `/v1/sessions` | register a session — **idempotent** (201 created / 200 existed) |
| POST | `/v1/sessions/:id/end` | end a session (optional client `endedAt`, bounded) |
| GET  | `/v1/sessions` | list sessions |
| GET  | `/v1/sessions/:id` | session + event count |
| GET  | `/v1/sessions/:id/events` | events for a session (ordered by seq) |
| GET  | `/v1/sessions/:id/workflow?name=&baseUrl=` | replayable workflow **draft** from a recording (mock target only) |
| POST | `/v1/events` | ingest `{events:[…]}` (≤ 500) → `{stored, quarantined, duplicates, invalid, invalidDetail[]}` |
| GET  | `/v1/runs/:id` | persisted replay run record |

Ingestion validates each event against the shared contract, re-redacts
defensively, quarantines payloads that still look sensitive, stores the batch
in **one transaction**, ignores duplicates (safe retries), and reports events of
unknown sessions per event as `UNKNOWN_SESSION` instead of failing the batch.

## Automation engine (`src/automation/`)

- `controller.ts` — `BrowserController` interface + `ControllerError`.
- `mock-controller.ts` + `mock-page-map.ts` — drives the mock Extranet with
  browser semantics; loopback only; bound to one origin.
- `engine.ts` — `ReplayEngine`: authorize → launch → start / pause / resume /
  stop / step / retry / checkpoint / rollback / dryRun. See
  [docs/04-replay-format.md](../docs/04-replay-format.md).
- `convert.ts` — recording → workflow draft.
- `cli.ts` — `lab-replay`.

## Security invariants

- Binds `127.0.0.1` only; refuses non-loopback hosts at startup.
- Bearer-token auth (constant-time compare); token never logged.
- Host + Origin validation; per-(token, route) fixed-window rate limiting.
- 2 MiB body cap, 500 events per batch, header/request timeouts.
- Replay authorization before any controller call; mock targets must be local.

## Tests

```bash
pnpm run test:service
```

Covers auth, request security, persistence, redaction at rest, idempotent
ingestion, handshake, crash recovery (data survives restart; supervisor
restarts with backoff; single-instance lock), portable entry-point detection,
the controller (17), the replay engine (22), the recording converter and the
HTTP routes. Cross-package E2E lives in `tests/e2e`.
