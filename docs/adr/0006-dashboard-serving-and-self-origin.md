# ADR-0006 — Dashboard: served by the service, same-origin, token in the fragment

- Status: Accepted
- Date: 2026-09-26
- Amends: docs/05-security-model.md (origin rule, static route),
  docs/01-architecture.md (dashboard row). Module boundaries unchanged:
  `dashboard` imports only `shared` and talks to the service over `/v1`.

## Context

Phase 9 adds the local forensic dashboard. It must use the existing local
service API without new runtime dependencies. The API rejects every web
(`http(s)://`) `Origin` and requires a bearer token on every data route. A
dashboard served from any other origin (a second local port, `file://`)
would need CORS and a relaxed origin rule, which widens the attack surface
to other local web servers — including the mock Extranet on port 4599.

## Decisions

1. **Static SPA, no framework.** `dashboard/` is vanilla TypeScript bundled by
   esbuild (already a dev dependency) into `dashboard/dist`. It imports
   `shared` through `dashboard/src/shared.ts` only.

2. **Served by the service at `/dashboard/`.** `GET`/`HEAD` of static files
   only; no data is served without the token. Files are resolved inside the
   configured directory (`LAB_DASHBOARD_DIR`, default `dashboard/dist`) with
   decoding, `..`/backslash/NUL rejection, a prefix check after `realpath`
   and an extension allow-list. `GET /` redirects to `/dashboard/`.

3. **Exact self-origin only.** The origin check additionally accepts exactly
   `http://<Host>` where `<Host>` is the request's already-validated loopback
   `host:port` of this service. Only pages served by the service itself carry
   that origin. Every other origin — other local ports (the mock, dev
   servers), other hosts, DNS-rebinding names — is still rejected with `403`.
   Extension origins and no-origin clients are handled as before.

4. **Token handling.** The operator opens
   `http://127.0.0.1:<port>/dashboard/#token=<token>` (printed by
   `pnpm run dashboard:url`) or pastes the token into the sign-in form. The
   fragment is never sent to the server; the app moves the token to
   `sessionStorage` (tab-scoped) and removes it from the address bar
   immediately. The token is sent only as `Authorization: Bearer`. No cookies
   are used, so CSRF stays impossible by construction.

5. **Browser hardening.** Every dashboard response carries
   `Content-Security-Policy: default-src 'none'; script-src 'self';
   style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none';
   form-action 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`,
   `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
   `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin`.
   The app renders all recorded data with `textContent` / attribute setters;
   the lint forbids HTML-injection sinks and dynamic code in `dashboard/src`.

6. **Read APIs for the dashboard** (same pipeline, token required):
   `GET /v1/stats`, `GET /v1/events` (query), `GET /v1/events/:id`,
   `GET /v1/runs`, `GET /v1/analysis/environment`; `GET /v1/sessions` gains
   additive summary fields and filters.

7. **Out of scope here.** Screenshot *images* are not retained by the current
   recorder (hash + size only, docs/06); the Screenshots page lists those
   records and does not introduce image storage. Triggering replays from the
   dashboard stays planned; the Runs page is read-only.

## Consequences

- One origin, one token, no CORS: the dashboard cannot be used as a bridge by
  other local web content.
- The dashboard works whenever the service runs; `pnpm run build` produces it.
- Security review surface: the static route (tests cover traversal, headers,
  and that other local origins are still rejected).

## Amendments

- Phase 10: `style-src` also allows exactly the report stylesheet hash, so
  report previews (blob documents inheriting this policy) render styled.
- Phase 12: `img-src` also allows `blob:` — stored screenshots are fetched with
  the token and displayed from blob URLs. Scripts, connections and frames are
  unchanged (regression-tested).

