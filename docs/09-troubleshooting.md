# 09 — Troubleshooting

## Shared core (available now)

- **`node --test` fails with a syntax error on `.ts`** — requires Node ≥ 22.
  Check `node -v`. The shared package uses erasable TypeScript + type stripping.
- **Type errors** — run `pnpm -C shared typecheck`. The shared package must stay
  zero-runtime-dependency and erasable-syntax only (`erasableSyntaxOnly` in
  `tsconfig.base.json`), so no `enum` / `namespace` / parameter-properties.

## Service (Phase 3+)

- **Extension cannot reach the service** — confirm the service is running and
  bound to `127.0.0.1:<port>`; check the auth token file exists and the
  extension has the same token; check the health endpoint
  `GET http://127.0.0.1:<port>/healthz`.
- **`401 Unauthorized`** — token mismatch; re-run the pairing step so the
  extension and service share the token.
- **`403 Forbidden` on control routes** — `Origin`/`Host` validation rejected
  the request (possible DNS-rebinding guard); ensure you are calling from the
  extension or `127.0.0.1`.
- **Service died / recovered** — the watchdog restarts it and replays the WAL;
  check rolling logs for the crash record. Buffered extension events drain on
  reconnect.

## Replay

- **"target not authorized"** — the target is neither `mock` nor an `authorized`
  target with an authorization record; either switch to `mock`/`SIMULATE` or
  supply the authorization record and `AUTHORIZED_AUTOMATION` mode.
- **Step timeout** — increase `defaults.timeoutMs` or the step's `timeoutMs`;
  use `dry-run` to validate the plan without side effects.

## Data / performance

- **Database locked** — WAL should prevent this; ensure only one service
  instance runs (the watchdog enforces a single instance via a lock file).
- **High disk writes** — event batching + debounce are tunable in config; see
  `docs/16 performance` notes in the README.
