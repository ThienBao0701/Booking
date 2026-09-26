# 04 — Replay Format

Canonical definition: `shared/src/replay/types.ts` (+ `validate.ts`).

> **Authorization boundary.** Replay may only run against the bundled
> `mock-extranet` or a target the operator has explicitly declared authorized
> (`target.kind: "authorized"` with an `authorization` record). Any other
> target is rejected before the first step executes. See
> `docs/07-safety-modes.md`.

## Workflow file

```jsonc
{
  "workflow": "reservation-test",
  "version": 1,
  "target": {
    "kind": "mock",                       // "mock" | "authorized"
    "baseUrl": "http://127.0.0.1:4599"
    // when kind === "authorized", an `authorization` block is REQUIRED:
    // "authorization": { "owner": "me", "system": "staging-extranet",
    //                    "grantedBy": "self", "note": "own staging tenant",
    //                    "acknowledgedAt": 1750000000000 }
  },
  "defaults": { "timeoutMs": 10000, "retries": 1 },
  "steps": [
    { "id": "s1", "action": "navigate", "target": "/login" },
    { "id": "s2", "action": "type", "target": "#user", "value": "TEST_VALUE" },
    { "id": "s3", "action": "click", "target": "#submit", "checkpoint": true },
    { "id": "s4", "action": "waitFor", "target": "[data-view=property]" }
  ]
}
```

`value` fields are for **test data only**. The recorder never captures real
secret values, so recorded-to-replay conversion inserts placeholders that the
operator fills with test data.

## Step actions

`navigate` · `reload` · `back` · `forward` · `click` · `type` · `select`
· `waitFor` · `captureState` · `captureScreenshot` · `assert`.

These map 1:1 onto the `BrowserController` abstraction (Component 3).

## Execution controls (Component 5)

| Control      | Meaning                                                        |
|--------------|---------------------------------------------------------------|
| `pause`      | Halt before the next step; state preserved.                   |
| `resume`     | Continue from the paused step.                                |
| `step`       | Execute exactly one step, then pause (step-by-step).          |
| `retry`      | Re-attempt a failed step up to `retries`.                     |
| `timeout`    | Per-step deadline (`timeoutMs`).                              |
| `checkpoint` | Mark a step as a rollback anchor.                             |
| `rollback`   | Return run state to the last checkpoint.                      |
| `dry-run`    | Validate + plan the run; execute **no** side effects.        |
| `mock`       | Force `target.kind = mock`; ignore any authorized target.    |

## Run record

```jsonc
{
  "runId": "01J...",
  "workflow": "reservation-test",
  "mode": "SIMULATE",
  "startedAt": 1750000000000,
  "status": "completed",             // pending|running|paused|completed|failed|rolledBack
  "steps": [
    { "id": "s1", "status": "ok", "startedAt": ..., "endedAt": ..., "attempts": 1 }
  ],
  "checkpoints": ["s3"],
  "sourceSessionId": "01J..."        // when derived from a recording, for comparison
}
```

Run records are the unit the analyzer diffs when comparing multiple runs
(Component 9 → "compare sessions").
