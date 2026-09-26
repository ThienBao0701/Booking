# 17 — Browser Adapter (Phase 11)

Real-browser automation for the replay engine, behind the unchanged
`BrowserController` interface. `MockExtranetController` is untouched and stays
the default. Code: `windows-service/src/automation/browser/`;
decisions: [ADR-0007](adr/0007-browser-adapter-and-egress-enforcement.md).

## Layers

| Layer | File | Responsibility |
|---|---|---|
| `BrowserController` | `../controller.ts` (existing) | the interface the replay engine drives |
| `BrowserAdapterController` | `controller.ts` | implements it over a session: timeouts, cancellation, `$last` rule, redacted state capture, screenshots, checkpoints |
| `BrowserSession` | `session.ts` | one browser + one isolated context: tabs, page lifecycle, request routing, network settling, dialogs, crash/disconnect detection, blocked-request log |
| `BrowserAdapter` | `adapter.ts` | engine abstraction (browser → context → page, Playwright-compatible subset); `PlaywrightAdapter` = Chromium over CDP |
| `BrowserTargetPolicy` | `target-policy.ts` | authorization + explicit origin allowlist |
| `EgressProxy` | `egress-proxy.ts` | per-session loopback proxy: the network enforcement point |

## Authorization happens first

1. `BrowserTargetPolicy.create({ mode, target, allowlist, resourceOrigins })`
   runs the shared `evaluateReplay` (safety mode, mock-must-be-loopback,
   authorization record). If it denies, **no policy exists**, so no browser
   can be created.
2. The target's origin must be listed in the **explicit allowlist** — an
   authorization record alone is not enough to drive a browser.
3. `launch()` verifies the launch URL is the policy's target **before** the
   adapter starts a browser; the replay engine additionally authorizes before
   calling `launch()` (unchanged).
4. Each `navigate()` is checked before the request is issued.

Allowlist entries are exact origins: `https://host[:port]` for remote hosts,
`http://` only for loopback; no wildcards, paths, queries or userinfo; at most
50 entries. `resourceOrigins` (e.g. a CDN) are allowed for sub-resources only,
never for navigation.

## Enforcement in the browser

- **Routing layer** — every request the page issues is checked
  (`checkRequest`) and aborted when not allowed; the session logs it with
  origin + path only (queries dropped, redacted).
- **Egress proxy** — the browser is launched with the session's loopback proxy
  as its only way out (`<-loopback>`: loopback traffic too). Every connection —
  **each redirect hop**, HTTPS `CONNECT` tunnel and WebSocket upgrade — is
  checked against the allowlisted origins; denied connections get `403` and
  never reach the other host. This closes the gap that Playwright request
  routing does not see redirect hops (found by the Phase 11 real-browser test).
- **Landing check** — after every navigation, history move or click, the page
  must be on an allowlisted origin; otherwise the tab is moved to
  `about:blank` and the step fails with `NAVIGATION_BLOCKED`. An action that
  tries to navigate outside the allowlist fails the same way.
- Service workers are blocked and downloads refused in the context.

The proxy confines; it does not disguise: 127.0.0.1 only, direct forwarding
from this machine (same IP, the browser's own headers), no upstream proxy, no
rotation. The adapter adds no launch arguments and never changes the
user-agent, `navigator` properties or automation indicators; the lint rejects
such code (`safety/evasion-api`).

## Controller semantics

| Method | Behaviour |
|---|---|
| `openTab(url?)` / `closeTab(id?)` | tabs `tab-1…`; the new tab becomes active; closing the active tab activates the last remaining one |
| `navigate(url)` | relative URLs resolve against the target; waits for `load`, then for in-flight requests to settle (≤ 2 s) |
| `reload` / `back` / `forward` | `NO_HISTORY` when there is nothing to go to |
| `click` / `type` / `select` / `waitFor` | CSS selectors, strict (an ambiguous selector fails with `WRONG_ELEMENT`); `waitFor` = visible |
| `$last` rule | `[attr="$last"]` / `[attr="$last.<kind>"]` → the **last** matching element in document order; a `<select>` value `$last` → the last non-empty option (waits for options to load) |
| `captureState` | URL, tab, form fields — password / hidden / file inputs and sensitive names (token, secret, card, …) are never read; other values pass `redactFieldValue` |
| `captureScreenshot` | PNG + SHA-256 (`supported: true`) |
| `snapshot` / `restore` | the active tab's URL (checkpoint/rollback return to it; typed input is not restored) |
| dialogs | dismissed automatically and logged (message redacted) |

Every action honours `opts.timeoutMs` and `opts.signal`: an aborted action
returns immediately with `ABORTED` (the replay engine's stop / step timeout).

## Error classification

Failures become `BrowserError` (a `ControllerError`, so the engine's retry
rules are unchanged) with a stable `code` and a finer `category`:

| category | code | retryable |
|---|---|---|
| timeout | `TIMEOUT` | yes |
| aborted | `ABORTED` | no |
| element_missing / element_hidden | `ELEMENT_NOT_FOUND` / `NOT_VISIBLE` | yes |
| ambiguous_selector | `WRONG_ELEMENT` | no |
| option_missing | `OPTION_NOT_FOUND` | yes |
| navigation_blocked / request_blocked | `NAVIGATION_BLOCKED` | no |
| network (connection refused/reset, DNS) | `TARGET_ERROR` | yes |
| browser_closed / page_crashed / launch_failed | `TARGET_ERROR` | no |
| unsupported (e.g. playwright-core missing) | `UNSUPPORTED` | no |

## Running

```bash
pnpm run replay examples/workflows/mock-full-flow.json \
  --controller browser --allow-origin http://127.0.0.1:4599 \
  --params-file examples/workflows/mock-full-flow.params.json [--headed]
```

`playwright-core` is optional and loaded on demand (the service keeps zero
runtime dependencies); `LAB_BROWSER_EXECUTABLE` or `--browser-path` selects the
Chromium/Chrome/Edge binary. Without `--allow-origin <target origin>` the run
is denied (exit 2) before any browser starts.

## Tests

- Unit (`windows-service/test/browser-adapter.test.ts`, in-memory adapter):
  allowlist normalisation, policy creation (every denial path), navigation /
  request checks, error classification, launch gating (no browser for a
  non-authorized URL), blocked navigations never reach the browser, redirects
  landing elsewhere, in-page blocked requests (logged without queries), `$last`,
  strictness, tabs/history/checkpoints, dialogs, crash/disconnect, abort and
  timeout, redacted state capture, screenshots, engine integration, CLI denial.
- Unit (`egress-proxy.test.ts`, real sockets): forwarding, 403 for other
  origins, redirect hops re-checked, CONNECT tunnels, WebSocket upgrades.
- Real browser (`tests/browser/browser-adapter.browser.test.ts`): the example
  workflow replays on the real mock UI in Chromium with the same module
  sequence as the mock controller; nothing (image, fetch, link, direct
  navigation, **redirect**) reaches a non-allowlisted origin; passwords are
  never read; dialogs, `$last` selects, timeouts and tabs behave.
