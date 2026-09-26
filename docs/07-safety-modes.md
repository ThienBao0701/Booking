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
- `SIMULATE` runs replays but forces the target to the mock environment.
- `AUTHORIZED_AUTOMATION` permits replay against an operator-declared authorized
  target. Selecting it requires an `authorization` record (owner, system,
  granted-by, acknowledgement timestamp). The tool records this record with each
  run for traceability.

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

## Request observability, not manipulation (Component 7)

The lab observes request/response **metadata** (timing, status, redirects,
retries) for debugging. It does not modify, replay against production, forge,
throttle-evade, or otherwise interfere with server-side security controls.

## Guiding rule

> Where an implementation could be read as either "diagnostics / authorized
> automation" **or** "bypass security", choose diagnostics / authorized
> automation — or do not implement it.

This rule is recorded in ADR-0002 and is binding on all future changes.
