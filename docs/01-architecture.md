# 01 — Architecture

Status: **v1.0 (foundational)** · Scope: local, single-operator diagnostics lab.

This document is the source of truth for structure and boundaries. Any change
to the boundaries below must be proposed as an ADR (see `docs/adr/`) before
implementation.

## 1. Purpose

A **local** platform to:

- observe a browser workflow (your own, authenticated sessions),
- record an event timeline,
- reproduce workflows against a **mock** or explicitly authorized environment,
- analyze request / navigation / state changes,
- compare multiple runs,
- produce forensic / QA reports.

The loop is: **OBSERVE → REPRODUCE → ANALYZE → DEBUG → IMPROVE**.

It exists so an operator can debug complex Extranet-style workflows in a lab
instead of experimenting on a live production account.

## 2. Component map

```
Chrome/Chromium/Edge
      │  (user drives their own authenticated session)
      ▼
MV3 Extension  ──────────────┐  record (redacted) events, screenshots-on-action
      │                      │
      │  Native Messaging /  │
      │  localhost bridge    │  (token handshake, offline buffer)
      ▼                      │
Local Background Service ◄────┘
      │   localhost-only API (auth token, origin check, rate limit)
      ├── Structured JSON Event Bus
      ├── SQLite (WAL)  + rolling logs + health + watchdog
      ▼
Automation Engine (BrowserController abstraction)
      │
      ├── Workflow Recorder ──► Workflow store (JSON)
      ├── Replay Engine ───────► target guard (mock / authorized only)
      ▼
Risk & Workflow Analyzer  (rule engine → non-conclusive findings)
      ▼
Web Dashboard  +  Report generator (JSON/CSV/HTML/PDF)
```

## 3. Modules and ownership boundaries

| Package            | Owns                                                        | May import        |
|--------------------|------------------------------------------------------------|-------------------|
| `shared`           | Contracts: event/workflow/replay schemas, **safety policy**, redaction, ids/time | (nothing internal) |
| `extension`        | MV3 capture, redaction-at-source, bridge client            | `shared`          |
| `windows-service`  | localhost API, event bus, SQLite, logs, watchdog, controller host | `shared`   |
| `mock-extranet`    | Safe automation target that emits production-shaped events  | `shared`          |
| `dashboard`        | Read/visualize; trigger authorized replays                  | `shared`          |

**Import rule (enforced by review + lint boundaries):** everything depends on
`shared`; `shared` depends on nothing internal; no sibling package imports
another sibling directly (they communicate over the service API / bus).

`shared` is the single place where the *event schema*, *workflow schema*,
*replay format*, *safety policy*, and *redaction rules* are defined, so all
components agree on contracts and no component can weaken safety locally.

## 4. Cross-cutting invariants

1. **Local-only.** All service endpoints bind to `127.0.0.1`. No component
   opens an inbound port on a non-loopback interface.
2. **Least privilege.** The extension requests the minimum permissions and
   never `<all_urls>` by default (see `docs/05-security-model.md`).
3. **Redaction at source.** Secrets/credentials/PII are dropped in the content
   script *before* an event leaves the page. The service treats inbound data as
   already-redacted but re-applies redaction defensively.
4. **Safety policy is code.** The OBSERVE / SIMULATE / AUTHORIZED_AUTOMATION
   modes and the forbidden-capability denylist live in `shared/src/safety` and
   are unit-tested. There is no runtime toggle that can enable a forbidden
   capability.
5. **Replay target guard.** The replay engine refuses any target that is not
   the mock environment or an operator-declared authorized target.
6. **Determinism & traceability.** Every event, workflow step, and replay run
   carries stable ids and timestamps so runs are reproducible and comparable.

## 5. Determinism / reproducibility

- IDs are generated centrally (`shared/src/ids.ts`) and are the only source of
  identifiers, so a captured session and its replay share a comparable key space.
- Timestamps are recorded as epoch-millis plus a monotonic sequence per session
  to preserve ordering even when wall-clock resolution collides.
- Replay is *checkpointed*; a run can be paused, resumed, retried, rolled back
  to a checkpoint, or executed as `dry-run` / `mock` with no side effects.

## 6. What is intentionally NOT here

No anti-detection, stealth evasion, fingerprint spoofing, IP rotation, CAPTCHA
bypass, bot-detection bypass, or synthetic "human-like" behavior generation.
These are excluded by design and enforced by `shared/src/safety`. See
`docs/07-safety-modes.md` and `docs/adr/0002-safety-scope-and-exclusions.md`.
