# @lab/windows-service

Local background service: the hub between the extension and the rest of the lab.
**Zero runtime dependencies** — built on `node:http`, `node:sqlite`, and
`node:crypto`.

Implements Component 2 (background service) and Component 13 (security) for
Phase 3. The Windows-service *installation* wrapper (auto-start on boot,
Services registration) is layered on in Phase 15; the crash-recovery supervisor
(`watchdog`) is here already.

## Run

```bash
# Service (foreground):
node --experimental-strip-types --experimental-sqlite src/index.ts

# Under the crash-recovery supervisor:
node --experimental-strip-types --experimental-sqlite src/watchdog.ts
```

Config comes from env (see repo `.env.example`): `LAB_SERVICE_HOST`
(loopback-only, enforced), `LAB_SERVICE_PORT`, `LAB_DATA_DIR`, `LAB_AUTH_TOKEN`
(auto-generated to `<dataDir>/auth-token.txt` if unset), `LAB_SAFETY_MODE`,
`LAB_ALLOWED_ORIGINS`, `LAB_LOG_LEVEL`.

## API (localhost only)

All routes require `Authorization: Bearer <token>` except `/healthz`. All are
Host-validated (anti DNS-rebinding) and Origin-validated (web origins rejected),
and rate-limited.

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/healthz` | liveness (no auth) |
| POST | `/v1/sessions` | create a recording session → `{sessionId}` |
| POST | `/v1/sessions/:id/end` | end a session |
| GET  | `/v1/sessions` | list sessions |
| GET  | `/v1/sessions/:id` | session + event count |
| GET  | `/v1/sessions/:id/events` | events for a session |
| POST | `/v1/events` | ingest a batch `{events:[...]}` → `{stored,quarantined,invalid}` |

Ingested events are validated against the shared contract (un-redacted events
are rejected), re-redacted defensively, and quarantined if anything still looks
sensitive. Every accepted event is published to the in-process event bus for
consumers (analyzer, dashboard live-feed).

## Security invariants

- Binds `127.0.0.1` only; refuses non-loopback hosts at startup.
- Bearer-token auth (constant-time compare); token never logged in full.
- Host + Origin validation; per-(token,route) fixed-window rate limiting.
- 2 MiB request-body cap; structured JSON rolling logs.

## Tests

```bash
node --test --experimental-strip-types --experimental-sqlite test/*.test.ts
```

Covers auth, request-security (host/origin/rate-limit), persistence, defensive
redaction at rest, crash recovery (data survives restart; supervisor restarts a
crashing child with backoff and single-instance lock), and full HTTP ingestion.
