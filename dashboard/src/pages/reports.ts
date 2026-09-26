/**
 * Reports: forensic report per session (JSON, CSV ×3, HTML, print-ready HTML).
 * Files are fetched with the token and handed to the browser as downloads;
 * HTML previews open as same-origin blob documents (no scripts, own CSP).
 */

import { REPORT_SECTIONS } from "../shared.ts";
import type { PageRender } from "../context.ts";
import { type Child, h, mount } from "../dom.ts";
import { fmtDuration, fmtInt, fmtPct, fmtTime, shortId } from "../format.ts";
import { buildHash } from "../route.ts";
import { table } from "../components/table.ts";
import { card, disclaimer, empty, errorBox, kv, link, pageHeader, severityBadge } from "../components/ui.ts";
import { saveBlob } from "../components/download.ts";

type Q = Record<string, string | undefined>;

const FILES: Array<{ label: string; q: Q; preview?: boolean }> = [
  { label: "HTML report", q: { format: "html" }, preview: true },
  { label: "Print-ready HTML (save as PDF)", q: { format: "print" }, preview: true },
  { label: "JSON report", q: { format: "json" } },
  { label: "CSV — findings", q: { format: "csv", table: "findings" } },
  { label: "CSV — events", q: { format: "csv", table: "events" } },
  { label: "CSV — evidence", q: { format: "csv", table: "evidence" } },
];

function openBlob(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const renderReports: PageRender = async (ctx, main) => {
  const ids = await ctx.recentSessions();
  if (!ctx.alive()) return;
  const p = ctx.route.params;
  const picker = (name: "session" | "compare", title: string, placeholder: string) => {
    const sel = h(
      "select",
      { name, "aria-label": title },
      h("option", { value: "" }, placeholder),
      ...ids.filter((id) => name === "session" || id !== p.session).map((id) => h("option", { value: id, selected: id === p[name] }, shortId(id, 16))),
    ) as HTMLSelectElement;
    sel.addEventListener("change", () => ctx.setParams({ ...p, [name]: sel.value }));
    return h("label", { class: "filter" }, h("span", { class: "filter-label" }, title), sel);
  };
  const bar = h("div", { class: "filter-bar" }, picker("session", "Session", "Choose a session…"), p.session ? picker("compare", "Compare with", "previous session (automatic)") : null);
  if (!p.session) {
    mount(main, pageHeader("Reports", "Forensic reports per session: JSON, CSV, HTML and print-ready HTML."), bar, empty(ids.length ? "Choose a session." : "No sessions recorded yet."));
    return;
  }
  const r = await ctx.api.report(p.session, p.compare);
  if (!ctx.alive()) return;
  const s = r.executive_summary;
  const status = h("div", { role: "status", "aria-live": "polite", class: "muted small" });
  const q = (extra: Q): Q => ({ ...extra, ...(p.compare ? { compare: p.compare } : {}) });
  const fileRow = (f: (typeof FILES)[number]): Child =>
    h(
      "li",
      { class: "file-row" },
      h("span", { class: "file-label" }, f.label),
      h(
        "button",
        {
          type: "button",
          class: "btn",
          "data-download": `${f.q.format}${f.q.table ? `-${f.q.table}` : ""}`,
          on: {
            click: () => {
              mount(status, "Preparing…");
              void ctx.api
                .reportFile(p.session as string, q({ ...f.q, download: "1" }))
                .then((file) => {
                  saveBlob(file.bytes, file.contentType, file.filename);
                  mount(status, `Saved ${file.filename}.`);
                })
                .catch((err) => mount(status, errorBox(err)));
            },
          },
        },
        "Download",
      ),
      f.preview
        ? h(
            "button",
            {
              type: "button",
              class: "btn btn-ghost",
              "data-preview": f.q.format,
              on: {
                click: () => {
                  void ctx.api
                    .reportFile(p.session as string, q(f.q))
                    .then((file) => openBlob(file.text))
                    .catch((err) => mount(status, errorBox(err)));
                },
              },
            },
            "Preview",
          )
        : null,
    );
  const counts: Record<string, string> = {
    executive_summary: `${s.statements.length} statements · ${s.key_findings.length} key findings`,
    session: `${fmtInt(r.session.event_count)} events · ${r.session.tabs.length} tab(s)`,
    environment: r.environment.captured ? `${r.environment.source_event_ids.length} source event(s)` : "not captured",
    timeline: `${fmtInt(r.timeline.included_events)} of ${fmtInt(r.timeline.total_events)} events${r.timeline.truncated ? " (all cited events included)" : ""}`,
    workflow: `${r.workflow.segments.length} segments · ${r.workflow.transitions.length} transitions`,
    observed_sequences: `${r.observed_sequences.repeated_sequences.length} repeated sequence(s)`,
    findings: `${r.findings.length} finding(s)`,
    evidence: `${r.evidence.reduce((a, e) => a + e.items.length, 0)} evidence item(s)`,
    counter_evidence: `${r.counter_evidence.reduce((a, c) => a + c.items.length, 0)} item(s)`,
    comparative_analysis: r.comparative_analysis.baseline_session_id ? `vs ${shortId(r.comparative_analysis.baseline_session_id, 12)} (${r.comparative_analysis.basis.replace(/_/g, " ")})` : "no baseline",
    recommended_next_tests: `${r.recommended_next_tests.length} test(s)`,
  };
  mount(
    main,
    pageHeader("Reports", h("span", null, "Session ", link(buildHash("sessions", {}, r.session.session_id), r.session.session_id))),
    bar,
    h(
      "div",
      { class: "grid-2" },
      card("Download", h("ul", { class: "plain files" }, ...FILES.map(fileRow)), status, h("p", { class: "muted small" }, "HTML reports are self-contained (no scripts, no external resources). For a PDF, open the print-ready report and use the browser's Print → Save as PDF.")),
      card(
        "Report",
        kv([
          ["Generated", fmtTime(r.generated_at)],
          ["Findings source", r.findings_source === "stored" ? `stored (analysed ${fmtTime(r.analyzed_at)})` : "computed for this report"],
          ["Rules version", h("code", null, r.generator.rules_version)],
          ["Integrity (sha256)", h("code", { class: "small" }, r.integrity.digest)],
          ["Duration", fmtDuration(s.duration_ms)],
          ["Findings", `${s.findings_total} (error ${s.findings_by_severity.error ?? 0} · warn ${s.findings_by_severity.warn ?? 0} · info ${s.findings_by_severity.info ?? 0})`],
        ]),
      ),
    ),
    card("Executive summary", h("ul", null, ...s.statements.map((x) => h("li", null, x)))),
    card(
      "Key findings",
      table(s.key_findings, [
        { title: "Severity", cell: (k) => severityBadge(k.severity) },
        { title: "Finding", cell: (k) => (r.findings_source === "stored" ? link(buildHash("findings", {}, k.finding_id), k.title) : k.title) },
        { title: "Confidence", cell: (k) => fmtPct(k.confidence), cls: "num" },
        { title: "Event ids", cell: (k) => h("span", null, ...k.event_ids.map((id, i) => [i > 0 ? ", " : "", h("button", { type: "button", class: "linklike mono small", on: { click: () => ctx.openEvent(id) } }, id)])) },
      ]),
    ),
    card("Sections", table(REPORT_SECTIONS.map(([key, title], i) => ({ key, title, n: i + 1 })), [
      { title: "#", cell: (x) => String(x.n), cls: "num" },
      { title: "Section", cell: (x) => x.title },
      { title: "Contents", cell: (x) => counts[x.key] ?? "" },
    ])),
    disclaimer(),
  );
};
