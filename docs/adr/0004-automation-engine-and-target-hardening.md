# ADR-0004 — Automation engine placement, target hardening, idempotent delivery

- Status: Accepted
- Date: 2026-09-26
- Amends: docs/01-architecture.md (v1.0 → v1.1). Does not change module
  boundaries.

## Context

Phases 1, 2, 4, 6 and 7 added the extension recorder, the bridge, the
BrowserController abstraction and the replay engine. Implementing them
surfaced three defects in completed code and one placement question.

## Decisions

1. **Placement.** The automation engine (BrowserController interface,
   MockExtranetController, ReplayEngine, recording→workflow conversion, CLI)
   lives in `windows-service/src/automation/`, matching the v1.0 map ("service
   = controller host"). The controller models the mock's UI through an explicit
   page map instead of importing `mock-extranet` (boundary rule); a contract
   E2E test checks the page map against the HTML the mock serves.

2. **A "mock" target must be local.** `evaluateReplay` accepted
   `target.kind: "mock"` with any URL, so a real system labelled "mock" could be
   replayed in SIMULATE mode without an authorization record. The policy now
   requires loopback URLs for mock targets (`MOCK_TARGET_NOT_LOCAL`); userinfo
   URLs are rejected outright. Defense in depth: MockExtranetController refuses
   non-loopback base URLs and blocks navigation to any other origin.

3. **Idempotent delivery.** Re-registering a session and re-sending a delivered
   batch both returned 500 (primary-key conflicts), which made bridge retries
   poison the queue; an event for an unknown session failed its whole batch.
   Ingestion is now idempotent (`INSERT OR IGNORE`, "duplicates" reported), one
   SQLite transaction per batch, and unknown sessions are reported per event as
   `UNKNOWN_SESSION` so the bridge re-registers and resends.

4. **Recorder schema.** The standardized recorder fields (`event_id,
   session_id, seq, timestamp, tab_id, page, workflow, action, target,
   metadata`) are a view (`RecordedEvent`) with lossless converters to the
   unchanged `LabEvent` wire contract; conversion always redacts.

5. **Rollback semantics.** Rollback restores the controller page model and run
   position only. Target-side effects are not undone; replays therefore target
   the mock unless an operator explicitly authorizes another system.

## Consequences

- Retries anywhere in the delivery path are safe; no data loss on offline,
  restarts or database resets (covered by E2E tests).
- A mislabelled target can no longer bypass the authorization requirement.
- Adding a browser-backed controller (CDP / Playwright) requires no engine
  change: implement `BrowserController`.
