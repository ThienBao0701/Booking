/**
 * Session timeline: one swimlane per tab (+ "session" for lifecycle events),
 * workflow segments as labelled bars, events as ticks (errors marked with an
 * icon, not colour alone), and a findings lane whose bands open the finding.
 */

import type { Finding, Segment, StoredEventRow } from "../shared.ts";
import { h, s } from "../dom.ts";
import { TIMELINE, timelineLayout } from "../layout.ts";
import { fmtClock, fmtDuration, label } from "../format.ts";
import { responsive } from "./charts.ts";
import { attachTooltip, tipRows } from "./tooltip.ts";

export interface TimelineViewOpts {
  segments: Segment[];
  events: StoredEventRow[];
  findings: Finding[];
  zoom: number;
  onEvent: (id: string) => void;
  onFinding: (id: string) => void;
}

export function timelineView(o: TimelineViewOpts): HTMLElement {
  if (o.events.length === 0) return h("div", { class: "empty" }, "This session has no events.");
  const t0 = Math.min(...o.events.map((e) => e.ts));
  const t1 = Math.max(...o.events.map((e) => e.ts), ...o.segments.map((sg) => sg.start_ts + sg.duration_ms));
  const byId = new Map(o.events.map((e) => [e.id, e]));
  const scroller = h("div", { class: "timeline-scroll" });
  const chart = responsive((w) => {
    const width = Math.round(w * o.zoom);
    const L = timelineLayout(
      {
        t0,
        t1,
        segments: o.segments,
        events: o.events.map((e) => ({ id: e.id, ts: e.ts, tab_id: e.tab_id, kind: e.kind, severity: e.severity })),
        findings: o.findings,
      },
      width,
    );
    const svg = s("svg", { width: L.width, height: L.height, role: "img", "aria-label": "Session timeline", class: "viz timeline" });
    for (const lane of L.lanes) {
      svg.appendChild(s("rect", { x: TIMELINE.left, y: lane.y, width: L.width - TIMELINE.left - TIMELINE.right, height: lane.h, class: "lane" }));
      svg.appendChild(s("text", { x: TIMELINE.left - 8, y: lane.y + lane.h / 2 + 4, "text-anchor": "end", class: "t-muted small" }, lane.label));
    }
    svg.appendChild(s("text", { x: TIMELINE.left - 8, y: L.findingsY + TIMELINE.findingsLaneH / 2 + 4, "text-anchor": "end", class: "t-muted small" }, "findings"));
    for (const a of L.axis) {
      svg.appendChild(s("line", { x1: a.x, x2: a.x, y1: TIMELINE.top, y2: L.axisY, class: "grid" }));
      svg.appendChild(s("text", { x: a.x, y: L.axisY + 14, "text-anchor": "middle", class: "t-muted small num" }, fmtClock(a.t).slice(0, 8)));
    }
    for (const sg of L.segments) {
      const seg = o.segments.find((x) => x.segment_id === sg.id) as Segment;
      const g = s("g", { class: "mark", tabindex: 0, "aria-label": `${label(sg.workflow)} segment, ${fmtDuration(seg.duration_ms)}, ${seg.event_count} events` });
      g.appendChild(s("rect", { x: sg.x, y: sg.y, width: sg.w, height: sg.h, rx: 3, class: sg.workflow === "UNKNOWN" ? "segment segment-unknown" : "segment" }));
      if (sg.showLabel) g.appendChild(s("text", { x: sg.x + 6, y: sg.y + sg.h / 2 + 4, class: "t-primary small" }, label(sg.workflow)));
      attachTooltip(g, () => tipRows(label(sg.workflow), [[fmtDuration(seg.duration_ms), "duration"], [String(seg.event_count), "events"], [`#${seg.first_seq}–#${seg.last_seq}`, "seq"]]));
      svg.appendChild(g);
    }
    for (const t of L.ticks) {
      const ev = byId.get(t.id) as StoredEventRow;
      const g = s("g", { class: `mark tick clickable${t.severity === "error" ? " tick-error" : t.severity === "warn" ? " tick-warn" : ""}`, tabindex: 0, "aria-label": `${t.kind} at ${fmtClock(ev.ts)}, seq ${ev.seq}` });
      g.appendChild(s("rect", { x: t.x - 4, y: t.y1, width: 8, height: t.y2 - t.y1, class: "hit" }));
      g.appendChild(s("line", { x1: t.x, x2: t.x, y1: t.y1 + 6, y2: t.y2 - 6, class: "tick-line" }));
      if (t.severity === "error" || t.severity === "warn") g.appendChild(s("text", { x: t.x, y: t.y1 + 8, "text-anchor": "middle", class: "tick-icon" }, t.severity === "error" ? "✖" : "▲"));
      attachTooltip(g, () => tipRows(label(t.kind), [[fmtClock(ev.ts), "time"], [`#${ev.seq}`, "seq"], [ev.severity, "severity"], [label(ev.workflow ?? "UNKNOWN"), "workflow"]]));
      g.addEventListener("click", () => o.onEvent(t.id));
      g.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") o.onEvent(t.id);
      });
      svg.appendChild(g);
    }
    for (const f of L.findingBands) {
      const g = s("g", { class: `mark band clickable band-${f.severity}`, tabindex: 0, "aria-label": `finding: ${f.title}` });
      g.appendChild(s("rect", { x: f.x, y: f.y, width: f.w, height: f.h, rx: 3, class: "band-rect" }));
      attachTooltip(g, () => tipRows(f.title, [[f.severity, "severity"]]));
      g.addEventListener("click", () => o.onFinding(f.id));
      g.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") o.onFinding(f.id);
      });
      svg.appendChild(g);
    }
    return svg;
  }, 480);
  scroller.appendChild(chart);
  return scroller;
}
