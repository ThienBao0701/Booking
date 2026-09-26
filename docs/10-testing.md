# 10 — Testing Strategy (Component 14)

## Suites

| Suite | Where | Command | Install needed |
|---|---|---|---|
| Unit — shared contracts, safety, redaction | `shared/test` | `pnpm run test:shared` | no |
| Unit + integration — service (auth, security, store, ingestion, watchdog, controller, replay engine, converter, routes, analyzer, rule engine, comparison, analysis API, dashboard hosting, query API, reports) | `windows-service/test` | `pnpm run test:service` | no |
| Unit + integration — mock Extranet | `mock-extranet/test` | `pnpm run test:mock` | no |
| Unit — extension (recorder, bridge, capture, config, manifest policy, environment) | `extension/test` | `pnpm run test:extension` | no |
| Unit — dashboard (formatting, routing, token handling, chart geometry) | `dashboard/test` | `pnpm run test:dashboard` | no |
| E2E — bridge, controller, replay, full pipeline on the mock at 127.0.0.1:4599 | `tests/e2e` | `pnpm run test:e2e` | no |
| Real-browser E2E — built extension and dashboard in Chromium | `tests/browser` | `pnpm run test:browser` | Chromium (skips without) |

`pnpm run test` = unit + E2E. `pnpm run verify` = lint + typecheck + test + build.

Counts at this revision: **316 unit** (62 shared · 167 service · 11 mock ·
64 extension · 12 dashboard), **14 E2E**, **15 real-browser** (2 extension ·
9 dashboard · 3 browser adapter · 1 screenshots). Earlier tests are unchanged and still pass.

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

## What the analysis suites prove (Phase 8)

- **Contracts (shared):** the language guard accepts neutral diagnostic wording
  and rejects proof / enforcement / sanction / platform-detection / causation
  claims; rule sets fail closed; findings without traceable events are invalid.
- **Rule engine:** every condition type on purpose-built sessions, including
  negative cases (window not observed → no judgement, floors, min samples,
  cohort size).
- **Analyzer:** segmentation, timing, repeated sequences, graph and
  environment against fixtures; on a mixed cohort **every** finding passes
  `validateFinding`, cites existing events, has trigger evidence equal to
  `event_ids`, ends with the platform caveat and contains no conclusive
  wording; normal sessions produce low-noise, info-only output; results are
  deterministic.
- **Comparison:** LCS, pacing vs. path differences, environment diffs, notes.
- **Service/API:** persistence is idempotent; custom rules persist, survive
  restart and fall back to defaults when invalid; a pre-Phase-8 database
  migrates additively; every finding's event ids resolve over
  `GET /v1/findings/:id`; auth/origin/validation on every analysis route;
  auto-analysis on session end is deferred and coalesced.

## What the dashboard suites prove (Phase 9)

- **Service:** the static route serves only files inside the dashboard
  directory (traversal, encoded traversal, backslashes, NUL, hidden files,
  unknown types and symlink escapes → 404), with the CSP and anti-framing
  headers; `503` when not built; the API still needs the token; exactly the
  service's own origin is accepted while other local origins (the mock's
  port, neighbouring ports) are rejected; stats, event search, runs,
  environment and session summaries return correct counts and reject bad
  parameters with `400`.
- **Dashboard units:** routes/filters round-trip; the token is taken only
  from `#token=`, validated and scrubbed; only in-app/same-origin hrefs are
  rendered; tick, arc-diagram and timeline geometry (including packing of
  overlapping findings) are deterministic.
- **Browser (Chromium):** token leaves the address bar and lands in
  `sessionStorage`; all pages render with zero console errors or failed
  requests; filters narrow results; the event drawer opens by click and by
  keyboard and lists the findings that cite the event; recorded markup
  (`<script>…`) is shown as text; a finding's evidence lists exactly its
  `event_ids`; timeline ticks/bands match stored events/findings; the workflow
  graph and session comparison are interactive.

## What the report suites prove (Phase 10)

- **Model:** all 11 sections; integrity digest detects changes; stored vs
  computed findings; every finding's event ids (and evidence ids) are in the
  timeline and link back; truncation never drops a cited event; baseline
  selection (explicit / previous / most recent / none); every generated text
  passes the non-conclusive language guard.
- **Renderings:** HTML sections in order, an anchor for every cited event and
  a link from every finding to each of its event ids, no `<script>`/`<img>`
  from recorded data (hostile selectors and messages are escaped), CSP meta
  pinning the stylesheet hash, print rules; CSV quoting, BOM, one evidence row
  per item, and the formula-injection guard (including operator-authored rule
  titles).
- **API / CLI:** content types, CSP / frame headers, download names, digest
  header, 400/404 paths, auth and origin rules; the CLI writes from the
  database file and fails clearly on bad input.
- **E2E pipeline:** OBSERVE → RECORD (extension recorder + bridge, two
  sessions) → REPLAY (example workflow on the mock, run persisted) → ANALYZE
  (API; every finding resolves to stored events) → COMPARE → REPORT (JSON and
  HTML links to exact event ids).
- **Browser:** the Reports page downloads byte-exact JSON / CSV / print HTML
  and previews a styled, script-free HTML report.

## What the browser-adapter suites prove (Phase 11)

See [17-browser-adapter](17-browser-adapter.md#tests): authorization and the
explicit allowlist gate every browser launch; nothing reaches a
non-allowlisted origin in a real Chromium (images, fetches, links, direct
navigation, redirect hops); the example workflow replays on the real mock UI.

## What the screenshot suites prove (Phase 12)

Storage is off by default and nothing is written while off; settings fail
closed; images bind only to their own recorded `SCREENSHOT` event (session,
byte size, uploader hash = bytes); PNG/size/budget limits; shared files are
released only when unreferenced; retention and orphan collection; replay
screenshots via the engine hook (a failing sink never fails the step); the
API's auth/origin/headers; the dashboard CSP allows `blob:` for images only;
in Chromium the Screenshots page shows the real image and deletes it.

## What the dashboard-replay suites prove (Phase 13)

See [19-dashboard-replay](19-dashboard-replay.md#tests): planning never touches
the target; start needs the single-use token and the acknowledgement; the
service mode caps runs (an `OBSERVE` service never executes); one active run;
parameter values never reach logs or stored runs; the example completes on the
real mock through the API and through the page in Chromium.

## What the native-messaging suites prove (Phase 14)

See [20-native-messaging](20-native-messaging.md#tests): the protocol is
validated fail-closed in both directions; only allowed extensions and only the
bridge's routes and headers get through; the service still authenticates and
origin-checks every relayed call; timeouts, size limits and host crashes are
handled; install / upgrade / uninstall leave nothing behind; a real Chromium
delivers a recorded session through the installed host and falls back to HTTP
after uninstall.

## What the deployment suites prove (Phase 15)

See [21-windows-deployment](21-windows-deployment.md#tests): the task
definition runs the supervisor at logon without elevation and restarts it;
install / upgrade / rollback / uninstall keep data and configuration and leave
nothing behind; the supervisor restarts crashed and hung services, never
leaves an orphan, handles a taken port and bad configuration; a corrupted
config never widens anything; logs rotate within limits; after a simulated
reboot the extension reconnects and delivers what it queued. Task Scheduler
itself is simulated (Linux CI).

## What the diagnostics suites prove

`windows-service/test/diagnostics.test.ts` and
`tests/browser/diagnostics.browser.test.ts`: every analysis run records its
rule version and time; findings become stale when the rules change, when
events arrive later or when no record exists, and a stale-only re-run brings
exactly those sessions back to current; the finding drill-down carries the
provenance; comparison exports have the right headers, a BOM and guarded
formula cells; in Chromium the stale banner, re-analysis, evidence → timeline
link and the CSV download all work.

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
