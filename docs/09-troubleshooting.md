# 09 — Troubleshooting

## Toolchain

- **`node --test` fails with a syntax error on `.ts`** — requires Node ≥ 22
  (type-stripping + `node:sqlite`). Check `node -v`.
- **`tsc` / `esbuild` not found** — run `pnpm install` at the repo root (the dev
  toolchain is declared in the root `package.json`, locked in `pnpm-lock.yaml`).
- **Lint fails with `boundary/…`** — a package imports a sibling or imports
  `shared` outside its `src/shared.ts`; see `docs/01-architecture.md` §3.
- **`pnpm install` marks `src/index.ts` executable** — pnpm links workspace
  `bin` entries; restore with `chmod 644` (no content change).

## Service

- **Extension cannot reach the service** — is it running
  (`pnpm run start:service`)? `curl http://127.0.0.1:4577/healthz` should return
  `{"status":"ok",…}`.
- **`401 Unauthorized`** — token mismatch. Copy
  `<LAB_DATA_DIR>/auth-token.txt` into the extension Options and click
  **Test connection**. The popup shows `Delivery paused (auth)`; queued events
  are kept and delivered after re-pairing.
- **`403 forbidden_origin` / `forbidden_host`** — a web page (not the extension)
  called the API, the Host header is not the bound loopback host:port, or
  `LAB_ALLOWED_ORIGINS` pins a different extension id.
- **`413` / `400` on `/v1/events`** — batch > 500 events or body > 2 MiB / bad
  JSON; the bridge splits batches automatically.
- **Service died** — run it under the watchdog (`pnpm run start:watchdog`); it
  restarts with backoff. Data survives restarts (SQLite WAL); the extension
  keeps queued events and resends them (duplicates are ignored).
- **`another watchdog is running`** — a live watchdog holds
  `<LAB_DATA_DIR>/watchdog.lock`; a stale lock (dead pid) is taken over
  automatically.
- **Events stored with `{"quarantined":true}`** — the payload still looked
  sensitive after redaction (e.g. an email, a long digit run, or a 9+ digit
  number such as an epoch timestamp inside `data`). Keep times in the envelope.

### Deployed service (Phase 15)

- **`lab status` says the service is not answering** — read
  `data\logs\supervisor.log`: `supervisor_port_in_use` (another program holds
  the port: free it or `lab config set port=…` + `lab restart`),
  `supervisor_config_error` (an invalid `LAB_*` environment variable),
  `supervisor_unhealthy` (the service stopped answering and was restarted).
- **`/healthz` shows `"config": "recovered"`** — `config.json` is corrupted or
  invalid; the service runs on the last good copy or safe defaults.
  `lab config validate` names the problem; fix it with `lab config set …`.
- **An upgrade reports "rolled back"** — the new release did not become
  healthy; the previous one is running. Check `service.log` for the new
  release's start-up error.

## Extension

- **Popup says "not paired"** — set the token in Options.
- **Nothing recorded on a site** — only loopback and origins you added in
  Options are recordable; after adding an origin, reload its tabs (the content
  script is registered for new page loads). Check the REC badge is on.
- **Bridge state `offline`** — the service is down; events wait in IndexedDB
  and are flushed automatically on reconnect (backoff up to 60 s, plus a 30 s
  alarm).
- **Bridge state `incompatible`** — the service's contract version differs or
  the URL is not a lab service; update both to the same release.
- **Chrome asks about local network access** — allow it for the extension if
  your Chrome version prompts; the service is on 127.0.0.1 only.
- **Popup shows `HTTP (fallback)`** — the native host is not installed for
  this extension id, or it refused the connection; hover the value for the
  reason. Check `pnpm run native-host:status` and `<LAB_DATA_DIR>/logs/native-host.log`.
  Chrome's own messages: *Specified native messaging host not found* (not
  registered for this browser/profile), *Access to the specified native
  messaging host is forbidden* (extension id not in `allowed_origins`:
  re-run install with the right `--extension-id`), *Native host has exited*
  (see the host log; `host_misconfigured` means the host config is missing or
  invalid — reinstall).
- **Changes to options not applied** — the service worker reloads config on
  every save; a service URL that is not loopback is rejected and the default
  `http://127.0.0.1:4577` is used.

## Replay

- **`denied: … (MODE_FORBIDS_SIDE_EFFECTS)`** — OBSERVE never replays; use
  `--mode SIMULATE` for the mock.
- **`MOCK_TARGET_NOT_LOCAL`** — a `mock` target must be 127.0.0.1/localhost;
  for any other system use `kind: "authorized"` + an authorization record +
  `AUTHORIZED_AUTOMATION` (and a browser-backed controller adapter).
- **`missing parameter: x`** — supply `--param x=value` or `--params-file`;
  `--dry-run` lists all required parameters.
- **`NOT_VISIBLE`** — the element is in another view; add a navigation click
  (e.g. `button[data-view="rooms"]`) before it.
- **`OPTION_NOT_FOUND` / `UNRESOLVED_REFERENCE`** — `$last` needs an entity
  created earlier in the same run; create it first or pass a real id.
- **`no element matches …` on a converted recording** — the recording touched
  an element the target does not have; remove that step from the draft.
- **Step timeout** — raise `timeoutMs` for the step or `defaults.timeoutMs`;
  transient failures retry up to `retries`.
- **Rollback did not undo data in the mock** — by design: rollback restores
  the page model and run position only (ADR-0004).

## Tests

- **E2E suite reuses my running mock** — by design (`ensureMock()`); it creates
  test entities there but never stops or restarts it. Set `MOCK_EXTRANET_URL`
  to a different loopback port to isolate.
- **Browser E2E skipped** — install Chromium for playwright-core
  (`node node_modules/playwright-core/cli.js install chromium`) or set
  `LAB_CHROMIUM_PATH`.
