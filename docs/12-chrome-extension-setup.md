# 12 — Chrome Extension Setup

The recorder is a Manifest V3 extension (`extension/`). It records **your own**
session, redacted at source, and sends it only to the lab service on this
machine. It never automates pages.

## Build

```bash
pnpm install
pnpm run build:extension
```

The build bundles the service worker (ESM) and the content script / popup /
options (IIFE), copies static files to `extension/dist/`, and **verifies** the
output: manifest least-privilege policy, every referenced file present, no
inline scripts, no forbidden APIs or `eval`, no module syntax in content
scripts. It exits non-zero on any violation.

## Load (Chrome, Edge, Chromium ≥ 116)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select `extension/dist`.
4. Pin *Browser Automation Lab — Recorder* to the toolbar.
5. Note the **extension ID** shown on the card (for optional origin pinning).

## Pair with the service

1. Start the service (`pnpm run start:service`).
2. Open the extension **Options** (popup → *Options & pairing*).
3. Service URL: `http://127.0.0.1:4577` (only loopback URLs are accepted).
4. Pairing token: paste the contents of `<LAB_DATA_DIR>/auth-token.txt`.
5. **Save**, then **Test connection** → expect `"state": "connected"`.
6. Optional hardening — restrict the service to this extension:
   `LAB_ALLOWED_ORIGINS=chrome-extension://<extension-id>` and restart it.

## Choose what may be recorded

- **Loopback** (`127.0.0.1`, `localhost`, i.e. the mock Extranet) is always
  recordable.
- To observe **another system you are authorized to use**, enter its exact
  origin in Options (e.g. `https://staging.example.com`) → **Add origin**.
  Chrome asks you to grant access to *that origin only*. Reload its open tabs.
- Remove an origin to revoke the permission and stop recording there.

Nothing else is ever captured: tabs on other origins are not tracked, and a
tab that navigates away is recorded only as "left scope" (not where it went).

## Record

1. Click the toolbar icon → **Start recording**. The icon shows a red **REC**
   badge (amber if the service is unreachable).
2. Work through the flow in a recordable tab.
3. **Screenshot** captures the visible tab on your click (recorded as a
   SCREENSHOT event with its SHA-256 and size).
4. **Stop recording** — remaining events are flushed and the session is ended
   on the service with the exact stop time.

The popup shows service health, bridge state, recorded / delivered / queued /
dropped-or-rejected counts, and why delivery is paused if it is.

## What gets recorded

| Captured | Never captured |
|---|---|
| clicks (structural selector, tag, role, button caption) | field values of any kind |
| field changes as `filled: true/false` | passwords, OTPs, card/IBAN numbers, tokens (not even read) |
| form submits (+ field count) | link text (may contain guest names) |
| SPA view changes, page state | query strings and URL fragments |
| debounced DOM-change counts + selectors | page text, character data |
| navigation paths (redacted), tab lifecycle for recordable tabs | cookies, headers, request bodies |

Details: [06 — Privacy model](06-privacy-model.md), schema:
[02 — Event schema](02-event-schema.md#recorder-view-standardized-recorder-schema).

## Offline behaviour

Events are queued in the extension's IndexedDB and survive service-worker
restarts, browser restarts and service downtime (cap: `maxQueue`, default
5000; oldest dropped and counted beyond it). Delivery resumes automatically when
the service is back (reconnect with backoff + a 30 s alarm); retries never
create duplicates.

## Updating / removing

- After `git pull`: `pnpm run build:extension`, then click **Reload** on the
  extension card.
- Removing the extension deletes its queue, token copy and settings.

## Permissions

`storage`, `alarms`, `scripting`, `activeTab`; hosts `http://127.0.0.1/*`,
`http://localhost/*`; optional hosts requested per exact origin. The full
rationale and the list of permissions that are rejected by policy:
[05 — Security model](05-security-model.md#extension-component-13).
