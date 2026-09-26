/** Workflow graph across sessions (arc diagram) with node / transition tables and sample events. */

import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { fmtDuration, fmtInt, label, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { filterBar } from "../components/filters.ts";
import { workflowGraphView } from "../components/graph.ts";
import { table } from "../components/table.ts";
import { card, empty, link, pageHeader, workflowChip } from "../components/ui.ts";

export const renderWorkflows: PageRender = async (ctx, main) => {
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const [ids, list] = await Promise.all([ctx.recentSessions(), p.session ? Promise.resolve(undefined) : ctx.api.sessions({ from, to, workflow: p.workflow, limit: 200 })]);
  const sessionIds = p.session ? [p.session] : (list?.sessions ?? []).map((s) => s.id);
  if (!ctx.alive()) return;
  const bar = filterBar({ params: p, show: ["range", "session", "workflow"], sessions: ids, onChange: ctx.setParams });
  if (sessionIds.length === 0) {
    mount(main, pageHeader("Workflows", "Transitions between workflows."), bar, empty("No sessions in this selection."));
    return;
  }
  const graph = await ctx.api.graph(sessionIds);
  if (!ctx.alive()) return;
  const selected = p.edge ? graph.edges.find((e) => `${e.from}>${e.to}` === p.edge) : undefined;
  const range = { range: p.range, from: p.from, to: p.to };
  mount(
    main,
    pageHeader("Workflows", `${fmtInt(graph.session_ids.length)} session(s) · ${graph.nodes.length} workflows · ${graph.edges.length} distinct transitions`),
    bar,
    card(
      "Workflow graph",
      h("p", { class: "muted small" }, "Workflows in process order. Arcs above: forward transitions; arcs below: returns to an earlier workflow. Thicker = more frequent. Click an arc for sample events, a workflow for its events."),
      workflowGraphView(
        graph,
        (e) => ctx.setParams({ ...p, edge: `${e.from}>${e.to}` }),
        (id) => ctx.go("events", { ...range, workflow: id, ...(p.session ? { session: p.session } : {}) }),
      ),
    ),
    selected
      ? card(
          `Transition ${label(selected.from)} → ${label(selected.to)}`,
          h("p", null, `${fmtInt(selected.count)} transition(s); on average ${fmtDuration(selected.avg_ms)} spent in ${label(selected.from)} before.`),
          table(selected.samples, [
            { title: "Session", cell: (s) => link(buildHash("sessions", {}, s.session_id), shortId(s.session_id, 12)) },
            { title: "Transition event", cell: (s) => h("button", { type: "button", class: "linklike", on: { click: () => ctx.openEvent(s.event_id) } }, shortId(s.event_id, 12)) },
            { title: "", cell: (s) => link(buildHash("timeline", { session: s.session_id, focus: s.event_id }), "on timeline") },
          ]),
        )
      : null,
    h(
      "div",
      { class: "grid-2" },
      card("Workflows", table(graph.nodes, [
        { title: "Workflow", cell: (n) => workflowChip(n.id) },
        { title: "Sessions", cell: (n) => fmtInt(n.sessions), cls: "num" },
        { title: "Segments", cell: (n) => fmtInt(n.segments), cls: "num" },
        { title: "Total time", cell: (n) => fmtDuration(n.total_ms), cls: "num" },
        { title: "Avg / segment", cell: (n) => fmtDuration(n.segments ? n.total_ms / n.segments : 0), cls: "num" },
      ])),
      card("Transitions", table(graph.edges, [
        { title: "From", cell: (e) => workflowChip(e.from) },
        { title: "To", cell: (e) => workflowChip(e.to) },
        { title: "Count", cell: (e) => fmtInt(e.count), cls: "num" },
        { title: "Avg before", cell: (e) => fmtDuration(e.avg_ms), cls: "num" },
      ], { onRow: (e) => ctx.setParams({ ...p, edge: `${e.from}>${e.to}` }), rowLabel: (e) => `Show samples for ${e.from} to ${e.to}` })),
    ),
  );
};
