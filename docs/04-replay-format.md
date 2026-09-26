# 04 — Replay Format & Engine

Canonical definitions: `shared/src/replay/types.ts` (+ `validate.ts`) for the
format; `windows-service/src/automation/engine.ts` for execution.

> **Authorization boundary.** Replay may only run against the bundled
> `mock-extranet` (a `mock` target, which must be a **loopback** URL) or a
> target the operator has explicitly declared authorized (`target.kind:
> "authorized"` with an `authorization` record, in `AUTHORIZED_AUTOMATION`
> mode). Authorization is decided **before any controller call**: a denied run
> never launches the controller. See `docs/07-safety-modes.md` and ADR-0004.

## Workflow file

```jsonc
{
  "workflow": "reservation-test",
  "version": 1,
  "target": {
    "kind": "mock",                       // "mock" (loopback only) | "authorized"
    "baseUrl": "http://127.0.0.1:4599"
    // when kind === "authorized", an `authorization` block is REQUIRED:
    // "authorization": { "owner": "me", "system": "staging-extranet",
    //                    "grantedBy": "self", "note": "own staging tenant",
    //                    "acknowledgedAt": 1750000000000 }
  },
  "defaults": { "timeoutMs": 10000, "retries": 1 },
  "steps": [
    { "id": "s1", "action": "navigate", "target": "/" },
    { "id": "s2", "action": "type", "target": "#login-username", "value": "{{username}}" },
    { "id": "s3", "action": "click", "target": "#login-submit", "checkpoint": true },
    { "id": "s4", "action": "waitFor", "target": "#actor[data-actor]:not([data-actor=\"\"])" }
  ]
}
```

A complete, runnable example covering all ten mock modules:
`examples/workflows/mock-full-flow.json` (+ `.params.json`).

Validation: structural (`validateWorkflowFile`: ids unique, known actions,
target shape) plus semantic (engine): `navigate/click/type/select/waitFor/assert`
need a `target`; `type/select` need a `value`; `timeoutMs` > 0; `retries` 0..10.

### Values, parameters and references

`value` fields are for **test data only**. The recorder never captures values,
so replays supply data explicitly:

| Form | Meaning |
|---|---|
| literal (`"150"`) | used as-is |
| `{{name}}` | replaced from run parameters (`--param name=value` / `params`). Missing → the run fails **before launch**. Parameter values are **never written** to run records. |
| `$last` (in `select`) | the id of the entity of the select's kind most recently created in this run |
| `$last.<kind>` | explicit kind: `property`, `room`, `reservation`, `rate`, `message`, `review`, `photo` |

## Step actions

`navigate` · `reload` · `back` · `forward` · `click` · `type` · `select`
· `waitFor` · `captureState` · `captureScreenshot` · `assert` (= element visible).

These map 1:1 onto the `BrowserController` interface
(`windows-service/src/automation/controller.ts`): `launch, openTab, closeTab,
navigate, reload, back, forward, click, type, select, waitFor, captureState,
captureScreenshot, getCurrentUrl, getPageMetadata, snapshot?, restore?, close`.
Failures are `ControllerError`s with a stable `code` and a `retryable` flag.

### Mock Extranet controller semantics

`MockExtranetController` drives the mock's page model over HTTP with browser
semantics: only the active view's elements are visible; a reload resets unsaved
inputs; `back`/`forward` walk tab history; `<select>` values must be existing
options; a server rejection fails the step with the server's message;
navigation outside the bound origin is blocked; it refuses non-loopback targets.
Screenshots are reported unsupported (the step is `skipped`, not failed).

Selector dialects understood: `#id`, `[data-action=…]`, `button[data-view=…]`
(navigation), `.view.active[data-view=…]` (active view), `button[data-cancel]`
(first row, CSS semantics) / `button[data-cancel="$last"]`, and the conditions
`#actor[data-actor]:not([data-actor=""])` (logged in) and
`#report-out[data-report="1"]` (report generated).

## Execution controls (Component 5)

| Control      | Engine API | Meaning |
|--------------|------------|---------|
| start        | `start()` | Authorize → launch → run until completed / paused / stopped / failed. |
| pause        | `pause()` | Graceful: halt before the next step. |
| resume       | `resume()` | Continue a paused or rolled-back run. |
| stop         | `stop()` | Abort the in-flight action immediately; remaining steps `skipped`; run `stopped`; controller closed. |
| step         | `step()` | Execute exactly one step, then pause. |
| retry        | `retry()` | Re-run the failed step (after fixing the cause), then continue. Per-step automatic retries come from `retries`. |
| timeout      | `timeoutMs` | Per-step deadline enforced by abort signal + race. |
| checkpoint   | `checkpoint: true` / `checkpoint(label)` | Snapshot of the controller's page model + run position. A `start` checkpoint is taken after launch. |
| rollback     | `rollback(id?)` | Return to the latest (or named) checkpoint; later checkpoints are discarded; the run becomes `rolledBack` (paused). **Target-side effects are not undone.** |
| dry-run      | `dryRun()` | Validate, authorize, resolve timeouts/retries, list required and missing params. **No controller call.** |
| mock mode    | `mockOnly: true` / `--mock-only` | Refuse any target that is not `kind: "mock"`. |

Automatic retries apply only to transient failures (element not yet visible,
timeouts, 5xx/429). Deterministic failures are not retried: 4xx business
rejections (avoids duplicate side effects), blocked navigation, wrong element
kind, unresolved `$last`, missing parameters.

## Run record

```jsonc
{
  "runId": "run_01M3…",
  "workflow": "mock-full-flow",
  "mode": "SIMULATE",
  "startedAt": 1790400813248,
  "endedAt": 1790400814001,
  "status": "completed",   // pending|running|paused|completed|failed|rolledBack|stopped
  "steps": [
    { "id": "open", "status": "ok", "startedAt": 1790400813250, "endedAt": 1790400813262, "attempts": 1 }
  ],
  "checkpoints": ["start", "logged-in", "create-property", "create-reservation"],
  "sourceSessionId": "session_01M3…",  // set when replaying a recording
  "target": { "kind": "mock", "baseUrl": "http://127.0.0.1:4599" }
  // for kind "authorized", target.authorization (owner, system, grantedBy,
  // note, acknowledgedAt) is stored with the run: who authorized what
}
```

Step status: `pending | ok | failed | skipped`. Runs are persisted after every
change (`Store.saveRun`) and readable at `GET /v1/runs/:id`. Run records are the
unit the analyzer diffs when comparing runs (Phase 8).

## Recording → workflow

`GET /v1/sessions/:id/workflow?name=…&baseUrl=…` (or `recordingToWorkflow()`)
turns a recording into a draft with explicit rules:

| Recorded | Draft step |
|---|---|
| typed field (`filled: true`) | `type <selector> "{{<field-id>}}"` |
| sensitive field | `type <selector> "{{secret_<field-id>}}"` — supply at replay; never stored |
| `<select>` change | `select <selector> "$last"` |
| click | `click <selector>`; `button[data-cancel]` → `button[data-cancel="$last.reservation"]` |
| view change after a click | `waitFor .view.active[data-view="…"]` |
| checkbox / radio | `click` |
| left recordable scope, implicit submit | listed in `notes`, not reproduced |

Drafts always target the local mock (`baseUrl` must be loopback). Retargeting
to an authorized system is a deliberate operator edit. Review drafts before
running: a recording can contain interactions with elements the target does
not have — the controller fails such steps faithfully.

## CLI

```bash
pnpm run replay <workflow.json> [--mode SIMULATE] [--dry-run] [--mock-only] \
  [--param name=value ...] [--params-file f.json] [--db .lab-runtime/lab.sqlite] [--json]
pnpm run replay:example        # the full-flow example against the mock
```

Exit codes: `0` completed (or dry run that would execute), `1` failed,
`2` denied / invalid / would not execute.
