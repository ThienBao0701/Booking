# ADR-0002 — Safety scope and hard exclusions

- Status: Accepted
- Date: 2026-09-26

## Context

The lab observes, reproduces, and analyzes browser/Extranet workflows. Some
capabilities in the browser-automation space are dual-use and can shade into
evading or defeating other systems' security controls. We need an unambiguous,
enforced boundary.

## Decision

1. The tool's purpose is **diagnostics, QA, and authorized automation** on
   systems the operator owns or is authorized to test (including the bundled
   mock environment).
2. The following capabilities are **forbidden and not implemented**:
   anti-detection, stealth evasion, fingerprint spoofing, IP rotation, CAPTCHA
   bypass, bot-detection bypass, fake/synthetic human-behavior generation.
3. The forbidden set is encoded in `shared/src/safety/capabilities.ts` and
   asserted by `shared/test/safety.test.ts`. Marking any of them available, or
   adding a capability whose purpose is to defeat a remote system's controls,
   must fail CI.
4. Replay is gated by a **target guard**: only the mock environment or an
   operator-declared `authorized` target (with an authorization record) is
   permitted.
5. Recording never captures credentials or secrets (see privacy model), and the
   request-observability layer only reads metadata — it never modifies or
   forges server-side controls.
6. **Tie-breaker rule:** where an implementation could be read as either
   "diagnostics / authorized automation" or "bypass security", choose the
   former, or do not implement it.

## Consequences

- The system is safe to build and operate as a lab.
- Any future request to add an excluded capability requires a superseding ADR
  and would contradict the project's stated purpose; the maintainers' default
  answer is no.
- Some "make it look human / avoid detection" feature requests are out of scope
  by construction.
