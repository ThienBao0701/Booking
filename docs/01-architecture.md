# 01 — Architecture

Status: **v1.1** (Phases 0–8 implemented) · Scope: local, single-operator diagnostics lab.

This document is the source of truth for structure and boundaries. Any change
to the boundaries below must be proposed as an ADR (see `docs/adr/`) before
implementation. v1.1 changes are recorded in
[ADR-0004](adr/0004-automation-engine-and-target-hardening.md); the analyzer
(within the existing boundaries) in
[ADR-0005](adr/0005-analyzer-rule-engine-and-findings.md).

## 1. Purpose

A **local** platform to:

- observe a browser workflow (your own, authenticated sessions),
- record an event timeline,
- reproduce workflows against a **mock** or explicitly authorized environment,
- analyze request / navigation / state changes,
- compare multiple runs,
- produce forensic / QA reports.

The loop is: **OBSERVE → RECORD → REPRODUCE → ANALYZE → DEBUG → IMPROVE**.

It exists so an operator can debug complex Extranet-style workflows in a lab
instead of experimenting on a live production account.

## 2. Component map

```
Chrome / Chromium / Edge  (the operator drives their own session)
   │
   ▼
MV3 Extension (extension/)                                   [Phases 1, 2]
   content script ── structure-only captures, redacted at source
   service worker ── recorder: redact → workflow detect → dedup → seq
                     → IndexedDB queue → debounced/batched flush → retry
   │
   │  Bridge (extension/src/bridge)                           [Phase 4]
   │  loopback HTTP + bearer token + handshake + timeout + reconnect
   │  (a Native Messaging transport can implement the same Transport type)
   ▼
Local Background Service (windows-service/)                   [Phase 3]
   loopback-only API: auth, Host/Origin validation, rate limit, size limits
   JSON event bus · SQLite (WAL) · rolling logs · health · watchdog
   idempotent ingestion (retries never duplicate)
   │
   ├─ Automation engine (windows-service/src/automation)      [Phases 6, 7]
   │    recording → workflow draft (convert.ts)
   │    ReplayEngine ── authorization BEFORE execution ──► BrowserController
   │                                                          │
   │                          MockExtranetController ◄────────┘ (one origin, loopback only)
   │                                   │
   ▼                                   ▼
Analyzer · Dashboard · Reports   Mock Extranet (mock-extranet/)   [Phase 5]
   [8: windows-service/src/analysis, 9–10 planned]
                                  safe target; emits workflow events
```

### Record path (OBSERVE → RECORD)

1. The content script (only on recordable origins, only while a session is
   active) captures clicks, field changes (no values), submits, debounced DOM
   summaries and SPA view changes.
2. The service worker re-scopes each capture by the browser's sender URL,
   builds a standardized `RecordedEvent`, detects the workflow, deduplicates,
   assigns a gap-free `seq`, and persists to IndexedDB.
3. The recorder flushes batches through the bridge; the service validates,
   re-redacts, stores in one SQLite transaction and publishes to the bus.

### Replay path (REPRODUCE)

1. `GET /v1/sessions/:id/workflow` turns a recording into a draft
   `WorkflowFile` (documented rules; values become `{{params}}`).
2. `ReplayEngine` validates, applies the mock-only rule and the shared policy
   target guard, and **only then** launches a `BrowserController`.
3. Steps run with timeouts, retries, checkpoints; run records are persisted.

### Analyze path (ANALYZE → COMPARE) — Phase 8

1. On `session.end` (or `POST /v1/analysis/run`) the analyzer
   (`windows-service/src/analysis`) segments the stored events into workflows,
   computes timing, repeated sequences and the workflow graph, and evaluates
   the JSON rule set against the session and its cohort.
2. Each rule match becomes a validated, non-conclusive finding that cites the
   exact triggering event ids; findings are persisted in `findings`.
3. Comparison and graphs are computed on demand. Details:
   [14-analysis](14-analysis.md), [ADR-0005](adr/0005-analyzer-rule-engine-and-findings.md).

## 3. Modules and ownership boundaries

| Package            | Owns                                                        | May import        |
|--------------------|------------------------------------------------------------|-------------------|
| `shared`           | Contracts: event/recorder/workflow/replay/analysis schemas, **safety policy**, redaction, finding language guard, ids/time | (nothing internal) |
| `extension`        | MV3 capture, redaction-at-source, recorder, bridge client  | `shared`          |
| `windows-service`  | localhost API, event bus, SQLite, logs, watchdog, automation engine (controller host), analyzer + rule engine | `shared` |
| `mock-extranet`    | Safe automation target that emits production-shaped events  | `shared`          |
| `dashboard`        | Read/visualize; trigger authorized replays (planned)        | `shared`          |

**Import rule (enforced by `scripts/lint.mjs` in CI):** everything depends on
`shared`, only through each package's `src/shared.ts`; `shared` depends on
nothing internal and no `node:` builtins; extension code imports no `node:`
builtins; no sibling package imports another (they communicate over the
service API). Test harnesses (`*/test`, `tests/`) may compose packages.

`shared` is the single place where the *event schema*, *recorder schema*,
*workflow schema*, *replay format*, *safety policy*, and *redaction rules* are
defined, so all components agree on contracts and no component can weaken
safety locally.

## 4. Cross-cutting invariants

1. **Local-only.** All service endpoints bind to `127.0.0.1`. No component
   opens an inbound port on a non-loopback interface. The extension's bridge
   refuses a non-loopback service URL and never follows redirects.
2. **Least privilege.** The extension requests `storage`, `alarms`,
   `scripting`, `activeTab` and loopback hosts only; other origins are granted
   per exact origin at runtime; never `<all_urls>`. Enforced by a manifest
   policy used by unit tests, the build and the lint.
3. **Redaction at source.** Secrets/credentials/PII are dropped in the content
   script *before* an event leaves the page; field values are never read. The
   recorder, the wire conversion and the service each redact again.
4. **Safety policy is code.** The OBSERVE / SIMULATE / AUTHORIZED_AUTOMATION
   modes and the forbidden-capability denylist live in `shared/src/safety` and
   are unit-tested. There is no runtime toggle that can enable a forbidden
   capability; the lint rejects evasion APIs in source.
5. **Replay target guard.** Replay runs only against the mock or an
   operator-declared authorized target with an authorization record. A `mock`
   target must be a **loopback URL** (ADR-0004). Authorization is decided
   before any controller call; a controller is bound to one origin.
6. **Determinism & traceability.** Every event, workflow step, and replay run
   carries stable ids and timestamps; a run records its `sourceSessionId`.
7. **Idempotent delivery.** Session registration and event ingestion are
   idempotent, so every bridge failure can be retried without duplicates.

## 5. Determinism / reproducibility

- IDs are generated centrally (`shared/src/ids.ts`) and are the only source of
  identifiers, so a captured session and its replay share a comparable key space.
- Timestamps are recorded as epoch-millis plus a monotonic, gap-free sequence
  per session (resumed with a safety gap after a service-worker restart).
- Replay is *checkpointed*; a run can be paused, resumed, stepped, retried,
  stopped, rolled back to a checkpoint, or dry-run with no side effects.
  Rollback restores the controller's **page model and position** — it never
  undoes target-side effects (which is why replays target the mock).

## 6. What is intentionally NOT here

No anti-detection, stealth evasion, fingerprint spoofing, IP rotation, CAPTCHA
bypass, bot-detection bypass, or synthetic "human-like" behavior generation.
Controllers act as ordinary, identifiable clients. These exclusions are
enforced by `shared/src/safety`, the manifest policy and the lint. See
`docs/07-safety-modes.md` and `docs/adr/0002-safety-scope-and-exclusions.md`.
