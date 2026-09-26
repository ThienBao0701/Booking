# 16 — Forensic Reports (Phase 10)

One report per recorded session, generated locally from the stored events,
the analyzer and the persisted findings. Code: `windows-service/src/reports/`;
contract: `shared/src/reports/types.ts` (`ForensicReport`, `REPORT_SECTIONS`).

## Formats

| Format | How | Notes |
|---|---|---|
| **JSON** | `format=json` | the report document; the other formats are renderings of it |
| **CSV** | `format=csv&table=findings\|events\|evidence` | RFC 4180, CRLF, UTF-8 with BOM; formula-injection guard |
| **HTML** | `format=html` | self-contained: one inline stylesheet, no scripts, no external resources |
| **PDF-ready HTML** | `format=print` | A4 page rules, page breaks per section, repeated table headers; print → *Save as PDF* |

## Sections (document order)

1. **Executive Summary** — neutral statements (duration, events, workflow
   sequence, findings by severity, recording quality, target scope), key
   findings with their event ids.
2. **Session Information** — ids, times (UTC), mode, target, tabs, scope.
3. **Environment** — recorded facts only, with their source event ids.
4. **Timeline** — every event (seq, UTC time, offset, tab, kind, workflow,
   severity, summary, event id) and the findings that cite it. Above 5,000
   events the list is truncated **but every cited event is always included**.
5. **Workflow** — sequence, segments, transitions (with transition event ids),
   timing and longest pauses.
6. **Observed Sequences** — workflow sequence and repeated operator action
   sequences with the event ids of each occurrence.
7. **Findings** — every finding with rule, category, workflow, time range,
   confidence (explained), frequency, description, possible explanation and
   the exact triggering event ids.
8. **Evidence** — per finding, the evidence items (trigger + context events).
9. **Counter-evidence** — per finding; the platform caveat closes the section.
10. **Comparative Analysis** — baseline comparison (explicit `compare=<id>`,
    else the previous session, else the most recent other session), cohort
    size and per-rule prevalence, notes that bound the comparison.
11. **Recommended Next Test** — each suggested test with the findings it serves.

## Traceability

- Every finding lists its exact `event_ids`; each id is present in the
  timeline, and each timeline row lists the findings citing it (`cited_by`).
- HTML: a finding's event ids are links `#ev-<id>` to the timeline row, and
  timeline rows link back to `#f-<finding id>`.
- CSV: `findings.csv` has an `event_ids` column; `evidence.csv` has one row per
  (finding, event); `events.csv` has `cited_by_findings`.
- Findings source: the **stored** findings when the session was analysed
  (what the dashboard shows), otherwise computed for the report; the report
  states which, with the analysis time and rules version.
- Integrity: `integrity.digest` is the SHA-256 of the JSON report without its
  `integrity` field (also sent as `X-Report-Digest` and printed in the HTML
  footer and by the CLI).

Reports use the same non-conclusive language as findings: they describe
recorded patterns and never present them as proof of any platform action.
The disclaimer and the platform caveat are part of every report; a test scans
all generated report text with the language guard.

## API

`GET /v1/reports/sessions/:id?format=json|csv|html|print&table=findings|events|evidence&compare=<id>&download=1`

Same pipeline as every `/v1` route (loopback Host, Origin, bearer token, rate
limit). `download=1` sets `Content-Disposition: attachment` with a file name
`lab-report_<session>[_<table>]_<YYYYMMDD>.<ext>`. Unknown session / baseline
→ `404`; invalid parameters or `compare` equal to the session → `400`.

HTML responses carry `Content-Security-Policy: default-src 'none'; style-src
'sha256-…'; img-src data:; base-uri 'none'; form-action 'none';
frame-ancestors 'none'` plus `X-Frame-Options: DENY` and `no-referrer`; the same
policy (minus `frame-ancestors`) is embedded as a `<meta>` tag so a saved file
keeps it. All recorded strings are HTML-escaped by construction.

## Dashboard

*Reports* page: pick a session (and optionally a baseline) → executive summary,
key findings (event ids open the event drawer), section overview, integrity
digest, **Download** for every format (byte-exact, fetched with the token) and
**Preview** for HTML / print-ready HTML (opened as a same-origin blob document;
the dashboard CSP allows exactly the report stylesheet hash, nothing else).

## CLI

```bash
pnpm run report <sessionId> --format html --out report.html
pnpm run report <sessionId> --format csv --table evidence > evidence.csv
pnpm run report <sessionId> --format json --compare <baselineSessionId>
```

Reads `<LAB_DATA_DIR>/lab.sqlite` directly (`--db` to override); no network,
no token. Exit codes: `0` written, `1` session not found, `2` invalid arguments.
