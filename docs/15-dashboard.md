# 15 — Forensic Dashboard (Phase 9)

A local, read-mostly dashboard over the service API. Static single-page app in
`dashboard/` (vanilla TypeScript, bundled by esbuild, no runtime dependencies),
served by the service at **`http://127.0.0.1:4577/dashboard/`**. Decisions and
security rationale: [ADR-0006](adr/0006-dashboard-serving-and-self-origin.md).

## Open it

```bash
pnpm run build            # builds the extension and the dashboard (dashboard/dist)
pnpm run start:service
pnpm run dashboard:url    # prints http://127.0.0.1:4577/dashboard/#token=…
```

Open the printed link, or open `/dashboard/` and paste the token from
`<LAB_DATA_DIR>/auth-token.txt`. The token is read from the URL fragment
(never sent to a server), kept in this tab's `sessionStorage`, removed from the
address bar immediately, and sent only as `Authorization: Bearer`. *Settings →
Sign out* forgets it.

## Pages

| Page | What it shows | Data |
|---|---|---|
| **Overview** | headline counts; events per day; findings by severity (icon + label); events by kind / workflow (click to filter); recent sessions; highest-severity findings | `/v1/stats`, `/v1/sessions`, `/v1/findings` |
| **Sessions** | filterable list with counts; select two → **compare**. Detail: summary, data quality, workflow sequence, timing + longest pauses, environment, segments, repeated operator sequences, findings, *Re-run analysis* | `/v1/sessions`, `/v1/sessions/:id/analysis`, `/v1/analysis/run` |
| **Compare** | similarity, workflow sequences (common / only A / only B), time per workflow (paired bars + table), counts, timing, action and environment differences, bounding notes | `/v1/analysis/compare` |
| **Timeline** | one session: a lane per tab (+ session lane), labelled workflow segments, every event as a tick (errors ✖ / warnings ▲), finding ranges packed into rows; zoom 1–16×; table view | events, analysis, findings |
| **Workflows** | arc diagram of workflow transitions across the selected sessions (forward above, returns below, thickness = count); node / transition tables; click an arc for sample events | `/v1/analysis/graph` |
| **Events** | cross-session event search (range, session, kind, workflow, severity, text); rows open the **event drawer** | `/v1/events` |
| **Findings** | filterable list (range, session, workflow, severity, category, rule, text). **Drill-down**: description, confidence (explained), evidence table with the exact triggering event ids (each opens the drawer), counter-evidence, platform caveat, recommended next test, context | `/v1/findings`, `/v1/findings/:id` |
| **Environment** | recorded environment facts per session; values differing from the most common value are marked `≠` | `/v1/analysis/environment` |
| **Runs** | replay runs with step outcomes; detail with steps, checkpoints, target + authorization record | `/v1/runs`, `/v1/runs/:id` |
| **Replay** | plan a workflow (examples, library, or a recording) as a dry run; review target, authorization, workflow, step count, risk notice; start only after an explicit acknowledgement; live progress, controls (pause / resume / step / retry / checkpoint / rollback / stop), log and result ([19-dashboard-replay](19-dashboard-replay.md)) | `/v1/replay/*` |
| **Screenshots** | stored images (grid, delete one / a session's), capture records, storage usage; storage is off by default ([18-screenshot-storage](18-screenshot-storage.md)) | `/v1/screenshots`, `/v1/events?kind=SCREENSHOT` |
| **Reports** | per-session forensic report: executive summary, key findings, section overview, integrity digest; download JSON / CSV ×3 / HTML / print-ready HTML; preview HTML ([16-reports](16-reports.md)) | `/v1/reports/sessions/:id` |
| **Settings** | screenshot storage switch, retention and limits; service health and versions; analysis rules (table, JSON editor validated in the browser with the shared validator and again, fail-closed, by the service; reset to built-in); theme; sign out | `/healthz`, `/v1/bridge/handshake`, `/v1/analysis/rules` |

**Event drawer** (from any event row, tick, evidence row or sample): stored
fields, redacted payload as text, links to the timeline and session, and the
persisted findings that cite this event.

**Filters** sit in one row above the content and live in the URL hash, so
every view is linkable and survives reloads. The top bar searches events.

## Charts

Built to the data-visualisation method: one validated palette (categorical
slots 1–2 only for A/B; checked with the palette validator in light and dark),
status colours reserved for severity/status and always paired with an icon and
label, thin marks with 4 px rounded data-ends, hairline grid, legends for two
series, selective direct labels, hover **and** keyboard-focus tooltips, and a
table view next to every chart. Workflow identity is carried by text labels,
not by colour (there are more workflows than safe categorical hues). Dark mode
follows the OS or the Settings choice.

## Security

- Served only by the service (same origin); no CORS. The API accepts exactly
  the service's own origin in addition to extension / no-origin clients; any
  other origin, including other local ports, is rejected (`403`).
- CSP `default-src 'none'; script-src 'self'; style-src 'self' '<report
  stylesheet hash>'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`, plus `X-Frame-Options: DENY`, `no-referrer`,
  `nosniff`, COOP/CORP `same-origin`.
- Recorded data is untrusted: all rendering uses text nodes and attribute
  setters; hrefs are limited to in-app routes and same-origin paths. The lint
  (`safety/dom-sink`) and the build verification reject HTML sinks and dynamic
  code in the dashboard.
- The dashboard CSP's `style-src` additionally allows exactly the report
  stylesheet hash, so report previews (same-origin blob documents that
  inherit the dashboard policy) render styled; reports contain no scripts.
- Static route: GET/HEAD only, extension allow-list, `..`/NUL/backslash/hidden
  files rejected, realpath confinement (symlinks cannot escape), `503` with a
  hint when the dashboard is not built.

## Configuration

`LAB_DASHBOARD_DIR` — directory served at `/dashboard/` (default
`dashboard/dist` next to the service sources).
