/** Screenshots: user-triggered capture records (hash + size). Image bytes are not retained by the recorder. */

import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { fmtBytes, fmtInt, fmtTime, parseData, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { filterBar } from "../components/filters.ts";
import { pager, table } from "../components/table.ts";
import { empty, link, pageHeader, workflowChip } from "../components/ui.ts";

const PAGE = 50;

export const renderScreenshots: PageRender = async (ctx, main) => {
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const offset = Number(p.offset ?? 0) || 0;
  const [ids, res] = await Promise.all([ctx.recentSessions(), ctx.api.events({ kind: "SCREENSHOT", session: p.session, from, to, limit: PAGE, offset })]);
  if (!ctx.alive()) return;
  const md = (data: string) => (parseData(data).metadata ?? {}) as Record<string, unknown>;
  mount(
    main,
    pageHeader("Screenshots", `${fmtInt(res.total)} capture record(s).`),
    h("p", { class: "note", role: "note" }, "Screenshots are taken only on an explicit operator action. The recorder keeps a SHA-256 fingerprint and size of each capture so it can be matched to a file the operator saved; the image itself is not stored by the lab (privacy model)."),
    filterBar({ params: p, show: ["range", "session"], sessions: ids, onChange: ctx.setParams }),
    res.events.length === 0
      ? empty("No screenshot records. Use “Capture screenshot” in the extension popup while recording.")
      : table(
          res.events,
          [
            { title: "Time", cell: (e) => fmtTime(e.ts) },
            { title: "Session", cell: (e) => link(buildHash("sessions", {}, e.session_id), shortId(e.session_id, 8)) },
            { title: "Page", cell: (e) => String(parseData(e.data).page ?? "—") },
            { title: "Workflow", cell: (e) => workflowChip(e.workflow) },
            { title: "SHA-256", cell: (e) => h("code", { class: "small", title: String(md(e.data).sha256 ?? "") }, String(md(e.data).sha256 ?? "—").slice(0, 16)) },
            { title: "Size", cell: (e) => fmtBytes(typeof md(e.data).bytes === "number" ? (md(e.data).bytes as number) : null), cls: "num" },
            { title: "Format", cell: (e) => String(md(e.data).format ?? "—") },
            { title: "Trigger", cell: (e) => String(md(e.data).trigger ?? "—") },
          ],
          { onRow: (e) => ctx.openEvent(e.id), rowLabel: (e) => `Open screenshot record ${e.id}` },
        ),
    pager(res.total, offset, PAGE, (o) => ctx.setParams({ ...p, offset: String(o) })),
  );
};
