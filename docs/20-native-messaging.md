# 20 — Native Messaging (Phase 14)

The extension can reach the service through Chrome's **Native Messaging**
instead of loopback HTTP:

```
Chrome extension (service worker)
   │  chrome.runtime.connectNative("com.automation_lab.bridge")
   │  length-prefixed JSON on stdio (Chrome starts the host process)
   ▼
Native host (windows-service/src/native, Node)
   │  loopback HTTP, the same /v1 pipeline as every other client
   ▼
Lab service (Windows service)
```

HTTP loopback stays available: the default transport **auto** uses the native
host when it is installed and falls back to HTTP when it is not. Decision
record: [ADR-0009](adr/0009-native-messaging-bridge.md).

## Install the host

1. Find the extension id on `chrome://extensions` (Developer mode shows it).
2. Install (per user; no administrator rights):

   ```bash
   pnpm run native-host:install -- --extension-id <id>
   pnpm run native-host:status
   ```

   Options: `--extension-id` (repeatable), `--service-url` (loopback; default
   from `LAB_SERVICE_HOST` / `LAB_SERVICE_PORT`), `--install-dir` (default
   `<LAB_DATA_DIR>/native-host`), `--log-dir` (default `<LAB_DATA_DIR>/logs`),
   `--browser chrome|edge|chromium` (repeatable; default all three),
   `--user-data-dir <profile>` (POSIX: a custom Chromium profile),
   `--dry-run`, `--json`.

3. In the extension **Options**, *Transport* is **Automatic** by default; pick
   **Native messaging host only** to require it. The popup shows the transport
   in use (`native host`, `HTTP (fallback)` or `HTTP loopback`).

What the installer writes:

| Item | Windows | Linux / macOS |
|---|---|---|
| Host manifest `com.automation_lab.bridge.json` | install dir | install dir, plus each browser's `NativeMessagingHosts/` dir |
| Registration | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.automation_lab.bridge` (and `Microsoft\Edge`, `Chromium`) → manifest path | the manifest copies above; `<profile>/NativeMessagingHosts/` for `--user-data-dir` |
| Launcher | `lab-native-host.cmd` | `lab-native-host.sh` (0700) |
| Host config `native-host.json` | install dir (0600 where supported) | same |

The manifest's `allowed_origins` lists exactly the given extension ids. The
launcher runs `node --experimental-strip-types windows-service/src/native/main.ts
--config <native-host.json>`; Chrome appends the caller origin (and, on
Windows, `--parent-window=`).

Re-running `install` is an upgrade (files rewritten, registry values
overwritten, e.g. after moving the checkout or changing Node). **Uninstall**
removes the manifests, launcher, config, registry keys and the install
directory when empty; removing something already absent is not an error:

```bash
pnpm run native-host:uninstall
```

Host logs (`<log dir>/native-host.log`, rolled at 2 MiB × 3) are kept with the
service logs.

## Protocol (version 1)

Messages are JSON; Chrome frames them with a 32-bit native-order length. Host →
extension messages are at most 1 MiB (Chrome's limit); extension → host at most
32 MiB. Contract: `shared/src/native/protocol.ts`.

| Direction | Message | Purpose |
|---|---|---|
| ext → host | `hello {protocol:{min,max}, extensionVersion, contractVersion}` | must come first |
| host → ext | `welcome {protocol, hostVersion, contractVersion, service:{url, reachable, safetyMode}}` | negotiated version (highest common) |
| ext → host | `request {id, method, path, headers, body?}` | one bridge call |
| host → ext | `response {id, status, body?}` | the service's answer, unchanged |
| host → ext | `error {id?, code, message, retryable, fatal}` | typed failure; `fatal` closes the connection |
| both | `ping {id}` / `pong {id}` | liveness |

Error codes: `invalid_message`, `handshake_required`, `already_handshaken`,
`unsupported_protocol`, `origin_not_allowed`, `host_misconfigured`,
`route_not_allowed`, `service_unreachable` (retryable), `timeout` (retryable),
`busy` (retryable), `message_too_large`, `response_too_large`, `internal`.

## Security

- **Who can connect.** Chrome starts the host only for extensions listed in
  `allowed_origins`. The host checks the caller origin again against its own
  config and refuses anything else (`origin_not_allowed`, then exits). A
  missing or invalid config refuses every connection (`host_misconfigured`).
- **Authentication unchanged.** The host holds no secret. Each request carries
  the extension's own bearer token; the host forwards it with the verified
  extension origin as `Origin`, so the service's token check,
  `LAB_ALLOWED_ORIGINS` pinning, Host validation and rate limit apply exactly
  as over HTTP.
- **Least reach.** Only the bridge's routes are relayed: `GET /healthz`,
  `GET /v1/bridge/handshake`, `POST /v1/sessions`,
  `POST /v1/sessions/<id>/end`, `POST /v1/events`, `POST /v1/screenshots`.
  Only `authorization`, `content-type` and `accept` headers pass. The service
  URL must be loopback; no redirects are followed.
- **Validation.** Every message is schema-validated in both directions
  (unknown fields rejected). A framing error is fatal (the stream cannot be
  resynchronised); other invalid messages get an `invalid_message` error.
- **Timeouts and limits.** Handshake 3 s (extension side), per request
  `timeoutMs` (host, default 10 s) plus the bridge's own per-request timeout;
  at most 16 requests in flight; size limits as above.
- **No secrets in logs.** stdout carries only protocol frames; the host log
  records method, path, status and duration, never headers or bodies.
- **Extension side.** `nativeMessaging` is the only permission added
  (ADR-0009). `connectNative` may be called only in the service worker, with
  the lab host name; `sendNativeMessage` is not used (lint and build enforce
  both).

## Reconnect and fallback

- The host lives as long as the port. If it exits or crashes, in-flight
  requests fail, the bridge retries with backoff, and the next request starts
  the host again (new handshake).
- In **auto**, a host that cannot be reached *before* the handshake completes
  (not installed, refused, no common protocol, handshake timeout) switches the
  bridge to HTTP loopback; native is tried again after 60 s. Nothing that was
  relayed is re-sent over HTTP by the transport; the bridge's own retries are
  idempotent (events de-duplicated by id).
- In **native only**, the bridge shows `offline` until the host works.

## Tests

- `shared/test/native-protocol.test.ts` — schema validation, negotiation, the
  route allowlist.
- `windows-service/test/native-host.test.ts` — framing; config fail-closed;
  origin refusal; handshake and version negotiation; relay to a real service
  (401 for a bad token, `LAB_ALLOWED_ORIGINS` still enforced); route and header
  allowlists; unreachable / timeout / oversized / busy; the host as a real
  process on stdio; no token in logs.
- `windows-service/test/native-install.test.ts` — Windows registry and `.cmd`
  plan, POSIX locations, input validation, install → status → upgrade →
  corrupted config → uninstall → idempotent uninstall, CLI dry run.
- `extension/test/native-transport.test.ts` — handshake, typed errors,
  invalid host messages, header allowlist, abort, host loss → reconnect,
  refused/missing host, auto fallback and native retry, BridgeClient over the
  native transport, manifest policy (only `nativeMessaging` added).
- `tests/e2e/native-messaging.e2e.test.ts` — Recorder → bridge → the real host
  process (started through the installed launcher) → service; host crash →
  reconnect; uninstall → HTTP fallback with every event stored once; a
  non-allowed extension id is refused.
- `tests/browser/native-messaging.browser.test.ts` — Chromium: the built
  extension delivers a recorded session through the installed host; after
  uninstall, auto falls back to HTTP.

Windows-specific behaviour (registry, `.cmd` launcher) is covered by the plan
tests and a simulated `reg`; it has not been exercised on a Windows machine in
CI.
