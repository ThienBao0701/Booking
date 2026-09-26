/** Session comparison: similarity, sequences, per-workflow time (paired bars + table), actions, environment. */

import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { fmtDuration, fmtInt, fmtPct, label, shortId } from "../format.ts";
import { buildHash } from "../route.ts";
import { pairedBars } from "../components/charts.ts";
import { table } from "../components/table.ts";
import { card, empty, kv, link, pageHeader, workflowChip } from "../components/ui.ts";

function picker(ids: string[], value: string | undefined, name: string, onPick: (v: string) => void): HTMLElement {
  const sel = h("select", { name, "aria-label": `Session ${name.toUpperCase()}` }, h("option", { value: "" }, `Session ${name.toUpperCase()}…`), ...ids.map((id) => h("option", { value: id, selected: id === value }, shortId(id, 14)))) as HTMLSelectElement;
  sel.addEventListener("change", () => onPick(sel.value));
  return h("label", { class: "filter" }, h("span", { class: "filter-label" }, `Session ${name.toUpperCase()}`), sel);
}

export const renderCompare: PageRender = async (ctx, main) => {
  const p = ctx.route.params;
  const ids = await ctx.recentSessions();
  if (!ctx.alive()) return;
  const bar = h("div", { class: "filter-bar" }, picker(ids, p.a, "a", (v) => ctx.setParams({ ...p, a: v })), picker(ids, p.b, "b", (v) => ctx.setParams({ ...p, b: v })));
  if (!p.a || !p.b) {
    mount(main, pageHeader("Compare sessions", "Pick two sessions."), bar, empty("Select session A and session B."));
    return;
  }
  const c = await ctx.api.compare(p.a, p.b);
  if (!ctx.alive()) return;
  const A = `A · ${shortId(c.a, 8)}`;
  const B = `B · ${shortId(c.b, 8)}`;
  mount(
    main,
    pageHeader("Compare sessions", h("span", null, link(buildHash("sessions", {}, c.a), c.a), " vs ", link(buildHash("sessions", {}, c.b), c.b))),
    bar,
    h(
      "div",
      { class: "hero-row" },
      h("div", { class: "hero" }, h("div", { class: "hero-value" }, fmtPct(c.similarity)), h("div", { class: "hero-label" }, "similarity (workflow order 60% · operator actions 40%)")),
      c.notes.length ? h("ul", { class: "notes" }, ...c.notes.map((n) => h("li", null, n))) : null,
    ),
    card(
      "Workflow sequence",
      kv([
        [A, h("div", { class: "sequence" }, ...c.workflow_sequence.a.map((w) => workflowChip(w)))],
        [B, h("div", { class: "sequence" }, ...c.workflow_sequence.b.map((w) => workflowChip(w)))],
        ["In both, in order", h("div", { class: "sequence" }, ...c.workflow_sequence.common.map((w) => workflowChip(w)))],
        ["Only in A", c.workflow_sequence.only_a.map(label).join(", ") || "—"],
        ["Only in B", c.workflow_sequence.only_b.map(label).join(", ") || "—"],
      ]),
    ),
    card(
      "Time per workflow",
      pairedBars(c.workflows.map((w) => ({ label: label(w.workflow), a: w.a_ms, b: w.b_ms })), [A, B], fmtDuration, "Time per workflow, session A vs B"),
      table(c.workflows, [
        { title: "Workflow", cell: (w) => workflowChip(w.workflow) },
        { title: A, cell: (w) => fmtDuration(w.a_ms), cls: "num" },
        { title: B, cell: (w) => fmtDuration(w.b_ms), cls: "num" },
        { title: "Δ (B − A)", cell: (w) => fmtDuration(w.delta_ms), cls: "num" },
        { title: "Ratio", cell: (w) => (w.ratio === null ? "—" : `${w.ratio}×`), cls: "num" },
      ]),
    ),
    h(
      "div",
      { class: "grid-2" },
      card("Counts & timing", kv([
        ["Events", `${fmtInt(c.counts.a_events)} vs ${fmtInt(c.counts.b_events)}`],
        ["Error events", `${fmtInt(c.counts.a_errors)} vs ${fmtInt(c.counts.b_errors)}`],
        ["Median gap", `${fmtDuration(c.timing.a_median_gap_ms)} vs ${fmtDuration(c.timing.b_median_gap_ms)}`],
        ["Shared operator actions (Jaccard)", fmtPct(c.actions.jaccard)],
      ])),
      card("Environment differences", c.environment_differences.length === 0 ? empty("No recorded environment difference.") : table(c.environment_differences, [
        { title: "Field", cell: (d) => d.field },
        { title: A, cell: (d) => JSON.stringify(d.a) },
        { title: B, cell: (d) => JSON.stringify(d.b) },
      ])),
    ),
    h(
      "div",
      { class: "grid-2" },
      card("Actions only in A", c.actions.only_a.length ? h("ul", { class: "plain mono" }, ...c.actions.only_a.map((t) => h("li", null, t))) : empty("None.")),
      card("Actions only in B", c.actions.only_b.length ? h("ul", { class: "plain mono" }, ...c.actions.only_b.map((t) => h("li", null, t))) : empty("None.")),
    ),
  );
};
