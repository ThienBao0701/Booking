# 11 — Installation

This is the developer/operator installation for the current release (Phases
0–7). A packaged Windows installer (`setup.exe`) is planned for Phase 15; until
then the components run from a checkout with Node.js.

## Prerequisites

| Component | Version | Why |
|---|---|---|
| Node.js | **22.x** (≥ 22.6) | TypeScript type-stripping + built-in `node:sqlite` (no build step, no native modules) |
| pnpm | 10.x (`corepack enable`) | locked dev toolchain (`pnpm-lock.yaml`) |
| Chrome / Edge / Chromium | ≥ 116 | MV3 extension |
| OS | Windows 10/11, macOS, Linux | everything binds to 127.0.0.1 only |

## 1. Get the code and the toolchain

```bash
git clone <this repository> browser-automation-lab
cd browser-automation-lab
corepack enable            # provides pnpm 10
pnpm install               # typescript, esbuild, type definitions, playwright-core (driver only)
pnpm run verify            # lint + typecheck + unit + E2E + extension build
```

The core packages have **no runtime dependencies**; `pnpm install` only
fetches build/test tooling. Unit and E2E tests even run without it:
`node --test --experimental-strip-types --experimental-sqlite shared/test/*.test.ts …`.

## 2. Start the local service

```bash
pnpm run start:service       # foreground; or: pnpm run start:watchdog (auto-restart)
curl http://127.0.0.1:4577/healthz
```

On first start the service creates `LAB_DATA_DIR` (default `./.lab-runtime`)
containing `lab.sqlite` (WAL), `logs/` and **`auth-token.txt`** — the pairing
token for the extension. For boot-time auto-start on Windows see
[13 — Windows service setup](13-windows-service-setup.md).

## 3. Start the mock Extranet (safe target)

```bash
pnpm run start:mock          # http://127.0.0.1:4599
```

## 4. Build and load the extension

```bash
pnpm run build:extension     # → extension/dist (verified)
```

Load `extension/dist` as an unpacked extension and pair it with the token — see
[12 — Chrome extension setup](12-chrome-extension-setup.md).

## 5. Record, then replay

1. Toolbar icon → **Start recording**; use http://127.0.0.1:4599; **Stop**.
2. Turn the recording into a draft workflow:
   `GET http://127.0.0.1:4577/v1/sessions/<sessionId>/workflow` (bearer token).
3. Or run the bundled example against the mock:

   ```bash
   pnpm run replay:example                         # SIMULATE mode, mock target
   pnpm run replay examples/workflows/mock-full-flow.json --dry-run --params-file examples/workflows/mock-full-flow.params.json
   ```

## 6. Open the dashboard

```bash
pnpm run build            # extension + dashboard
pnpm run dashboard:url    # → http://127.0.0.1:4577/dashboard/#token=…
```

See [15 — Dashboard](15-dashboard.md).

## Configuration (environment)

| Variable | Default | Notes |
|---|---|---|
| `LAB_SERVICE_HOST` | `127.0.0.1` | loopback only (`127.0.0.1`, `localhost`, `::1`); anything else is refused |
| `LAB_SERVICE_PORT` | `4577` | |
| `LAB_DATA_DIR` | `./.lab-runtime` | SQLite, logs, token, watchdog lock |
| `LAB_AUTH_TOKEN` | generated | set only to pin a token (≥ 16 chars) |
| `LAB_SAFETY_MODE` | `OBSERVE` | reported to the extension via health/handshake |
| `LAB_ALLOWED_ORIGINS` | *(any extension)* | comma list, e.g. `chrome-extension://<id>` to pin |
| `LAB_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `LAB_DASHBOARD_DIR` | `dashboard/dist` | built dashboard served at `/dashboard/` |
| `MOCK_EXTRANET_HOST` / `_PORT` | `127.0.0.1` / `4599` | mock |
| `MOCK_EXTRANET_URL` | `http://127.0.0.1:4599` | E2E target (must be loopback) |

See `.env.example`.

## Upgrading

`git pull && pnpm install && pnpm run build:extension`, then reload the
extension in `chrome://extensions` and restart the service. The contract
version is checked by the bridge handshake; mismatched versions show bridge
state `incompatible` instead of sending data.

## Uninstall

1. Remove the extension in `chrome://extensions` (its IndexedDB queue and
   storage are deleted with it).
2. Stop the service (and remove the auto-start task, see doc 13).
3. Delete `LAB_DATA_DIR` (database, logs, token). Nothing is stored elsewhere.
