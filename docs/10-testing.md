# 10 — Testing Strategy (Component 14)

## Suites

| Suite | Where | Command | Install needed |
|---|---|---|---|
| Unit — shared contracts, safety, redaction | `shared/test` | `pnpm run test:shared` | no |
| Unit + integration — service (auth, security, store, ingestion, watchdog, controller, replay engine, converter, routes) | `windows-service/test` | `pnpm run test:service` | no |
| Unit + integration — mock Extranet | `mock-extranet/test` | `pnpm run test:mock` | no |
| Unit — extension (recorder, bridge, capture, config, manifest policy) | `extension/test` | `pnpm run test:extension` | no |
| E2E — bridge, controller, replay on the mock at 127.0.0.1:4599 | `tests/e2e` | `pnpm run test:e2e` | no |
| Real-browser E2E — built extension in Chromium | `tests/browser` | `pnpm run test:browser` | Chromium (skips without) |

`pnpm run test` = unit + E2E. `pnpm run verify` = lint + typecheck + test + build.

Counts at this revision: **201 unit** (54 shared · 77 service · 11 mock ·
59 extension), **13 E2E**, **2 real-browser**. The original 75 tests are
unchanged and still pass.

## What the E2E suites prove

- **Bridge (4):** recorder → bridge (real `fetch`) → real service: ordered,
  labelled, redacted at rest; service restart while offline → no loss, no
  duplicates; database reset → re-registration; wrong token → paused without loss.
- **Controller (4):** page-map **contract** against the mock's served HTML;
  all ten modules driven end-to-end (mock emits LOGIN → … → REPORTING); real
  server validation surfaces; controller cannot target non-local systems.
- **Replay (5):** example workflow on the mock (persisted, params never stored);
  dry-run and denials with **zero** mock side effects; step/checkpoint/rollback;
  CLI as a child process; **OBSERVE → RECORD → REPRODUCE** (extension capture
  rules on the real mock HTML → recorder → bridge → service → draft → replay).
- **Browser (2):** the built extension in Chromium records real clicks/typing;
  no typed value or secret reaches the service; REC badge; session ends; the
  recording replays; a tampered off-box service URL is refused.

## The mock at 127.0.0.1:4599

E2E tests target `MOCK_EXTRANET_URL` (default `http://127.0.0.1:4599`, must be
loopback). A mock already running there is **reused and left running**; if none
is running the harness starts one in-process and stops it afterwards. Tests
scope assertions to their own actor/entities, so a shared mock is fine. Run E2E
with `--test-concurrency=1` (the scripts do).

## Principles

- Safety, privacy and authorization are the highest-priority test targets; a
  regression that weakens them fails CI (policy tests, manifest policy, lint
  rules proven against planted violations, zero-side-effect denial tests).
- Deterministic: fake timers/ids for the recorder and bridge; scriptable fake
  controller for the engine; real components end-to-end.
- Every root-cause fix ships with a regression test.

## CI (`.github/workflows/ci.yml`)

1. **core** (zero install): lint → unit (all packages) → E2E.
2. **build** (locked install): typecheck → build extension (+ artifact
   verification) → service/mock boot smoke test → upload `extension/dist`.
3. **browser**: install Chromium → real-browser E2E.
