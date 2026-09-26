# ADR-0008 — Dashboard-initiated replays: dry-run plan, single-use confirmation, service-mode ceiling

- Status: Accepted
- Date: 2026-09-26
- Amends: ADR-0006 decision 7 ("triggering replays from the dashboard stays
  planned"). Module boundaries unchanged: the dashboard still talks only to
  `/v1`; the service owns execution through the existing `ReplayEngine` and
  controllers.

## Context

Phase 13 lets the operator start and control replays from the dashboard. Until
now replays ran only from the CLI, where the operator types the command. A web
page that can trigger execution adds two risks: a run started without the
operator having seen what it does, and a run above the safety level the
service was started with.

## Decisions

1. **Plan, then start.** `POST /v1/replay/prepare` validates, authorizes (shared
   policy; the browser allowlist for the real-browser controller) and returns a
   dry-run plan: target, authorization, workflow, step count, steps, risk
   notice and blockers. Nothing touches the target.
2. **Explicit operator action.** `start` requires the plan's single-use
   confirmation token (random, 10-minute expiry, constant-time comparison) and
   `acknowledge: true`. The UI enables Start only after the operator ticks the
   acknowledgement next to the review. Plans with blockers get no token.
3. **Service mode is the ceiling.** A dashboard run's mode may not exceed
   `LAB_SAFETY_MODE`; an `OBSERVE` service can plan but never execute. The check
   runs at plan time (blocker) and again at start.
4. **One active run**, held in memory by a `ReplayManager` in the service.
   Parameter values are never persisted or logged; logs are redacted.
5. **Library.** Workflows come from the bundled examples, an operator directory
   (`LAB_WORKFLOWS_DIR`), or a recording converted to a mock-only draft
   (loopback base URL).

## Consequences

- Execution always follows a visible plan and a deliberate action; the token
  binds the action to exactly the plan that was shown.
- No new capability: the engine, the policy, the controllers and the browser
  egress enforcement are reused unchanged.
- The token is a same-origin, bearer-authenticated value held in page memory;
  CSRF remains impossible by construction (no cookies, ADR-0006).
