# 19 — Dashboard Replay (Phase 13)

The dashboard's **Replay** page (`#/replay`) plans a workflow as a dry run,
shows what it would do, and executes it only after an explicit operator
action. Decision record: [ADR-0008](adr/0008-dashboard-initiated-replays.md).
The engine, controllers and policy are unchanged
([04-replay-format](04-replay-format.md), [07-safety-modes](07-safety-modes.md),
[17-browser-adapter](17-browser-adapter.md)).

## Flow

1. **Plan (dry run).** Choose a workflow, a safety mode and a controller, then
   press *Plan (dry run)*. Sources:
   - bundled examples (`examples/workflows`, read-only);
   - the operator library: `*.json` in `LAB_WORKFLOWS_DIR` (default
     `<LAB_DATA_DIR>/workflows`); `<name>.params.json` next to a workflow is
     offered as *Load example parameters*;
   - a recorded session, converted to a draft that targets the local mock only
     (loopback `baseUrl`, same converter as `GET /v1/sessions/:id/workflow`).

   The plan validates the workflow, evaluates the shared policy and — for the
   real-browser controller — the explicit origin allowlist. Nothing reaches the
   target while planning.

2. **Review before start.** The page shows:

   | Field | Content |
   |---|---|
   | Target | kind and base URL |
   | Authorization | policy decision (code + reason); the authorization record for `authorized` targets; the browser allowlist decision and origins |
   | Workflow | name, version, source |
   | Step count | number of steps, plus the step table (action, target, timeout, retries, checkpoint, parameters) |
   | Mode | requested mode and the service's mode (the ceiling) |
   | Risk notice | what the run changes, that rollback does not undo target changes, the browser confinement, parameter handling |
   | Blockers | why the plan cannot start (mode ceiling, authorization, allowlist, missing parameters) |

3. **Explicit operator action.** *Start replay* stays disabled until the
   operator ticks the acknowledgement. The service independently requires the
   plan's **single-use confirmation token** (returned only by the plan request,
   kept in page memory, expires after 10 minutes) and `acknowledge: true`.
   A plan with blockers gets no token.

4. **Live control.** `#/replay/<runId>` shows progress (a `<progress>` bar,
   done / total, cursor), the step table, the redacted log (polled every
   second, incremental) and the result, with the engine's controls:

   | Control | Allowed when |
   |---|---|
   | Pause | running (takes effect after the current step) |
   | Resume, Step | paused |
   | Retry step | failed (the run waits on the failed step) |
   | Checkpoint (optional label) | paused or failed |
   | Roll back (to a checkpoint) | paused or failed, with a checkpoint |
   | Stop | any unfinished state (asks for confirmation) |

   Finished runs are also persisted and appear on the **Runs** page.

## Rules the service enforces

- **Mode ceiling.** The service's `LAB_SAFETY_MODE` caps dashboard runs
  (`OBSERVE` < `SIMULATE` < `AUTHORIZED_AUTOMATION`). In `OBSERVE` the page can
  plan but never execute; `SIMULATE` allows the local mock; authorized targets
  need `AUTHORIZED_AUTOMATION` on the service *and* in the plan.
- **Confirmation.** Start requires the token (compared in constant time),
  within 10 minutes, exactly once, plus `acknowledge: true`.
- **One run at a time.** A second start is refused (`409 another_run_active`)
  while a run is running or paused.
- **Mock controller runs are mock-only** (the engine's `mockOnly` option).
- **Parameters** are validated (≤ 100 keys, names `[\w.-]{1,64}`, string values
  ≤ 2000 chars), used in memory for the run only, and never persisted or logged.
- **Logs** are redacted and capped (1000 entries per run).
- Finished runs are released after an hour; unstarted plans after their
  expiry plus an hour; a failed run left alone is stopped after an hour so no
  browser stays open. Service shutdown stops every run.

## API

All routes use the standard `/v1` pipeline (loopback host, origin check, bearer
token, rate limit, body size limit).

| Method | Path | Result |
|---|---|---|
| GET | `/v1/replay/workflows` | `{ workflows: ReplayLibraryEntry[], serviceMode }` |
| GET | `/v1/replay/workflows/:id` | `{ workflow, exampleParams }` |
| POST | `/v1/replay/prepare` | `201 { plan: ReplayPlanView, confirmToken \| null, expiresAt }` — body: `workflowId` \| `sessionId` (+ loopback `baseUrl`) \| `workflow`, `mode`, `controller` (`mock` \| `browser`), `allowOrigins`, `resourceOrigins`, `params` |
| GET | `/v1/replay/runs` | runs held by this service process |
| GET | `/v1/replay/runs/:id?since=<seq>` | `ReplayRunStatus` with log entries after `seq` |
| POST | `/v1/replay/runs/:id/start` | `{ confirmToken, acknowledge: true }` |
| POST | `/v1/replay/runs/:id/{pause,resume,stop,step,retry,checkpoint,rollback}` | `ReplayRunStatus` (`checkpoint`: `{ label? }`, `rollback`: `{ checkpointId? }`) |
| DELETE | `/v1/replay/runs/:id` | discard an unstarted plan |

Errors: `400 acknowledgement_required`, `403 invalid_confirmation`,
`410 confirmation_expired`, `403 mode_ceiling`, `409 another_run_active`,
`409 already_started`, `409 invalid_state`, `409 rollback_failed`,
`404 run_not_found`, `400 invalid_workflow` (with the validation errors),
`429 too_many_runs`. Contracts: `shared/src/api/types.ts`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LAB_SAFETY_MODE` | `OBSERVE` | ceiling for dashboard runs |
| `LAB_WORKFLOWS_DIR` | `<LAB_DATA_DIR>/workflows` | operator workflow library |
| `LAB_BROWSER_EXECUTABLE` | Playwright's Chromium | browser for the real-browser controller |

## Tests

- `windows-service/test/replay-manager.test.ts` — plan contents and blockers,
  authorized plans, every start rule (acknowledgement, token, expiry, single
  use, mode ceiling, one active run), controls and state guards, failure /
  retry / stop / discard, no parameter values in logs, HTTP validation, auth
  and origin checks, OBSERVE ceiling over HTTP.
- `tests/e2e/dashboard-replay.e2e.test.ts` — the bundled example via the API
  on the real mock: planning has no side effects, start rules, incremental
  logs, completed run persisted, the mock saw every module; an `OBSERVE`
  service cannot execute.
- `tests/browser/replay.browser.test.ts` — the page in Chromium: blockers
  disable the acknowledgement, the review shows target / authorization /
  workflow / step count / risk notice, Start is disabled until acknowledged,
  the run completes with live progress and logs, no CSP or script errors.
