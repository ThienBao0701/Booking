/** Findings: filterable list and drill-down to the exact events that produced each finding. */

import { PLATFORM_CAVEAT } from "../shared.ts";
import type { Ctx, PageRender } from "../context.ts";
import { h, jsonBlock, mount } from "../dom.ts";
import { fmtInt, fmtPct, fmtTime, label, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { filterBar } from "../components/filters.ts";
import { pager, table } from "../components/table.ts";
import { card, disclaimer, empty, kv, link, pageHeader, severityBadge, workflowChip } from "../components/ui.ts";

const PAGE = 50;

export const renderFindings: PageRender = async (ctx, main) => {
  if (ctx.route.id) return renderFinding(ctx, main, ctx.route.id);
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const offset = Number(p.offset ?? 0) || 0;
  const [ids, res] = await Promise.all([
    ctx.recentSessions(),
    ctx.api.findings({ session: p.session, workflow: p.workflow, severity: p.severity, category: p.category, rule: p.rule, q: p.q, from, to, limit: PAGE, offset }),
  ]);
  if (!ctx.alive()) return;
  mount(
    main,
    pageHeader("Findings", `${fmtInt(res.total)} finding(s). Each one links to the exact events that produced it.`),
    filterBar({ params: p, show: ["range", "session", "workflow", "severity", "category", "rule", "q"], sessions: ids, onChange: ctx.setParams }),
    disclaimer(),
    res.findings.length === 0
      ? empty("No findings match these filters. Findings are produced when a session ends or via “Re-run analysis”.")
      : table(
          res.findings,
          [
            { title: "Severity", cell: (f) => severityBadge(f.severity) },
            { title: "Finding", cell: (f) => link(buildHash("findings", {}, f.finding_id), f.title) },
            { title: "Rule", cell: (f) => h("code", null, f.rule_id) },
            { title: "Category", cell: (f) => label(f.category) },
            { title: "Workflow", cell: (f) => workflowChip(f.workflow) },
            { title: "Session", cell: (f) => link(buildHash("sessions", {}, f.session_id), shortId(f.session_id, 8)) },
            { title: "When", cell: (f) => fmtTime(f.timestamp_range.start) },
            { title: "Confidence", cell: (f) => fmtPct(f.confidence), cls: "num" },
            { title: "Events", cell: (f) => fmtInt(f.event_ids.length), cls: "num" },
          ],
          { onRow: (f) => ctx.go("findings", {}, f.finding_id), rowLabel: (f) => `Open finding ${f.title}`, caption: "Findings" },
        ),
    pager(res.total, offset, PAGE, (o) => ctx.setParams({ ...p, offset: String(o) })),
  );
};

async function renderFinding(ctx: Ctx, main: HTMLElement, id: string): Promise<void> {
  const d = await ctx.api.finding(id);
  if (!ctx.alive()) return;
  const f = d.finding;
  const stored = new Map(d.events.map((e) => [e.id, e]));
  const counter = f.counter_evidence.filter((c) => c !== PLATFORM_CAVEAT);
  mount(
    main,
    pageHeader(f.title, h("span", null, severityBadge(f.severity), " ", h("code", null, f.rule_id), " · ", label(f.category)), link(buildHash("findings", { rule: f.rule_id }), "Same rule"), link(buildHash("timeline", { session: f.session_id, focus: f.event_ids[0] }), "On timeline")),
    h("p", { class: "lead" }, f.description),
    h(
      "div",
      { class: "grid-2" },
      card("Finding", kv([
        ["Finding id", h("code", null, f.finding_id)],
        ["Session", link(buildHash("sessions", {}, f.session_id), f.session_id)],
        ["Workflow", workflowChip(f.workflow)],
        ["Time range", `${fmtTime(f.timestamp_range.start)} → ${fmtTime(f.timestamp_range.end)}`],
        ["Confidence", h("span", null, fmtPct(f.confidence), h("span", { class: "muted small" }, " — how clearly the pattern is present in the recorded data; not a probability of any platform outcome"))],
        ["Frequency", `${fmtInt(f.frequency)} match(es) of this rule in the session`],
        ["Analysed", fmtTime(f.created_at)],
      ])),
      card("Recommended next test", h("p", { class: "callout" }, f.recommended_next_test), h("h3", null, "Possible explanation"), h("p", null, f.possible_explanation)),
    ),
    card(
      `Evidence — ${f.event_ids.length} triggering event(s)`,
      d.missing_event_ids.length ? h("p", { class: "error-box" }, `Not in the store any more (purged?): ${d.missing_event_ids.join(", ")}`) : null,
      table(
        f.evidence,
        [
          { title: "Role", cell: (e) => (e.role === "trigger" ? h("strong", null, "trigger") : h("span", { class: "muted" }, "context")) },
          { title: "Seq", cell: (e) => `#${e.seq}`, cls: "num" },
          { title: "Time", cell: (e) => fmtTime(e.timestamp) },
          { title: "Kind", cell: (e) => label(e.kind) },
          { title: "Workflow", cell: (e) => workflowChip(e.workflow) },
          { title: "Summary", cell: (e) => h("span", { class: "mono small" }, e.summary) },
          { title: "Event id", cell: (e) => h("button", { type: "button", class: "linklike mono small", disabled: !stored.has(e.event_id) }, e.event_id) },
        ],
        { onRow: (e) => ctx.openEvent(e.event_id), rowLabel: (e) => `Open event ${e.event_id}` },
      ),
    ),
    card(
      "Counter-evidence",
      counter.length ? h("ul", { class: "counter" }, ...counter.map((c) => h("li", null, c))) : null,
      h("p", { class: "caveat", role: "note" }, PLATFORM_CAVEAT),
    ),
    card("Context", jsonBlock(f.context)),
    disclaimer(),
  );
}
