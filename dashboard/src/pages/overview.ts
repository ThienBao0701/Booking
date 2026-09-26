/** Overview: headline counts, activity per day, findings by severity, top kinds / workflows, recent items. */

import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { fmtCompact, fmtDuration, fmtInt, fmtTime, label, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { fillDays, ranked } from "../data.ts";
import { barList, columnChart } from "../components/charts.ts";
import { filterBar } from "../components/filters.ts";
import { table } from "../components/table.ts";
import { card, disclaimer, link, pageHeader, severityBadge, statTile, workflowChip } from "../components/ui.ts";

export const renderOverview: PageRender = async (ctx, main) => {
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const range = { range: p.range, from: p.from, to: p.to };
  const [stats, recent, top] = await Promise.all([
    ctx.api.stats({ from, to, tz: -new Date().getTimezoneOffset() }),
    ctx.api.sessions({ from, to, limit: 6 }),
    ctx.api.findings({ from, to, limit: 6 }),
  ]);
  if (!ctx.alive()) return;

  const sev = ["error", "warn", "info"].map((s) => ({
    label: s,
    icon: s === "error" ? "✖" : s === "warn" ? "▲" : "ℹ",
    value: stats.findings_by_severity[s] ?? 0,
    fill: `fill-sev-${s}`,
    href: buildHash("findings", { ...range, severity: s }),
  }));
  mount(
    main,
    pageHeader("Overview", "Observed, recorded, replayed and analysed activity in this lab."),
    filterBar({ params: p, show: ["range"], onChange: ctx.setParams }),
    h(
      "div",
      { class: "tiles" },
      statTile("Sessions", fmtCompact(stats.sessions), undefined, buildHash("sessions", range)),
      statTile("Events", fmtCompact(stats.events), `${fmtInt(stats.events_by_severity.error ?? 0)} errors`, buildHash("events", range)),
      statTile("Findings", fmtCompact(stats.findings), `${fmtInt(stats.findings_by_severity.warn ?? 0)} warn · ${fmtInt(stats.findings_by_severity.error ?? 0)} error`, buildHash("findings", range)),
      statTile("Replay runs", fmtCompact(stats.runs), `${fmtInt(stats.runs_by_status.completed ?? 0)} completed`, buildHash("runs")),
    ),
    h(
      "div",
      { class: "grid-2" },
      card("Events per day", columnChart(fillDays(stats.events_by_day).map((d) => ({ label: d.day.slice(5), value: d.count })), { title: "Events per day", unit: "events" })),
      card("Findings by severity", barList(sev, { title: "Findings by severity", unit: "findings" })),
      card("Events by kind", barList(ranked(stats.events_by_kind).map(([k, v]) => ({ label: label(k), value: v, href: buildHash("events", { ...range, kind: k }) })), { title: "Events by kind", unit: "events" })),
      card("Events by workflow", barList(ranked(stats.events_by_workflow).map(([k, v]) => ({ label: label(k), value: v, href: buildHash("events", { ...range, workflow: k }) })), { title: "Events by workflow", unit: "events" })),
    ),
    h(
      "div",
      { class: "grid-2" },
      card(
        "Recent sessions",
        table(recent.sessions, [
          { title: "Session", cell: (r) => link(buildHash("sessions", {}, r.id), shortId(r.id)) },
          { title: "Started", cell: (r) => fmtTime(r.startedAt) },
          { title: "Duration", cell: (r) => (r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "open"), cls: "num" },
          { title: "Events", cell: (r) => fmtInt(r.eventCount), cls: "num" },
          { title: "Findings", cell: (r) => fmtInt(r.findingCount), cls: "num" },
        ], { onRow: (r) => ctx.go("sessions", {}, r.id), rowLabel: (r) => `Open session ${r.id}` }),
      ),
      card(
        "Highest-severity findings",
        table(top.findings, [
          { title: "Severity", cell: (f) => severityBadge(f.severity) },
          { title: "Finding", cell: (f) => link(buildHash("findings", {}, f.finding_id), f.title) },
          { title: "Workflow", cell: (f) => workflowChip(f.workflow) },
          { title: "When", cell: (f) => fmtTime(f.timestamp_range.start) },
        ], { onRow: (f) => ctx.go("findings", {}, f.finding_id), rowLabel: (f) => `Open finding ${f.title}` }),
      ),
    ),
    disclaimer(),
  );
};
