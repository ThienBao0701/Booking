# 21 — Windows Deployment (Phase 15)

`lab` installs, upgrades and removes the lab on Windows for the current user
(no administrator rights). Decision record:
[ADR-0010](adr/0010-windows-deployment-supervised-user-service.md).

## Install

Prerequisites: Node.js ≥ 22.6 on PATH (`winget install OpenJS.NodeJS.LTS`), a
checkout with `pnpm install` and `pnpm run build` done.

```bat
deploy\windows\lab.cmd install
:: optional: --port 4577 --safety-mode OBSERVE --extension-id <id> [--browser chrome|edge|chromium] [--no-start]
deploy\windows\lab.cmd status
```

(`pnpm run lab -- install …` does the same.) The installer:

1. copies the service (shared, windows-service, mock Extranet, examples, the
   built dashboard and extension) to `%LOCALAPPDATA%\AutomationLab\app\<version>-<stamp>\`
   and the Node.js runtime it runs on to `…\runtime\<node-version>\node.exe`;
2. writes `…\data\config.json` (validated) — `data\` is `LAB_DATA_DIR`
   (database, logs, token, screenshots, rules);
3. registers the Task Scheduler task **AutomationLab**: at logon of this user
   (10 s delay), least privilege, hidden, no time limit, one instance,
   restarted by Task Scheduler if the supervisor fails; action
   `runtime\…\node.exe … app\…\windows-service\src\watchdog.ts --data-dir …\data`;
4. with `--extension-id`, installs the native messaging host
   ([20-native-messaging](20-native-messaging.md)) pointing at this release;
5. starts the task and waits for `http://127.0.0.1:<port>/healthz`.

Then pair the extension with the token in `…\data\auth-token.txt`
([12](12-chrome-extension-setup.md)); load the unpacked extension from
`…\app\<release>\extension\dist` (a stable path).

## Operate

| Command | Effect |
|---|---|
| `lab status [--json]` | release, task registration, supervisor (running, restarts, last exit reason), `/healthz`, config source/problems, native host |
| `lab start` / `stop` / `restart` | `schtasks /Run` / `/End` (+ wait; the service exits with its supervisor) |
| `lab config show` / `validate` | current file, its source (`file`, `last-good`, `defaults`) and problems |
| `lab config set port=4600 safetyMode=SIMULATE` | validated, atomic write (`config.json.bak` kept); then `lab restart` |

Settings (`config.json`): `host` (loopback only), `port`, `safetyMode`,
`allowedOrigins` (`chrome-extension://<id>`), `logLevel`, `logMaxBytes`,
`logMaxFiles`, `dashboardDir`, `workflowsDir`, `healthIntervalMs`,
`healthFailures`. Environment variables (`LAB_*`) still override the file.

## Reliability

| Situation | Behaviour |
|---|---|
| Service crashes | supervisor restarts it (1 s → 30 s backoff; reset after 10 s healthy) |
| Service hangs | `/healthz` polled every `healthIntervalMs` (15 s); after `healthFailures` (3) misses it is killed and restarted |
| Supervisor crashes / is ended | the service notices (IPC) and exits cleanly; Task Scheduler restarts the supervisor (restart on failure) — no orphaned process holding the port |
| Reboot | the task starts at logon; same data and token, so the extension reconnects without re-pairing and sends what it queued |
| Port already in use | service exits with code 3, logged as `port_in_use`; retried with a long backoff until the port is free |
| Corrupted / invalid `config.json` | last good copy, else safe defaults (loopback, 4577, OBSERVE); logged as `config_invalid`; `/healthz` shows `"config": "recovered"`; `lab config validate` explains |
| Invalid environment settings | exit code 78, logged as `config_error`, retried |
| Disk full / log write fails | logging never crashes the service |

Logs (`data\logs\`): `service.log`, `supervisor.log`, `native-host.log`, each
rolled at `logMaxBytes` (5 MiB; native host 2 MiB) keeping `logMaxFiles` (5;
native host 3) older files.

## Upgrade

```bat
git pull && pnpm install && pnpm run build
deploy\windows\lab.cmd upgrade
```

The new release is staged next to the current one; the service is stopped,
the task re-pointed, started and health-checked. If it does not become healthy
in time, the previous release is registered and started again (`status`
shows the release in use). Data and configuration are never modified by an
upgrade; two releases are kept. The native host is re-pointed automatically.

## Uninstall

```bat
deploy\windows\lab.cmd uninstall            :: keeps data\ (recordings, findings, token, config, logs)
deploy\windows\lab.cmd uninstall --purge-data
```

Stops the supervisor and service, deletes the task, removes the native host
(registry keys and files), the releases and the runtime. Run it with the Node
on PATH (the `.cmd` does), not the bundled runtime.

## Verification checklist on Windows

The flows are tested on Linux with a simulated Task Scheduler that runs the
exact registered action (see Tests). On a Windows machine, verify once:

1. `lab install` → `lab status` all ✔; `Get-ScheduledTask AutomationLab`.
2. Sign out and in (or reboot) → `lab status` healthy; the extension popup
   shows *connected* without re-pairing.
3. `Stop-Process -Name node -Force` → within a minute `lab status` is healthy
   again (Task Scheduler restart on failure + supervisor).
4. `lab upgrade` → healthy on the new release; `lab uninstall` → no `node.exe`
   of the lab left (`Get-CimInstance Win32_Process`), task gone.

## Tests

- `windows-service/test/deploy.test.ts` — task XML (logon trigger, least
  privilege, restart on failure, hidden, UTF-16 BOM, escaping), command-line
  quoting, clean install, upgrade keeping data/config/token, pruning, failed
  upgrade → rollback, native host re-pointed, uninstall (keep / purge),
  status, CLI guards.
- `windows-service/test/supervisor.test.ts` — crash recovery of the real
  service, hung-service detection, graceful stop over IPC, no orphans when the
  supervisor dies, port in use then freed, configuration error exit.
- `windows-service/test/config-file.test.ts` — validation, env precedence,
  last-good/defaults recovery, atomic writes, the service on a corrupted
  config, port-in-use exit code, log rotation limits.
- `tests/e2e/deploy.e2e.test.ts` — real processes: install → extension
  delivers → reboot (power loss, then logon) → reconnect with the queued
  events → restart → broken upgrade rolled back → uninstall with no process
  left and data kept.
