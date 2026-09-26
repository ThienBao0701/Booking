# 05 — Security Model

## Threat model (local tool)

The lab runs entirely on the operator's machine. The assets to protect are:

- the recorded event data (may contain workflow structure of the operator's
  own account),
- the local service API (must not be reachable by web pages or other users),
- the operator's credentials (must never be captured — see privacy model).

Primary risks addressed: a malicious web page reaching the local API (CSRF /
DNS-rebinding), another local process reading data, and accidental capture of
secrets.

## Local API hardening (Component 13)

All service endpoints:

1. **Bind to loopback only** (`127.0.0.1`), never `0.0.0.0`; the service
   refuses to start on a non-loopback host.
2. **Require an auth token** — a random 256-bit token generated on first start
   into `<LAB_DATA_DIR>/auth-token.txt` (mode 0600), sent as
   `Authorization: Bearer <token>`; constant-time comparison. Requests without
   it get `401` (only `GET /healthz` is unauthenticated).
3. **Origin / Host validation** — the `Host` header must be exactly the bound
   loopback host:port (defense against DNS rebinding); any web (`http(s)://`)
   `Origin` is rejected with `403`. Extension origins are accepted; pin to one
   extension with `LAB_ALLOWED_ORIGINS=chrome-extension://<id>`. The one web
   origin accepted is the service's **own** origin (`http://<validated Host>`),
   which only the dashboard it serves carries (ADR-0006); other local origins
   — the mock on 4599, dev servers — remain rejected.
4. **Rate limiting** — fixed-window counter per (token, route); excess → `429`.
5. **CSRF protection** — every state-changing route requires the bearer token
   in the `Authorization` header, which a cross-site form or `fetch` cannot
   attach, and web origins are rejected outright. No route is authenticated by
   cookie, so no CSRF nonce is needed.
6. **Request validation** — 2 MiB body cap (`413`), invalid JSON → `400`, at
   most 500 events per batch (`413`), every event validated against the shared
   contract; invalid events are rejected per event, never stored.
7. **Timeouts** — headers 10 s, request 15 s, keep-alive 5 s: a stalled client
   cannot pin the service.
8. **Idempotency** — session registration and event ingestion are idempotent
   (duplicates reported, not re-stored), so client retries are always safe.
9. **Structured logging** — every request logged as JSON (method, route,
   status, latency) to rolling logs; tokens are never logged.
10. **Dashboard** (Phase 9, ADR-0006) — `GET`/`HEAD` `/dashboard/*` serves
   static files without the token (they contain no data) with a strict CSP,
   `X-Frame-Options: DENY`, `no-referrer`, `nosniff`, COOP/CORP; paths are
   decoded, `..`/NUL/backslash/hidden segments rejected, an extension
   allow-list applied, and the resolved `realpath` confined to the dashboard
   directory. Every data request still needs the bearer token. The token
   reaches the page via the URL fragment (never sent to a server) and lives in
   `sessionStorage`; no cookies, so CSRF remains impossible.
11. **Screenshot images** (Phase 12) — storage is off by default; uploads are
   refused unless enabled, must be PNG within the size limit and budget, must
   carry a SHA-256 equal to the bytes and belong to a recorded `SCREENSHOT`
   event of the same session (byte size, one image per event). Images are
   served only with the token, as `image/png` with `nosniff` and a sandbox CSP;
   the dashboard shows them from `blob:` URLs (its CSP allows `blob:` for
   `img-src` only).
12. **Reports** (Phase 10) — `GET /v1/reports/sessions/:id` needs the token
   like every data route. HTML reports contain no scripts and carry a CSP that
   allows only their own stylesheet (by hash), both as a header and as a
   `<meta>` tag so saved files keep it; all recorded strings are escaped by
   construction. CSV cells that a spreadsheet would evaluate (`= + - @` TAB CR)
   are prefixed with `'`. The CLI reads the local database file directly and
   writes output with mode 0600.
13. **Analysis routes** (Phase 8) use the same pipeline. Query parameters are
   validated (enums, integers, id charset, ≤ 200 session ids per request).
   `PUT /v1/analysis/rules` validates the rule set fail-closed (including the
   non-conclusive language guard and a 200-character regex cap) before an
   atomic write of `analysis-rules.json` (mode 0600); an invalid file on disk
   is ignored in favour of the built-in rules.

## Extension (Component 13)

| Permission | Why |
|---|---|
| `storage` | config, pairing token, active session, recording flag |
| `alarms` | 30 s delivery / reconnect backstop (MV3 workers sleep) |
| `scripting` | register the content script for origins the operator grants |
| `activeTab` | user-triggered screenshot of the current tab |
| hosts `http://127.0.0.1/*`, `http://localhost/*` | the local service and the mock Extranet |
| optional hosts `http(s)://*/*` | requested **per exact origin** from Options; never granted wholesale |

- No `<all_urls>`, `tabs`, `webNavigation`, `webRequest*`,
  `declarativeNetRequest*`, `cookies`, `proxy`, `debugger`, `privacy`,
  `management`, `nativeMessaging`, `externally_connectable`,
  `web_accessible_resources`, or remote/inline/eval scripts. The policy
  (`extension/src/common/manifest-policy.ts`) is enforced by unit tests, by the
  build and by the lint.
- The content script runs in the isolated world, only on recordable origins,
  and only while a session is active. The service worker accepts messages only
  from its own extension (`sender.id`) and re-scopes every capture by the
  **browser's** sender URL, not by what the page claims.
- A **REC** badge is shown whenever recording is on (transparency).

### Bridge

- The service URL must be loopback — enforced by config validation and by the
  `BridgeClient` constructor, so recorded data can never be sent off-box (a
  tampered stored URL falls back to the loopback default; covered by the
  browser E2E).
- Requests use `credentials: "omit"`, `cache: "no-store"` and
  `redirect: "error"` (a redirect can never carry the token elsewhere).
- The handshake verifies the endpoint is a lab service with a compatible
  contract version before the first event is sent.

## Replay / automation

- Authorization is decided before any controller call (validation → mock-only
  rule → shared policy target guard). Denied runs never touch the target.
- A `mock` target must be a loopback URL (ADR-0004); `authorized` targets need
  `AUTHORIZED_AUTOMATION` plus an authorization record, stored with the run.
- A controller is bound to one origin; navigation elsewhere is blocked. The
  shipped `MockExtranetController` refuses non-loopback targets entirely.
- Run parameters (test data, secrets for replay) are never persisted.
- **Real-browser replays** (Phase 11, ADR-0007): a `BrowserTargetPolicy` exists
  only after the shared policy allows the run, and requires the target origin
  in an explicit allowlist (exact origins; https for remote, http for loopback
  only). The browser's traffic is confined three times: request routing, a
  per-session loopback **egress proxy** that checks every connection including
  redirect hops, CONNECT tunnels and WebSockets, and a landing check after each
  navigation. Service workers are blocked, downloads refused, dialogs
  dismissed. State capture never reads password or sensitive fields.
- **Dashboard-initiated replays** (Phase 13, ADR-0008): planning is a dry run;
  `start` requires the plan's single-use confirmation token (random, 10 min,
  constant-time comparison) plus `acknowledge: true`; the service safety mode
  is the ceiling for the run's mode (an `OBSERVE` service never executes);
  one active run; parameter values are validated, kept in memory only, never
  logged. Regression tests: `replay-manager.test.ts`,
  `dashboard-replay.e2e.test.ts`, `replay.browser.test.ts`.

## Data at rest

- SQLite database and logs live under a user-owned directory with
  user-only permissions; nothing is written outside it.
- No telemetry, no outbound network calls from the service. (The mock-extranet
  is local; observed production hosts are recorded as host strings only.)

## Secrets

- The auth token is the only secret the tool stores. It is created locally,
  never transmitted off-box, and is `.gitignore`d. The extension keeps its copy
  in `chrome.storage.local`.
- Credentials of the site being observed are **never** captured (privacy model).

## Explicit non-goals

This is not a penetration-testing tool and contains no capability to attack,
evade, or defeat any remote system's protections. See ADR-0002.
