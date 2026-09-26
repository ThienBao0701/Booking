/** Sessions: filterable list with selection for comparison; per-session analysis detail. */

import type { AnalysisResult, Finding } from "../shared.ts";
import type { Ctx, PageRender } from "../context.ts";
import { type Child, h, mount } from "../dom.ts";
import { fmtDuration, fmtInt, fmtPct, fmtTime, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { filterBar } from "../components/filters.ts";
import { pager, table } from "../components/table.ts";
import { button, card, chip, disclaimer, empty, errorBox, kv, link, pageHeader, severityBadge, workflowChip, statusBadge } from "../components/ui.ts";

const PAGE = 50;

export const renderSessions: PageRender = async (ctx, main) => {
  if (ctx.route.id) return renderDetail(ctx, main, ctx.route.id);
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const offset = Number(p.offset ?? 0) || 0;
  const res = await ctx.api.sessions({ from, to, q: p.q, workflow: p.workflow, limit: PAGE, offset });
  if (!ctx.alive()) return;
  const selected = new Set<string>();
  const compareBtn = h("button", { type: "button", class: "btn btn-primary", disabled: true }, "Compare selected (0/2)") as HTMLButtonElement;
  const refresh = () => {
    compareBtn.disabled = selected.size !== 2;
    compareBtn.textContent = `Compare selected (${selected.size}/2)`;
  };
  compareBtn.addEventListener("click", () => {
    const [a, b] = [...selected];
    if (a && b) ctx.go("compare", { a, b });
  });
  mount(
    main,
    pageHeader("Sessions", `${fmtInt(res.total)} recorded session(s). Select two to compare.`, compareBtn),
    filterBar({ params: p, show: ["range", "workflow", "q"], onChange: ctx.setParams }),
    res.sessions.length === 0
      ? empty("No sessions match these filters.")
      : table(
          res.sessions,
          [
            {
              title: "",
              cell: (r) => {
                const cb = h("input", { type: "checkbox", "aria-label": `Select ${r.id} for comparison` }) as HTMLInputElement;
                cb.addEventListener("change", () => {
                  if (cb.checked) selected.add(r.id);
                  else selected.delete(r.id);
                  refresh();
                });
                return cb;
              },
            },
            { title: "Session", cell: (r) => link(buildHash("sessions", {}, r.id), shortId(r.id, 14)) },
            { title: "Started", cell: (r) => fmtTime(r.startedAt) },
            { title: "Duration", cell: (r) => (r.endedAt !== null ? fmtDuration(r.endedAt - r.startedAt) : chip("open")), cls: "num" },
            { title: "Mode", cell: (r) => r.mode },
            { title: "Target", cell: (r) => `${r.targetKind}${r.targetHost ? ` · ${r.targetHost}` : ""}` },
            { title: "Events", cell: (r) => fmtInt(r.eventCount), cls: "num" },
            { title: "Errors", cell: (r) => (r.errorCount ? severityBadge("error") : "0"), cls: "num" },
            { title: "Findings", cell: (r) => fmtInt(r.findingCount), cls: "num" },
          ],
          { onRow: (r) => ctx.go("sessions", {}, r.id), rowLabel: (r) => `Open session ${r.id}` },
        ),
    pager(res.total, offset, PAGE, (o) => ctx.setParams({ ...p, offset: String(o) })),
  );
};

function sequence(seq: readonly string[]): HTMLElement {
  if (seq.length === 0) return h("span", { class: "muted" }, "No workflow detected.");
  return h("div", { class: "sequence" }, ...seq.flatMap((w, i) => [i > 0 ? h("span", { class: "arrow", "aria-hidden": "true" }, "→") : null, workflowChip(w)]));
}

export function findingsTable(ctx: Ctx, findings: readonly Finding[], persisted: boolean): HTMLElement {
  if (findings.length === 0) return empty("No findings for this session.");
  return table(
    findings,
    [
      { title: "Severity", cell: (f) => severityBadge(f.severity) },
      { title: "Finding", cell: (f) => (persisted ? link(buildHash("findings", {}, f.finding_id), f.title) : f.title) },
      { title: "Rule", cell: (f) => h("code", null, f.rule_id) },
      { title: "Workflow", cell: (f) => workflowChip(f.workflow) },
      { title: "When", cell: (f) => fmtTime(f.timestamp_range.start) },
      { title: "Confidence", cell: (f) => fmtPct(f.confidence), cls: "num" },
      { title: "Events", cell: (f) => fmtInt(f.event_ids.length), cls: "num" },
    ],
    persisted ? { onRow: (f) => ctx.go("findings", {}, f.finding_id), rowLabel: (f) => `Open finding ${f.title}` } : {},
  );
}

async function renderDetail(ctx: Ctx, main: HTMLElement, id: string): Promise<void> {
  const [info, analysis, stored, provenance] = await Promise.all([ctx.api.session(id), ctx.api.analysis(id), ctx.api.findings({ session: id, limit: 500 }), ctx.api.analysisStatus([id])]);
  const prov = provenance.sessions[0];
  if (!ctx.alive()) return;
  const a: AnalysisResult = analysis;
  const s = info.session;
  const status = h("span", { class: "muted", role: "status" });
  const rerun = button("Re-run analysis", () => {
    mount(status, "Analysing…");
    void ctx.api
      .runAnalysis([id])
      .then((r) => {
        mount(status, `${r.findings} finding(s) stored.`);
        ctx.setParams({ ...ctx.route.params, t: String(Date.now()) });
      })
      .catch((err) => mount(status, errorBox(err)));
  });
  const compareWith = h("select", { "aria-label": "Compare with session" }, h("option", { value: "" }, "Compare with…")) as HTMLSelectElement;
  void ctx.recentSessions().then((ids) => {
    for (const other of ids.filter((x) => x !== id)) compareWith.appendChild(h("option", { value: other }, shortId(other, 14)));
  });
  compareWith.addEventListener("change", () => {
    if (compareWith.value) ctx.go("compare", { a: id, b: compareWith.value });
  });
  const env = a.environment;
  const dq = a.data_quality;
  const t = a.timing;
  const children: Child[] = [
    pageHeader(`Session ${shortId(id, 16)}`, h("code", null, id), link(buildHash("timeline", { session: id }), "Timeline"), link(buildHash("events", { session: id }), "Events"), link(buildHash("reports", { session: id }), "Report"), compareWith, rerun),
    status,
    h(
      "div",
      { class: "grid-2" },
      card("Summary", kv([
        ["Started", fmtTime(s.startedAt)],
        ["Ended", s.endedAt ? fmtTime(s.endedAt) : chip("open")],
        ["Duration", fmtDuration(t.session_duration_ms)],
        ["Mode", s.mode],
        ["Target", `${s.target.kind}${s.target.host ? ` · ${s.target.host}` : ""}`],
        ["Events", fmtInt(a.event_count)],
        ["Events / minute", String(t.events_per_minute)],
        ["Analysed with", `${a.cohort_session_ids.length} session(s) · rules ${a.rules_version}`],
        [
          "Stored findings",
          prov?.analyzed_at
            ? h("span", { id: "session-provenance" }, statusBadge(prov.state), ` analysed ${fmtTime(prov.analyzed_at)} · rules ${prov.rules_version ?? "?"}${prov.reasons.length ? ` · ${prov.reasons.join(", ").replace(/_/g, " ")} — use “Re-run analysis”` : ""}`)
            : h("span", { id: "session-provenance" }, statusBadge(prov?.state ?? "not_analyzed"), prov?.state === "stale" ? " no analysis record — use “Re-run analysis”" : " not analysed yet"),
        ],
      ])),
      card("Data quality", kv([
        ["Quarantined events", fmtInt(dq.quarantined)],
        ["Sequence gaps", fmtInt(dq.seq_gaps)],
        ["Timestamp regressions", fmtInt(dq.ts_regressions)],
        ["Session terminated", dq.terminated ? "yes" : "no"],
        ["Analyzer warnings", a.warnings.length ? a.warnings.join("; ") : "none"],
      ])),
    ),
    card("Workflow sequence", sequence(a.workflow_sequence)),
    h(
      "div",
      { class: "grid-2" },
      card("Timing", kv([
        ["Median gap", fmtDuration(t.inter_event_gap_ms.p50)],
        ["90th percentile gap", fmtDuration(t.inter_event_gap_ms.p90)],
        ["Longest gap", fmtDuration(t.inter_event_gap_ms.max)],
      ]), h("h3", null, "Longest pauses"), table(t.longest_gaps, [
        { title: "Pause", cell: (g) => fmtDuration(g.ms), cls: "num" },
        { title: "Before", cell: (g) => h("button", { type: "button", class: "linklike", on: { click: () => ctx.openEvent(g.before_event_id) } }, shortId(g.before_event_id)) },
        { title: "After", cell: (g) => h("button", { type: "button", class: "linklike", on: { click: () => ctx.openEvent(g.after_event_id) } }, shortId(g.after_event_id)) },
      ])),
      card("Environment", env.captured ? kv([
        ["Browser", env.browser ? `${env.browser} ${env.browser_major ?? ""}` : "—"],
        ["Platform", env.platform ?? "—"],
        ["Language", env.language ?? "—"],
        ["Timezone", env.timezone ? `${env.timezone} (UTC${(env.timezone_offset_min ?? 0) >= 0 ? "+" : "−"}${Math.abs((env.timezone_offset_min ?? 0) / 60)})` : "—"],
        ["Viewport", env.viewport ? `${env.viewport.width} × ${env.viewport.height}` : "—"],
        ["Screen", env.screen ? `${env.screen.width} × ${env.screen.height}` : "—"],
        ["Pixel ratio", env.device_pixel_ratio !== undefined ? String(env.device_pixel_ratio) : "—"],
        ["Extension", env.extension_version ?? "—"],
      ]) : empty("No environment facts were recorded for this session.")),
    ),
    card("Workflow segments", table(a.segments, [
      { title: "Workflow", cell: (sg) => workflowChip(sg.workflow) },
      { title: "Tab", cell: (sg) => (sg.tab_id === null ? "—" : String(sg.tab_id)), cls: "num" },
      { title: "Start", cell: (sg) => fmtTime(sg.start_ts) },
      { title: "Duration", cell: (sg) => fmtDuration(sg.duration_ms), cls: "num" },
      { title: "Events", cell: (sg) => fmtInt(sg.event_count), cls: "num" },
      { title: "Seq", cell: (sg) => `#${sg.first_seq}–#${sg.last_seq}`, cls: "num" },
    ])),
    card("Repeated operator sequences", a.repeated_sequences.length === 0 ? empty("No repeated sequence of two or more actions.") : table(a.repeated_sequences.slice(0, 20), [
      { title: "Sequence", cell: (r) => h("code", null, r.tokens.join(" → ")) },
      { title: "Times", cell: (r) => fmtInt(r.count), cls: "num" },
      { title: "First occurrence", cell: (r) => h("button", { type: "button", class: "linklike", on: { click: () => ctx.openEvent(r.occurrences[0]?.[0] ?? "") } }, "open event") },
    ])),
    card(
      stored.total > 0 ? `Findings (${stored.total}, stored)` : `Findings (${a.findings.length}, not yet stored — use “Re-run analysis”)`,
      findingsTable(ctx, stored.total > 0 ? stored.findings : a.findings, stored.total > 0),
    ),
    disclaimer(),
  ];
  mount(main, ...children);
}
