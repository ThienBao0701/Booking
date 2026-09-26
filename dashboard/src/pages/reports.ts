/** Reports: forensic report downloads per session (report generation lands with Phase 10). */

import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { shortId } from "../format.ts";
import { empty, pageHeader } from "../components/ui.ts";

export const renderReports: PageRender = async (ctx, main) => {
  const ids = await ctx.recentSessions();
  if (!ctx.alive()) return;
  const p = ctx.route.params;
  const sel = h("select", { name: "session", "aria-label": "Session" }, h("option", { value: "" }, "Choose a session…"), ...ids.map((id) => h("option", { value: id, selected: id === p.session }, shortId(id, 16)))) as HTMLSelectElement;
  sel.addEventListener("change", () => ctx.setParams({ session: sel.value }));
  mount(
    main,
    pageHeader("Reports", "Forensic reports (JSON, CSV, HTML, print-ready HTML) per session."),
    h("div", { class: "filter-bar" }, h("label", { class: "filter" }, h("span", { class: "filter-label" }, "Session"), sel)),
    empty("Report generation is provided by the service's report endpoints (Phase 10)."),
  );
};
