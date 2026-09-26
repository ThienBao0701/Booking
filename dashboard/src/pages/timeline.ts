/** Timeline visualization of one session: tabs × time, workflow segments, events, findings. */

import type { StoredEventRow } from "../shared.ts";
import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { fmtDuration, fmtInt, fmtTime, shortId } from "../format.ts";
import { buildHash } from "../route.ts";
import { timelineView } from "../components/timeline.ts";
import { table } from "../components/table.ts";
import { card, empty, link, pageHeader, workflowChip } from "../components/ui.ts";

const ZOOMS = ["1", "2", "4", "8", "16"];
const MAX_EVENTS = 5000;

export const renderTimeline: PageRender = async (ctx, main) => {
  const p = ctx.route.params;
  const ids = await ctx.recentSessions();
  if (!ctx.alive()) return;
  const sessionSel = h("select", { name: "session", "aria-label": "Session" }, h("option", { value: "" }, "Choose a session…"), ...ids.map((id) => h("option", { value: id, selected: id === p.session }, shortId(id, 16)))) as HTMLSelectElement;
  sessionSel.addEventListener("change", () => ctx.setParams({ session: sessionSel.value }));
  const zoomSel = h("select", { name: "zoom", "aria-label": "Zoom" }, ...ZOOMS.map((z) => h("option", { value: z, selected: z === (p.zoom ?? "1") }, `${z}×`))) as HTMLSelectElement;
  zoomSel.addEventListener("change", () => ctx.setParams({ ...p, zoom: zoomSel.value }));
  const bar = h("div", { class: "filter-bar" }, h("label", { class: "filter" }, h("span", { class: "filter-label" }, "Session"), sessionSel), h("label", { class: "filter" }, h("span", { class: "filter-label" }, "Zoom"), zoomSel));
  if (!p.session) {
    mount(main, pageHeader("Timeline", "Tabs × time for one session."), bar, empty(ids.length ? "Choose a session to draw its timeline." : "No sessions recorded yet."));
    return;
  }
  const events: StoredEventRow[] = [];
  let total = Infinity;
  for (let offset = 0; offset < Math.min(total, MAX_EVENTS); offset += 500) {
    const page = await ctx.api.events({ session: p.session, order: "asc", limit: 500, offset });
    total = page.total;
    events.push(...page.events);
    if (page.events.length < 500) break;
  }
  const [analysis, findings] = await Promise.all([ctx.api.analysis(p.session), ctx.api.findings({ session: p.session, limit: 500 })]);
  if (!ctx.alive()) return;
  const zoom = Math.max(1, Math.min(16, Number(p.zoom ?? 1) || 1));
  mount(
    main,
    pageHeader("Timeline", h("span", null, link(buildHash("sessions", {}, p.session), p.session), ` · ${fmtInt(events.length)} events · ${fmtDuration(analysis.timing.session_duration_ms)}`)),
    bar,
    total > events.length ? h("p", { class: "muted" }, `Showing the first ${fmtInt(events.length)} of ${fmtInt(total)} events.`) : null,
    card(
      null,
      h(
        "div",
        { class: "legend" },
        h("span", { class: "legend-item" }, h("span", { class: "swatch segment" }), "workflow segment (label = workflow)"),
        h("span", { class: "legend-item" }, h("span", { class: "swatch tick" }), "event (click for details)"),
        h("span", { class: "legend-item" }, "✖ error · ▲ warning"),
        h("span", { class: "legend-item" }, h("span", { class: "swatch band-info" }), "finding range (click to open)"),
      ),
      timelineView({
        segments: analysis.segments,
        events,
        findings: findings.findings,
        zoom,
        onEvent: (id) => ctx.openEvent(id),
        onFinding: (id) => ctx.go("findings", {}, id),
      }),
    ),
    card("Segments (table view)", table(analysis.segments, [
      { title: "Workflow", cell: (s) => workflowChip(s.workflow) },
      { title: "Tab", cell: (s) => (s.tab_id === null ? "—" : String(s.tab_id)), cls: "num" },
      { title: "Start", cell: (s) => fmtTime(s.start_ts) },
      { title: "Duration", cell: (s) => fmtDuration(s.duration_ms), cls: "num" },
      { title: "Events", cell: (s) => fmtInt(s.event_count), cls: "num" },
      { title: "First event", cell: (s) => h("button", { type: "button", class: "linklike", on: { click: () => ctx.openEvent(s.event_ids[0] ?? "") } }, `#${s.first_seq}`) },
    ])),
  );
  if (p.focus) ctx.openEvent(p.focus);
};
