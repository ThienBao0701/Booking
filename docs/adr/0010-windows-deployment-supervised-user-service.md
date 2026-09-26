# ADR-0010 — Windows deployment: per-user supervised service via Task Scheduler

- Status: Accepted for Phase 15 — **founder confirmation requested** on
  decision 1 (it replaces the earlier *plan* of an SCM service with a
  job-object wrapper; see "Alternatives").
- Date: 2026-09-26
- Amends: README "Production deployment" (planned `setup.exe` / Windows
  service with job-object supervision), docs/13-windows-service-setup.md,
  docs/11-installation.md. Module boundaries unchanged; the service API is
  unchanged except an additive `config` field on `/healthz`.

## Context

Phase 15 requires an installer, uninstaller, service registration, startup
configuration, log rotation, health monitoring, crash recovery and
configuration management, verified by clean install, upgrade, uninstall,
restart, crash recovery, corrupted config, unavailable port, extension
reconnect and reboot tests.

The lab is a single-operator tool: the recorder runs in the operator's
browser session, the pairing token and data live in the operator's profile,
and the API is loopback-only. Node.js cannot act as a Service Control Manager
(SCM) service by itself: SCM requires a native wrapper executable (e.g. WinSW,
NSSM), which would be a new third-party binary in the trust chain that cannot
be built or verified in this repository's CI.

## Decisions

1. **Registration: a per-user Task Scheduler task** (`AutomationLab`) that
   starts the supervisor at logon (so also after every reboot), as the
   operator, with `LeastPrivilege` and an interactive token (never elevated),
   hidden, no execution time limit, one instance, restart on failure. Created
   from a generated task XML (`schtasks /Create /XML`), no admin rights.
2. **The supervisor is the service host** (`watchdog.ts`): restart with
   backoff, health monitoring of `/healthz` (a hung service is killed and
   restarted), graceful stop over IPC, and **no orphans**: the service exits
   when its supervisor disappears (IPC disconnect) — the portable replacement
   for a job object. Port-in-use (exit 3) and configuration errors (exit 78)
   are reported and retried with a long backoff. State in
   `data\supervisor.json`, events in the rolled `supervisor.log`.
3. **Private runtime, versioned releases.** The installer copies the running
   Node.js binary into `runtime\<version>\` (no download) and the service code
   into `app\<version>-<stamp>\`. `current.json` records the active and the
   previous release.
4. **Upgrade = stage, stop, switch, start, verify; roll back on failure.** If
   the new release does not answer `/healthz` in time, the previous release is
   re-registered and started; data and configuration are never touched by an
   upgrade. Two releases are kept.
5. **Configuration management**: `data\config.json`, strictly validated
   (loopback host only, known keys, ranges); environment variables still take
   precedence. A corrupted/invalid file falls back to the last good copy, else
   to the built-in defaults — never to anything wider — and `/healthz`
   reports `config: "recovered"`. Writes are atomic with a `.bak`.
6. **Log rotation** by size and count (`logMaxBytes`, `logMaxFiles`) for the
   service, supervisor and native-host logs.
7. **Uninstall** stops everything, deletes the task, the native host
   (registry + files), releases and runtime; data is kept unless
   `--purge-data`.

## Alternatives

- **SCM service through a wrapper (WinSW/NSSM)** with a job object: boot-time
  start without logon and SCM recovery actions. Rejected for now: third-party
  binary in the trust chain, runs outside the operator's profile/session
  (token, data, browser), and exposes a loopback port to every local user
  while no one is logged on. It can be layered later without code changes:
  the wrapper would run the same supervisor command line.
- **`setup.exe` (Inno Setup / WiX)**: packaging only; it would call the same
  `lab install`. Not buildable or testable in this repository's CI.

## Consequences

- Everything but Task Scheduler itself is exercised by tests on any OS; the
  task definition is generated and checked, and the E2E test runs exactly the
  registered action. Execution on a real Windows machine remains to be
  verified by the operator (docs/21 has the checklist).
- The service runs only while the operator is logged on (by design).
