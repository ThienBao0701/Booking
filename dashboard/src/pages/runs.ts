/** Replay runs (read-only): list with step outcomes; detail with steps, checkpoints and the target/authorization record. */

import { RUN_STATUSES } from "../shared.ts";
import type { Ctx, PageRender } from "../context.ts";
import { h, jsonBlock, mount } from "../dom.ts";
import { fmtDuration, fmtInt, fmtTime, shortId } from "../format.ts";
import { buildHash } from "../route.ts";
import { pager, table } from "../components/table.ts";
import { card, empty, kv, link, pageHeader, statusBadge } from "../components/ui.ts";

const PAGE = 50;

export const renderRuns: PageRender = async (ctx, main) => {
  if (ctx.route.id) return renderRun(ctx, main, ctx.route.id);
  const p = ctx.route.params;
  const offset = Number(p.offset ?? 0) || 0;
  const res = await ctx.api.runs({ status: p.status, limit: PAGE, offset });
  if (!ctx.alive()) return;
  const status = h("select", { name: "status", "aria-label": "Run status" }, h("option", { value: "" }, "Any status"), ...RUN_STATUSES.map((s) => h("option", { value: s, selected: s === p.status }, s))) as HTMLSelectElement;
  status.addEventListener("change", () => ctx.setParams({ status: status.value }));
  mount(
    main,
    pageHeader("Replay runs", `${fmtInt(res.total)} run(s). Replays target the local mock unless an operator authorized another system.`),
    h("div", { class: "filter-bar" }, h("label", { class: "filter" }, h("span", { class: "filter-label" }, "Status"), status)),
    res.runs.length === 0
      ? empty("No replay runs recorded. Run `pnpm run replay:example` against the mock.")
      : table(
          res.runs,
          [
            { title: "Run", cell: (r) => link(buildHash("runs", {}, r.runId), shortId(r.runId, 12)) },
            { title: "Workflow", cell: (r) => r.workflow },
            { title: "Status", cell: (r) => statusBadge(r.status) },
            { title: "Mode", cell: (r) => `${r.mode}${r.dryRun ? " · dry run" : ""}` },
            { title: "Target", cell: (r) => r.targetKind ?? "—" },
            { title: "Steps ok / failed / total", cell: (r) => `${r.steps.ok} / ${r.steps.failed} / ${r.steps.total}`, cls: "num" },
            { title: "Started", cell: (r) => fmtTime(r.startedAt) },
            { title: "Duration", cell: (r) => (r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : "—"), cls: "num" },
          ],
          { onRow: (r) => ctx.go("runs", {}, r.runId), rowLabel: (r) => `Open run ${r.runId}` },
        ),
    pager(res.total, offset, PAGE, (o) => ctx.setParams({ ...p, offset: String(o) })),
  );
};

async function renderRun(ctx: Ctx, main: HTMLElement, id: string): Promise<void> {
  const { run } = await ctx.api.run(id);
  if (!ctx.alive()) return;
  mount(
    main,
    pageHeader(`Run ${shortId(run.runId, 14)}`, h("span", null, statusBadge(run.status), ` ${run.workflow} · ${run.mode}${run.dryRun ? " · dry run" : ""}`)),
    h(
      "div",
      { class: "grid-2" },
      card("Run", kv([
        ["Run id", h("code", null, run.runId)],
        ["Started", fmtTime(run.startedAt)],
        ["Ended", run.endedAt ? fmtTime(run.endedAt) : "—"],
        ["Duration", run.endedAt ? fmtDuration(run.endedAt - run.startedAt) : "—"],
        ["Source session", run.sourceSessionId ? link(buildHash("sessions", {}, run.sourceSessionId), run.sourceSessionId) : "—"],
        ["Checkpoints", run.checkpoints.length ? run.checkpoints.join(", ") : "none"],
      ])),
      card("Target & authorization", run.target ? jsonBlock(run.target) : empty("No target record.")),
    ),
    card("Steps", table(run.steps, [
      { title: "Step", cell: (s) => h("code", null, s.id) },
      { title: "Status", cell: (s) => statusBadge(s.status) },
      { title: "Attempts", cell: (s) => fmtInt(s.attempts), cls: "num" },
      { title: "Started", cell: (s) => fmtTime(s.startedAt) },
      { title: "Duration", cell: (s) => (s.startedAt && s.endedAt ? fmtDuration(s.endedAt - s.startedAt) : "—"), cls: "num" },
      { title: "Error", cell: (s) => s.error ?? "" },
    ])),
  );
}
