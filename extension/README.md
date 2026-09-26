# @lab/extension — Chrome MV3 recorder

Records **your own** browser workflow, redacted at source, and delivers it to
the local lab service over an authenticated loopback bridge. It shows a **REC**
badge whenever recording is on. It never automates anything; replay is done by
the service's replay engine against the mock or an authorized target.

## Layout

```
extension/
  manifest.json            least-privilege MV3 manifest (policy-checked)
  build.mjs                esbuild bundle + artifact verification → dist/
  src/
    background/            service worker: sessions, tabs, navigation, alarms, badge
    content/               content script (clicks/changes/submits, DOM summary, page state)
                           + capture.ts (pure element description, redaction rules)
    recorder/              recorder pipeline: build → redact → detect workflow → dedup
                           → queue → debounced/batched flush → retry/backoff
    bridge/                BridgeClient: auth, loopback-only, timeout, reconnect, handshake
    storage/               IndexedDB queue (durable across worker restarts) + chrome.storage
    popup/  options/  ui/  controls, pairing, recordable origins, styles
    common/                config, message protocol, manifest policy, path sanitizing
  test/                    node:test unit tests (no browser needed)
```

## Build & load (Chrome / Edge / Chromium ≥ 116)

```bash
pnpm install                    # once (esbuild, types)
pnpm run build:extension        # → extension/dist (verified)
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension/dist`.
3. Start the service (`pnpm run start:service`). It writes a pairing token to
   `<LAB_DATA_DIR>/auth-token.txt` (default `./.lab-runtime/auth-token.txt`).
4. Extension **Options** → paste the token → **Test connection** (should say
   `connected`).
5. Optional hardening: pin the service to this extension only with
   `LAB_ALLOWED_ORIGINS=chrome-extension://<extension-id>`.
6. Open the mock Extranet (`pnpm run start:mock` → http://127.0.0.1:4599), click
   the toolbar icon → **Start recording**, work through a flow → **Stop**.

## Permissions (and why)

| Permission | Why |
|---|---|
| `storage` | config, pairing token, active session, recording flag |
| `alarms` | 30-second delivery/reconnect backstop (MV3 workers sleep) |
| `scripting` | register the content script for origins **you** grant at runtime |
| `activeTab` | user-triggered screenshot of the current tab |
| host `http://127.0.0.1/*`, `http://localhost/*` | the local service + the mock Extranet |
| optional host `http(s)://*/*` | *requested per exact origin* from Options; never granted wholesale |

Not requested, and rejected by the manifest policy test and the build:
`<all_urls>`, `tabs`, `webNavigation`, `webRequest*`, `declarativeNetRequest*`,
`cookies`, `proxy`, `debugger`, `privacy`, `management`, `nativeMessaging`,
`externally_connectable`, `web_accessible_resources`, remote/inline/eval scripts.

## What is recorded

Each event uses the standardized recorder schema (`shared/src/events/recorded.ts`):
`event_id, session_id, seq, timestamp, tab_id, page, workflow, action, target, metadata`.

- **page** is the path only: query strings and fragments are dropped (they
  often carry tokens), and the path itself is redacted.
- **target** is structural: a selector (stable ids / data attributes, no entity
  ids), tag, role, and a caption only for buttons. Link text is never used as a
  label because it may contain guest names.
- **form fields** record `filled: true|false`, never the value. Password, OTP,
  card, IBAN, token, and similar fields are flagged `sensitive` and **not read
  at all**.
- **DOM changes** are debounced counts plus the top selectors; no text and no
  character data.
- The recorder additionally strips `value`/`innerText`/`innerHTML`-style keys,
  and `toLabEvent` redacts again. The service re-redacts and quarantines
  anything that still looks sensitive.

## Delivery guarantees

Events sit in an IndexedDB queue until the service confirms them. Transient
failures (offline, timeout, 5xx, 429) retry with exponential backoff plus
jitter. The bridge reconnects on its own, and recovery triggers an immediate
flush. Auth (401), origin (403), and contract mismatches **pause** delivery
without dropping data until you fix the configuration. Ingestion is idempotent,
so retries never duplicate events.

## Tests

```bash
pnpm run test:extension          # unit: recorder, bridge, capture, config, manifest policy
pnpm run test:e2e                # includes recorder → bridge → real service
```
