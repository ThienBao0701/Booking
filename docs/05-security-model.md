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

1. **Bind to loopback only** (`127.0.0.1`), never `0.0.0.0`.
2. **Require an auth token** — a random token generated at install, stored in a
   user-only file, sent as `Authorization: Bearer <token>` (or the
   native-messaging handshake). Requests without it get `401`.
3. **Origin / Host validation** — reject requests whose `Origin` is a web
   origin and whose `Host` header is not an allow-listed loopback host:port
   (defense against DNS-rebinding). The extension origin is allow-listed by id.
4. **Rate limiting** — per-token, per-route token-bucket; excess → `429`.
5. **CSRF protection** — state-changing routes require the bearer token (not a
   cookie), so a cross-site form/`fetch` cannot forge them; plus a
   double-submit nonce for any browser-originating control route.
6. **Structured logging** — every request logged as JSON (method, route,
   status, latency, token id hash) to rolling logs; tokens are never logged in
   full.

## Extension permissions (Component 13)

- No `<all_urls>`. Host permissions are limited and, where possible, requested
  at runtime via `activeTab` / optional host permissions for the specific
  target the operator is debugging.
- `manifest.json` declares only the permissions each feature needs, documented
  inline. See `extension/manifest.json` and `docs/README` permissions table.

## Data at rest

- SQLite database and logs live under a user-owned directory with
  user-only permissions; nothing is written outside it.
- No telemetry, no outbound network calls from the service. (The mock-extranet
  is local; observed production hosts are recorded as host strings only.)

## Secrets

- The auth token is the only secret the tool stores. It is created locally,
  never transmitted off-box, and is `.gitignore`d.
- Credentials of the site being observed are **never** captured (privacy model).

## Explicit non-goals

This is not a penetration-testing tool and contains no capability to attack,
evade, or defeat any remote system's protections. See ADR-0002.
