# 07 — Safety Modes & Policy (Component 12)

The safety policy is **code**, not documentation. It lives in
`shared/src/safety/` and is unit-tested (`shared/test/safety.test.ts`). No
configuration flag, env var, or API call can enable a forbidden capability.

## Modes

| Mode                   | Recording | Replay side effects | Allowed replay targets           |
|------------------------|-----------|---------------------|----------------------------------|
| `OBSERVE`              | yes       | none                | none (observe only)              |
| `SIMULATE`             | yes       | mock only           | `mock`                           |
| `AUTHORIZED_AUTOMATION`| yes       | yes                 | `mock` **or** `authorized` (with authorization record) |

- Default mode is `OBSERVE`.
- `SIMULATE` runs replays against the mock environment only. A `mock` target
  must be a **loopback URL** (127.0.0.1 / localhost / [::1]); a real system
  labelled "mock" is denied with `MOCK_TARGET_NOT_LOCAL` (ADR-0004).
- `AUTHORIZED_AUTOMATION` permits replay against an operator-declared authorized
  target. Selecting it requires an `authorization` record (owner, system,
  granted-by, acknowledgement timestamp). The tool records this record with each
  run for traceability.

### Service mode as a ceiling (dashboard replays)

Replays started from the dashboard ([19-dashboard-replay](19-dashboard-replay.md))
may not use a mode above the service's `LAB_SAFETY_MODE`. With the default
`OBSERVE`, the dashboard can plan and review a workflow but not execute it; run
the service with `SIMULATE` to replay against the local mock, and with
`AUTHORIZED_AUTOMATION` only when an authorized target is intended.

## Forbidden capabilities (hard denylist)

The following are **not implemented** and cannot be enabled. The registry in
`shared/src/safety/capabilities.ts` lists them as `forbidden`, and a unit test
asserts none is ever marked available:

- `ANTI_DETECTION`
- `STEALTH_EVASION`
- `FINGERPRINT_SPOOFING`
- `IP_ROTATION`
- `CAPTCHA_BYPASS`
- `BOT_DETECTION_BYPASS`
- `FAKE_USER_BEHAVIOR`

Any code path that requests one of these throws `ForbiddenCapabilityError` and
is rejected at the policy boundary. Adding such a capability would fail CI.

## Where the policy is enforced

| Layer | Enforcement |
|---|---|
| `shared/src/safety` | modes, forbidden-capability denylist, target guard (`evaluateReplay`) — unit-tested |
| Replay engine | authorization before any controller call; mock-only mode; params never persisted |
| Replay manager (dashboard) | dry-run plan; single-use confirmation + acknowledgement; service mode ceiling; one active run |
| Controller | bound to one origin; `MockExtranetController` refuses non-loopback targets |
| Extension | least-privilege manifest policy (tests + build + lint); loopback-only bridge |
| Lint (`scripts/lint.mjs`) | forbidden capability names and evasion APIs (navigator/screen overrides, `chrome.proxy`, `chrome.debugger`) rejected in source |

## Request observability, not manipulation (Component 7)

The lab observes request/response **metadata** (timing, status, redirects,
retries) for debugging. It does not modify, replay against production, forge,
throttle-evade, or otherwise interfere with server-side security controls.

## Guiding rule

> Where an implementation could be read as either "diagnostics / authorized
> automation" **or** "bypass security", choose diagnostics / authorized
> automation — or do not implement it.

This rule is recorded in ADR-0002 and is binding on all future changes.
