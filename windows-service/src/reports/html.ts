/**
 * HTML and print-ready (PDF via the browser's "Save as PDF") renderings of a
 * forensic report. Self-contained: one inline stylesheet (allowed by a sha256
 * CSP hash), no scripts, no external resources. All recorded data passes
 * through `esc` via the tiny builder below, so it can never become markup.
 * Every finding links to its exact triggering events (#ev-…) in the timeline,
 * and every timeline event links back to the findings that cite it (#f-…).
 */

import { createHash } from "node:crypto";

import { type EvidenceItem, type Finding, type ForensicReport, PLATFORM_CAVEAT, REPORT_SECTIONS, type ReportSectionKey } from "../shared.ts";
import { fmtMs, iso, pct } from "./text.ts";

// ---------------------------------------------------------------- safe builder

class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}
type Node = Html | string | number | null | undefined | false | Node[];

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function render(n: Node): string {
  if (n === null || n === undefined || n === false) return "";
  if (Array.isArray(n)) return n.map(render).join("");
  if (n instanceof Html) return n.value;
  return esc(String(n));
}

/** Element with escaped attribute values; attribute names are code constants. */
function h(tag: string, attrs: Record<string, string | number | undefined> | null, ...children: Node[]): Html {
  const a = attrs
    ? Object.entries(attrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
        .join("")
    : "";
  return new Html(`<${tag}${a}>${render(children)}</${tag}>`);
}

/** Stable, attribute-safe anchor id for an event / finding id. */
export function anchor(prefix: "ev" | "f", id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_.:-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;
}

const evLink = (id: string) => h("a", { href: `#${anchor("ev", id)}`, class: "id" }, id);
const fLink = (id: string, text?: string) => h("a", { href: `#${anchor("f", id)}` }, text ?? id);

function kv(rows: Array<[string, Node]>): Html {
  return h("table", { class: "kv" }, h("tbody", null, rows.map(([k, v]) => h("tr", null, h("th", { scope: "row" }, k), h("td", null, v === "" || v === null || v === undefined ? "—" : v)))));
}

function table(head: string[], rows: Node[][], cls = "data"): Html {
  if (rows.length === 0) return h("p", { class: "muted" }, "None.");
  return h("table", { class: cls }, h("thead", null, h("tr", null, head.map((c) => h("th", { scope: "col" }, c)))), h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", null, c))))));
}

const sev = (s: string) => h("span", { class: `sev sev-${s === "error" || s === "warn" ? s : "info"}` }, s === "error" ? "✖ " : s === "warn" ? "▲ " : "ℹ ", s);

// ------------------------------------------------------------------- styles

export const REPORT_CSS = `
:root{color-scheme:light;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6d68;--line:#e1e0d9;--axis:#c3c2b7;--bg:#fcfcfb;--wash:#f0efec;--accent:#1c5cab;--warn:#fab219;--crit:#d03b3b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 28px 60px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:34px 0 10px;padding-top:8px;border-top:1px solid var(--axis)}
h3{font-size:14px;margin:18px 0 6px}
a{color:var(--accent)}a.id,code,.mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:12px}
.meta{color:var(--ink2);margin:0 0 14px}
.note{border:1px solid var(--line);border-left:4px solid var(--axis);background:#fff;padding:10px 14px;border-radius:6px;color:var(--ink2)}
.caveat{border-left-color:var(--accent)}
.muted{color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:6px 0 12px}
table.data th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--axis);padding:5px 8px;white-space:nowrap}
table.data td{border-bottom:1px solid var(--line);padding:5px 8px;vertical-align:top;overflow-wrap:anywhere}
table.kv{width:auto}table.kv th{text-align:left;font-weight:500;color:var(--muted);padding:3px 18px 3px 0;vertical-align:top}table.kv td{padding:3px 0}
.sev{font-weight:600;white-space:nowrap}.sev-warn{color:#8a5a00}.sev-error{color:var(--crit)}
.finding{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0;background:#fff}
.finding h3{margin:0 0 4px}
.toc ol{columns:2;margin:6px 0}
.chips span{display:inline-block;background:var(--wash);border-radius:5px;padding:1px 7px;margin:0 4px 4px 0;font-size:12px}
tr:target,article:target{outline:2px solid var(--accent);outline-offset:1px}
footer{margin-top:40px;color:var(--muted);font-size:12px}
@page{size:A4;margin:14mm 12mm}
body.print{background:#fff;font-size:11px}
body.print main{max-width:none;padding:0}
body.print h2{break-before:page;border-top:none}
body.print #sec-executive_summary h2{break-before:auto}
body.print table.data th,body.print table.data td{padding:3px 5px}
body.print thead{display:table-header-group}
body.print tr,body.print .finding{break-inside:avoid}
body.print a{color:inherit;text-decoration:none}
body.print .toc{break-after:page}
@media print{body{background:#fff}a{color:inherit;text-decoration:none}thead{display:table-header-group}tr,.finding{break-inside:avoid}}
`.trim();

export const REPORT_STYLE_HASH = `sha256-${createHash("sha256").update(REPORT_CSS).digest("base64")}`;
/** CSP for report documents: no scripts, no external loads, only this stylesheet. */
export const REPORT_CSP = `default-src 'none'; style-src '${REPORT_STYLE_HASH}'; img-src data:; base-uri 'none'; form-action 'none'`;

// ------------------------------------------------------------------ sections

function section(key: ReportSectionKey, n: number, ...body: Node[]): Html {
  const title = REPORT_SECTIONS.find(([k]) => k === key)?.[1] ?? key;
  return h("section", { id: `sec-${key}` }, h("h2", null, `${n}. ${title}`), ...body);
}

function evidenceTable(items: readonly EvidenceItem[]): Html {
  return table(
    ["Role", "Event id", "Seq", "Time (UTC)", "Kind", "Action", "Workflow", "Summary"],
    items.map((i) => [i.role === "trigger" ? h("strong", null, "trigger") : "context", evLink(i.event_id), i.seq, iso(i.timestamp), i.kind, i.action, i.workflow, i.summary]),
  );
}

function findingCard(f: Finding): Html {
  return h(
    "article",
    { class: "finding", id: anchor("f", f.finding_id) },
    h("h3", null, sev(f.severity), " ", f.title),
    kv([
      ["Finding id", h("code", null, f.finding_id)],
      ["Rule", h("code", null, `${f.rule_id} (${f.category})`)],
      ["Workflow", f.workflow],
      ["Time range (UTC)", `${iso(f.timestamp_range.start)} → ${iso(f.timestamp_range.end)}`],
      ["Confidence", `${pct(f.confidence)} — how clearly the pattern is present in the recorded data, not a probability of any platform outcome`],
      ["Frequency", `${f.frequency} match(es) of this rule in the session`],
      ["Produced by events", h("span", null, f.event_ids.map((id, i) => [i > 0 ? ", " : "", evLink(id)]))],
    ]),
    h("p", null, f.description),
    h("p", { class: "muted" }, h("strong", null, "Possible explanation: "), f.possible_explanation),
  );
}

export function reportHtml(r: ForensicReport, opts: { print?: boolean } = {}): string {
  const s = r.executive_summary;
  const env = r.environment;
  const cmp = r.comparative_analysis;
  const c = cmp.comparison;
  const sizeText = (v: { width: number; height: number } | undefined) => (v ? `${v.width} × ${v.height}` : "");
  const t0 = r.session.started_at;

  const body = h(
    "main",
    null,
    h("h1", null, `Forensic report — session ${r.session.session_id}`),
    h("p", { class: "meta" }, `Generated ${iso(r.generated_at)} · report v${r.report_version} · lab ${r.generator.lab_version} · rules ${r.generator.rules_version} · findings ${r.findings_source} (analysed ${iso(r.analyzed_at)})`),
    h("p", { class: "note" }, h("strong", null, "Diagnostic observations only. "), r.disclaimer),
    h("nav", { class: "toc" }, h("strong", null, "Contents"), h("ol", null, REPORT_SECTIONS.map(([k, t]) => h("li", null, h("a", { href: `#sec-${k}` }, t))))),

    section(
      "executive_summary",
      1,
      h("ul", null, s.statements.map((x) => h("li", null, x))),
      kv([
        ["Duration", fmtMs(s.duration_ms)],
        ["Events", s.event_count],
        ["Workflows visited", s.workflows_visited.join(", ")],
        ["Findings", `${s.findings_total} (error ${s.findings_by_severity.error ?? 0} · warn ${s.findings_by_severity.warn ?? 0} · info ${s.findings_by_severity.info ?? 0})`],
      ]),
      h("h3", null, "Key findings"),
      table(
        ["Severity", "Finding", "Confidence", "Event ids"],
        s.key_findings.map((k) => [sev(k.severity), fLink(k.finding_id, k.title), pct(k.confidence), h("span", null, k.event_ids.map((id, i) => [i > 0 ? ", " : "", evLink(id)]))]),
      ),
    ),

    section(
      "session",
      2,
      kv([
        ["Session id", h("code", null, r.session.session_id)],
        ["Started (UTC)", iso(r.session.started_at)],
        ["Ended (UTC)", r.session.ended_at === null ? "not terminated" : iso(r.session.ended_at)],
        ["Mode", r.session.mode],
        ["Target", `${r.session.target.kind}${r.session.target.host ? ` · ${r.session.target.host}` : ""}`],
        ["Events", r.session.event_count],
        ["Tabs", r.session.tabs.join(", ")],
        ["Scope", r.scope.statement],
      ]),
    ),

    section(
      "environment",
      3,
      env.captured
        ? kv([
            ["Browser", env.browser ? `${env.browser} ${env.browser_major ?? ""}`.trim() : ""],
            ["Platform", env.platform ?? ""],
            ["Language", env.language ?? ""],
            ["Timezone", env.timezone ? `${env.timezone} (offset ${env.timezone_offset_min ?? "?"} min)` : ""],
            ["Viewport", sizeText(env.viewport)],
            ["Screen", sizeText(env.screen)],
            ["Pixel ratio", env.device_pixel_ratio ?? ""],
            ["Colour scheme", env.color_scheme ?? ""],
            ["Hardware threads", env.hardware_concurrency ?? ""],
            ["Extension", env.extension_version ?? ""],
            ["Source events", h("span", null, env.source_event_ids.map((id, i) => [i > 0 ? ", " : "", evLink(id)]))],
          ])
        : h("p", { class: "muted" }, "No environment facts were recorded for this session."),
      h("p", { class: "muted" }, "Recorded facts only; nothing is inferred, randomised or altered."),
    ),

    section(
      "timeline",
      4,
      r.timeline.truncated
        ? h("p", { class: "note" }, `${r.timeline.included_events} of ${r.timeline.total_events} events are listed: the first events in order plus every event a finding cites. The JSON and CSV exports carry the same rows.`)
        : null,
      h(
        "table",
        { class: "data" },
        h("thead", null, h("tr", null, ["Seq", "Time (UTC)", "+", "Tab", "Kind", "Workflow", "Severity", "Summary", "Event id", "Cited by"].map((x) => h("th", { scope: "col" }, x)))),
        h(
          "tbody",
          null,
          r.timeline.events.map((e) =>
            h(
              "tr",
              { id: anchor("ev", e.event_id) },
              h("td", null, e.seq),
              h("td", null, iso(e.timestamp)),
              h("td", null, fmtMs(e.timestamp - t0)),
              h("td", null, e.tab_id ?? "—"),
              h("td", null, e.kind),
              h("td", null, e.workflow),
              h("td", null, sev(e.severity)),
              h("td", { class: "mono" }, e.summary),
              h("td", null, h("code", null, e.event_id)),
              h("td", null, e.cited_by.map((id, i) => [i > 0 ? ", " : "", fLink(id)])),
            ),
          ),
        ),
      ),
    ),

    section(
      "workflow",
      5,
      h("p", { class: "chips" }, r.workflow.sequence.length ? r.workflow.sequence.map((w, i) => [i > 0 ? " → " : "", h("span", null, w)]) : "No workflow detected."),
      h("h3", null, "Segments"),
      table(
        ["Workflow", "Tab", "Start (UTC)", "Duration", "Events", "Seq", "First event"],
        r.workflow.segments.map((g) => [g.workflow, g.tab_id ?? "—", iso(g.start_ts), fmtMs(g.duration_ms), g.event_count, `#${g.first_seq}–#${g.last_seq}`, g.event_ids[0] ? evLink(g.event_ids[0]) : ""]),
      ),
      h("h3", null, "Transitions"),
      table(["From", "To", "Count", "Avg. time before", "Transition events"], r.workflow.transitions.map((e) => [e.from, e.to, e.count, fmtMs(e.avg_ms), h("span", null, e.samples.map((x, i) => [i > 0 ? ", " : "", evLink(x.event_id)]))])),
      h("h3", null, "Timing"),
      kv([
        ["Events per minute", r.workflow.timing.events_per_minute],
        ["Median gap", fmtMs(r.workflow.timing.inter_event_gap_ms.p50)],
        ["90th percentile gap", fmtMs(r.workflow.timing.inter_event_gap_ms.p90)],
        ["Longest gap", fmtMs(r.workflow.timing.inter_event_gap_ms.max)],
      ]),
      table(["Pause", "Before", "After"], r.workflow.timing.longest_gaps.map((g) => [fmtMs(g.ms), evLink(g.before_event_id), evLink(g.after_event_id)])),
    ),

    section(
      "observed_sequences",
      6,
      h("h3", null, "Workflow sequence"),
      h("p", { class: "chips" }, r.observed_sequences.workflow_sequence.map((w, i) => [i > 0 ? " → " : "", h("span", null, w)])),
      h("h3", null, "Repeated operator action sequences"),
      table(
        ["Sequence", "Times", "Occurrences (event ids)"],
        r.observed_sequences.repeated_sequences.map((q) => [h("code", null, q.tokens.join(" → ")), q.count, h("span", null, q.occurrences.map((occ, i) => [i > 0 ? new Html("<br>") : "", occ.map((id, j) => [j > 0 ? " " : "", evLink(id)])]))]),
      ),
    ),

    section("findings", 7, r.findings.length ? r.findings.map(findingCard) : h("p", { class: "muted" }, "No findings.")),

    section(
      "evidence",
      8,
      r.evidence.length
        ? r.evidence.map((ev) => [h("h3", null, fLink(ev.finding_id, `${ev.rule_id} · ${ev.finding_id}`)), h("p", { class: "muted" }, `Triggering events: ${ev.event_ids.join(", ")}`), evidenceTable(ev.items)])
        : h("p", { class: "muted" }, "No findings, so no evidence."),
    ),

    section(
      "counter_evidence",
      9,
      r.counter_evidence.length
        ? r.counter_evidence.map((ce) => [h("h3", null, fLink(ce.finding_id)), h("ul", null, ce.items.filter((x) => x !== PLATFORM_CAVEAT).map((x) => h("li", null, x)))])
        : h("p", { class: "muted" }, "No findings."),
      h("p", { class: "note caveat" }, PLATFORM_CAVEAT),
    ),

    section(
      "comparative_analysis",
      10,
      h("ul", null, cmp.notes.map((x) => h("li", null, x))),
      c
        ? [
            kv([
              ["Baseline session", h("code", null, c.b)],
              ["Similarity", `${pct(c.similarity)} (workflow order 60% · operator actions 40%)`],
              ["Workflow sequence (this)", c.workflow_sequence.a.join(" → ")],
              ["Workflow sequence (baseline)", c.workflow_sequence.b.join(" → ")],
              ["In both, in order", c.workflow_sequence.common.join(" → ")],
              ["Only in this session", c.workflow_sequence.only_a.join(", ")],
              ["Only in baseline", c.workflow_sequence.only_b.join(", ")],
              ["Events", `${c.counts.a_events} vs ${c.counts.b_events}`],
              ["Error events", `${c.counts.a_errors} vs ${c.counts.b_errors}`],
              ["Median gap", `${fmtMs(c.timing.a_median_gap_ms)} vs ${fmtMs(c.timing.b_median_gap_ms)}`],
              ["Shared operator actions", pct(c.actions.jaccard)],
            ]),
            h("h3", null, "Time per workflow"),
            table(["Workflow", "This session", "Baseline", "Δ (baseline − this)", "Ratio"], c.workflows.map((w) => [w.workflow, fmtMs(w.a_ms), fmtMs(w.b_ms), fmtMs(w.delta_ms), w.ratio === null ? "—" : `${w.ratio}×`])),
            h("h3", null, "Environment differences"),
            table(["Field", "This session", "Baseline"], c.environment_differences.map((d) => [d.field, JSON.stringify(d.a), JSON.stringify(d.b)])),
            c.notes.length ? h("ul", null, c.notes.map((x) => h("li", null, x))) : null,
          ]
        : null,
      h("h3", null, `Cohort (${cmp.cohort.size} session(s) analysed together)`),
      table(["Rule", "Sessions where it matched", "Cohort size"], cmp.rule_prevalence.map((p) => [h("code", null, p.rule_id), p.sessions_with, p.cohort_size])),
    ),

    section(
      "recommended_next_tests",
      11,
      r.recommended_next_tests.length
        ? h("ol", null, r.recommended_next_tests.map((t) => h("li", null, t.test, h("div", { class: "muted" }, "For: ", t.finding_ids.map((id, i) => [i > 0 ? ", " : "", fLink(id)])))))
        : h("p", { class: "muted" }, "No findings, so no follow-up test is suggested."),
    ),

    h("footer", null, `Integrity: ${r.integrity.algorithm} ${r.integrity.digest} over the JSON report without its integrity field. Generated locally by the diagnostics lab.`),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(REPORT_CSP)}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Forensic report — ${r.session.session_id}`)}</title>
<style>${REPORT_CSS}</style>
</head>
<body${opts.print ? ' class="print"' : ""}>
${body.value}
</body>
</html>
`;
}
