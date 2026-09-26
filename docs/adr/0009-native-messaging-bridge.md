# ADR-0009 — Native Messaging bridge (host as a validated relay; HTTP kept as fallback)

- Status: Accepted
- Date: 2026-09-26
- Amends: the manifest policy (ADR-0002 / Component 13: `nativeMessaging` moves
  from forbidden to allowed), docs/01-architecture.md (bridge transports),
  docs/05-security-model.md. The service API and its pipeline are unchanged.

## Context

Phase 14 asks for `Chrome Extension → Native Messaging Host → Windows Service`,
with a secure handshake, version negotiation, authentication, schema
validation, reconnect, timeouts and structured errors, while keeping HTTP
loopback as a fallback. The bridge already abstracts its transport
(`Transport` in `extension/src/bridge/client.ts`), and the service already
accepts clients without a web origin.

The policy so far forbade `nativeMessaging` as "not used; would widen reach".

## Decisions

1. **The host is a relay, not a second service.** It runs the shared protocol
   (`shared/src/native/protocol.ts`), validates every message, and forwards
   bridge calls to the service over loopback HTTP. It stores nothing and holds
   no secret; the extension's bearer token travels in each request and the
   service authenticates it as before.
2. **Origin is verified twice and preserved.** Chrome enforces the manifest's
   `allowed_origins`; the host checks the caller origin against its own config
   and forwards it as `Origin`, so `LAB_ALLOWED_ORIGINS` pinning keeps working.
3. **Least reach.** Only the six bridge routes and three headers are relayed;
   the service URL must be loopback; responses are size-capped; no redirects.
4. **Versioned protocol.** `hello` offers a range, the host picks the highest
   common version or refuses with `unsupported_protocol`.
5. **Permission.** The extension requests `nativeMessaging` (it only reaches
   hosts whose manifest names this extension). `optional_permissions` stay
   forbidden. `connectNative` is allowed in the service worker only, with the
   lab host name; `sendNativeMessage` is not used. Lint and the build verify
   this; every other forbidden permission remains forbidden (regression test).
6. **Fallback.** Transport `auto` (default) prefers native and falls back to
   HTTP loopback when the host cannot be reached before the handshake; `native`
   and `http` force one path.
7. **Installation is per user.** Windows registration under `HKCU` for Chrome,
   Edge and Chromium; manifest, launcher and config in the install directory;
   uninstall removes all of it.

## Consequences

- No new trust: the host cannot do anything the extension could not already
  do over HTTP, and cannot reach any route the extension does not use.
- Deployment gains a component (the host) with its own install/uninstall and
  log; `pnpm run native-host:status` reports its state.
- Chrome shows "Communicate with cooperating native applications" as a
  permission of the extension.
