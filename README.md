# STEALTH BROWSER AUTOMATION LAB

A **local, single-operator diagnostics & authorized-automation lab** for
browser / Extranet workflows. It lets you **observe → record → reproduce →
analyze → debug** your *own* workflows in a controlled lab — including a
bundled **mock Extranet** — instead of experimenting on a live production
account.

> ### Scope & safety (read this first)
>
> This is a **diagnostics / QA / authorized-automation** tool. Despite the
> project name, it is **not** an evasion tool and nothing in it is hidden: the
> extension shows a **REC** badge while recording, and controllers act as
> ordinary, identifiable clients. The following are **deliberately not
> implemented** and are enforced-unavailable in code (`shared/src/safety`),
> in the extension manifest policy, and in the lint:
> anti-detection · stealth evasion · fingerprint spoofing · IP rotation ·
> CAPTCHA bypass · bot-detection bypass · fake/synthetic human behavior.
>
> - Record only your **own** sessions. Field values, passwords, payment data,
>   tokens and auth secrets are never captured ([privacy model](docs/06-privacy-model.md)).
> - **Replay runs only against the bundled mock (loopback) or an
>   operator-declared authorized target**, decided before any action runs
>   ([safety modes](docs/07-safety-modes.md)).
> - Everything stays on this machine: services bind to 127.0.0.1; the extension
>   only talks to a loopback service.
> - Use it only on systems you own or are explicitly authorized to test, within
>   their Terms of Service and applicable law (see `LICENSE`).

## Status

| Phase | Component | State |
|------:|-----------|-------|
| 0 | Architecture, docs, `shared` contracts / safety / redaction | ✅ |
| 1 | MV3 extension (least privilege, service worker, content script, popup, options) | ✅ |
| 2 | Event recorder (standardized schema, debounce, batching, queue, retry, dedup) | ✅ |
| 3 | Local background service (loopback API, event bus, SQLite/WAL, watchdog) | ✅ |
| 4 | Bridge extension ↔ service (auth, origin, validation, timeout, reconnect, health) | ✅ |
| 5 | Mock Extranet (safe automation target) | ✅ |
| 6 | BrowserController interface + mock controller | ✅ |
| 7 | Replay engine (start/pause/resume/stop/step/retry/checkpoint/rollback/dryRun) + recording → workflow + CLI | ✅ |
| 8 | Analyzer: segmentation, timing, sequences, anomalies, comparison, correlation, graph, evidence + JSON rule engine | ✅ |
| 9 | Forensic dashboard at `/dashboard/`: overview, sessions + compare, timeline, workflow graph, events, findings drill-down, environment, runs, screenshots, settings | ✅ |
| 10 | Forensic reports: JSON · CSV (findings / events / evidence) · HTML · print-ready HTML, 11 sections, every finding linked to its exact event ids; API, CLI, dashboard | ✅ |
| 11 | Browser adapter: Chromium via Playwright/CDP behind the controller interface; target policy + explicit origin allowlist + per-session egress proxy | ✅ |
| 12 | Screenshot storage: optional local PNGs (off by default), bound to their capture event, retention / size / budget limits, delete; dashboard shows the images | ✅ |
| 13–15 | Dashboard replay · native messaging · Windows production hardening | ⬜ next |

**Tests:** 316 unit · 14 E2E on the mock at 127.0.0.1:4599 (incl. the full
OBSERVE → RECORD → REPLAY → ANALYZE → COMPARE → REPORT pipeline) · 15
real-browser (built extension, dashboard, browser adapter and screenshots in Chromium). Lint, typecheck (6 configs) and the verified
extension build run in CI. See [docs/10-testing.md](docs/10-testing.md).

## Quick start

Requires **Node ≥ 22** and pnpm 10 ([full guide](docs/11-installation.md)).

```bash
pnpm install
pnpm run verify                  # lint + typecheck + unit + E2E + extension build

pnpm run start:service           # local service → http://127.0.0.1:4577 (token in .lab-runtime/auth-token.txt)
pnpm run start:mock              # mock Extranet  → http://127.0.0.1:4599
pnpm run build                   # extension/dist (load unpacked, paste the token in Options) + dashboard/dist
pnpm run dashboard:url           # → http://127.0.0.1:4577/dashboard/#token=…  (forensic dashboard)

pnpm run replay:example          # replay all ten mock modules (SIMULATE mode)
pnpm run report <sessionId> --format html --out report.html   # forensic report (also JSON / CSV / print)
```

## How it fits together

```
Chrome ── MV3 extension ── bridge (loopback, token) ──► local service ──► SQLite
             records your                                   │
             own session                                    ├─► recording → workflow draft
             (redacted)                                     ├─► ReplayEngine ─(authorized?)─► BrowserController ─► mock Extranet
                                                            └─► Analyzer (JSON rules) ─► findings → exact event ids
                                                                   └─► Dashboard (/dashboard/) · Reports (JSON/CSV/HTML/print)
```

Full detail: [docs/01-architecture.md](docs/01-architecture.md) (v1.1) and
[ADR-0004](docs/adr/0004-automation-engine-and-target-hardening.md).

## Repository layout

```
shared/            contracts: event / recorder / workflow / replay schema, safety policy, redaction
extension/         MV3 recorder: service worker, content script, recorder, bridge, popup, options
windows-service/   loopback API, event bus, SQLite, watchdog; src/automation: controller, replay engine, CLI;
                   src/analysis: analyzer + JSON rule engine; src/reports: forensic reports + CLI
mock-extranet/     safe local Extranet (login, property, rooms, rates, reservations, messages, reviews, photos, reports)
dashboard/         forensic dashboard (static SPA served by the service at /dashboard/)
examples/          runnable workflow files
tests/             cross-package E2E (tests/e2e) and real-browser tests (tests/browser)
scripts/lint.mjs   architecture + safety lint
docs/              source-of-truth documentation + ADRs
```

## Documentation

| Topic | Document |
|-------|----------|
| Architecture | [01-architecture](docs/01-architecture.md) |
| Event schema (+ recorder schema) | [02-event-schema](docs/02-event-schema.md) |
| Workflow schema & detection | [03-workflow-schema](docs/03-workflow-schema.md) |
| Replay format, engine, CLI | [04-replay-format](docs/04-replay-format.md) |
| Security model | [05-security-model](docs/05-security-model.md) |
| Privacy model | [06-privacy-model](docs/06-privacy-model.md) |
| Safety modes & exclusions | [07-safety-modes](docs/07-safety-modes.md) |
| Data model (SQLite) | [08-data-model](docs/08-data-model.md) |
| Troubleshooting | [09-troubleshooting](docs/09-troubleshooting.md) |
| Testing | [10-testing](docs/10-testing.md) |
| Installation | [11-installation](docs/11-installation.md) |
| Chrome extension setup | [12-chrome-extension-setup](docs/12-chrome-extension-setup.md) |
| Windows service setup | [13-windows-service-setup](docs/13-windows-service-setup.md) |
| Workflow analysis, rules, findings | [14-analysis](docs/14-analysis.md) |
| Forensic dashboard | [15-dashboard](docs/15-dashboard.md) |
| Forensic reports | [16-reports](docs/16-reports.md) |
| Browser adapter (real-browser replay) | [17-browser-adapter](docs/17-browser-adapter.md) |
| Screenshot storage | [18-screenshot-storage](docs/18-screenshot-storage.md) |
| ADRs | [docs/adr](docs/adr/) |

## Safety modes

| Mode | Recording | Replay side effects | Allowed targets |
|------|-----------|---------------------|-----------------|
| `OBSERVE` (default) | yes | none | none |
| `SIMULATE` | yes | mock only | `mock` (loopback URL) |
| `AUTHORIZED_AUTOMATION` | yes | yes | mock **or** authorized (with authorization record, stored per run) |

## Production deployment

Current release: run the service under the watchdog, auto-started at logon on
Windows ([doc 13](docs/13-windows-service-setup.md)); load the built extension
unpacked. Planned (Phases 11–15): security hardening pass, signed extension
package, `setup.exe` that installs Node, the service (as a Windows service with
job-object supervision) and the extension helper.

## License

MIT + binding Acceptable-Use terms — see `LICENSE`.
