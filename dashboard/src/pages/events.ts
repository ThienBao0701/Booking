/** Event explorer: cross-session search with filters; rows open the detail drawer. */

import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { eventSummary, fmtInt, fmtTime, label, parseData, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { filterBar } from "../components/filters.ts";
import { pager, table } from "../components/table.ts";
import { empty, link, pageHeader, severityBadge, workflowChip } from "../components/ui.ts";

const PAGE = 50;

export const renderEvents: PageRender = async (ctx, main) => {
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const offset = Number(p.offset ?? 0) || 0;
  const [ids, res] = await Promise.all([
    ctx.recentSessions(),
    ctx.api.events({ session: p.session, kind: p.kind, workflow: p.workflow, severity: p.severity, q: p.q, from, to, order: p.session ? "asc" : "desc", limit: PAGE, offset }),
  ]);
  if (!ctx.alive()) return;
  mount(
    main,
    pageHeader("Events", `${fmtInt(res.total)} event(s) match. Stored events are redacted at rest; values typed by the operator are never recorded.`),
    filterBar({ params: p, show: ["range", "session", "kind", "workflow", "severity", "q"], sessions: ids, onChange: ctx.setParams }),
    res.events.length === 0
      ? empty("No events match these filters.")
      : table(
          res.events,
          [
            { title: "Time", cell: (e) => fmtTime(e.ts) },
            { title: "Session", cell: (e) => link(buildHash("sessions", {}, e.session_id), shortId(e.session_id, 8)) },
            { title: "Seq", cell: (e) => `#${e.seq}`, cls: "num" },
            { title: "Kind", cell: (e) => label(e.kind) },
            { title: "Workflow", cell: (e) => workflowChip(e.workflow) },
            { title: "Severity", cell: (e) => severityBadge(e.severity) },
            { title: "Summary", cell: (e) => h("span", { class: "mono small" }, eventSummary(e.kind, parseData(e.data))) },
          ],
          { onRow: (e) => ctx.openEvent(e.id), rowLabel: (e) => `Open event ${e.id}`, caption: "Events" },
        ),
    pager(res.total, offset, PAGE, (o) => ctx.setParams({ ...p, offset: String(o) })),
  );
};
