# ADR-0007 — Browser adapter layers and egress enforcement

- Status: Accepted
- Date: 2026-09-26
- Amends: docs/01-architecture.md (automation engine gains a real-browser
  controller). The `BrowserController` interface and `MockExtranetController`
  are unchanged.

## Context

Phase 11 adds real-browser automation (CDP/Playwright) for authorized targets.
The replay engine already authorizes before launching a controller, but a real
browser can reach any host a page points it to. While building it, the
real-browser test showed that **Playwright request routing is not invoked for
redirect hops**: an allowlisted page answering `302 → other origin` made
Chromium contact the other origin before any check could run.

## Decisions

1. **Four layers** under the unchanged interface: `BrowserTargetPolicy`
   (authorization + allowlist), `BrowserAdapter` (engine abstraction, a
   Playwright-compatible subset; Playwright/Chromium implementation loaded
   lazily), `BrowserSession` (tabs, lifecycle, routing, logs) and
   `BrowserAdapterController` (the interface implementation).
2. **Authorization before existence**: a policy object is only created after
   `evaluateReplay` allows the mode + target; the target origin must also be
   in an explicit allowlist. No policy → no session → no browser.
3. **Egress proxy as the enforcement point**: every browser session launches
   Chromium with a per-session loopback proxy (no loopback bypass). It checks
   every connection (each redirect hop, CONNECT tunnel, WebSocket upgrade)
   against the allowlisted origins and refuses the rest with 403. Request
   routing stays as the first, more detailed layer; a landing check after
   each navigation is the last.
4. **No disguise**: no extra launch arguments, no user-agent / navigator /
   automation-indicator changes; the proxy forwards directly from this machine
   and never rotates or chains. The lint rejects automation-indicator
   suppression and stealth plugins.
5. **Error model**: adapter failures map to existing `ControllerErrorCode`s
   (retry behaviour unchanged) plus a `category` for diagnostics.

## Consequences

- A browser run needs `--allow-origin <target>`; forgetting it fails closed.
- Third-party resources an authorized site needs must be listed explicitly as
  resource origins.
- Tests cover the redirect case in a real browser; it cannot regress silently.
