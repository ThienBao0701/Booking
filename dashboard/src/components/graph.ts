/**
 * Workflow graph as an arc diagram: workflows on one axis in canonical order,
 * forward transitions above, returns below, arc thickness ∝ transition count.
 * Nodes and arcs are keyboard-focusable with tooltips; clicking an arc selects it.
 */

import type { WorkflowGraph } from "../shared.ts";
import { h, s } from "../dom.ts";
import { arcLayout, type ArcEdge } from "../layout.ts";
import { fmtDuration, fmtInt, label } from "../format.ts";
import { responsive } from "./charts.ts";
import { attachTooltip, tipRows } from "./tooltip.ts";

export function workflowGraphView(graph: WorkflowGraph, onEdge: (e: ArcEdge) => void, onNode: (id: string) => void): HTMLElement {
  if (graph.nodes.length === 0) return h("div", { class: "empty" }, "No workflow segments in the selected sessions.");
  return responsive((width) => {
    const L = arcLayout(graph, width);
    const svg = s("svg", { width: L.width, height: L.height, role: "img", "aria-label": "Workflow transition arc diagram", class: "viz graph" });
    svg.appendChild(s("line", { x1: 24, x2: L.width - 24, y1: L.baseline, y2: L.baseline, class: "axis" }));
    const maxCount = Math.max(...L.edges.map((e) => e.count), 0);
    for (const e of L.edges) {
      const g = s("g", { class: "mark edge clickable", tabindex: 0, "aria-label": `${label(e.from)} to ${label(e.to)}: ${e.count} transitions` });
      g.appendChild(s("path", { d: e.d, class: "edge-hit" }));
      g.appendChild(s("path", { d: e.d, class: e.above ? "edge-line" : "edge-line edge-back", "stroke-width": e.width }));
      // Selective direct labels: only the strongest transitions carry a count.
      if (e.count >= Math.max(2, maxCount * 0.5)) g.appendChild(s("text", { x: e.labelX, y: e.labelY, "text-anchor": "middle", class: "t-secondary num small" }, fmtInt(e.count)));
      attachTooltip(g, () => tipRows(`${label(e.from)} → ${label(e.to)}`, [[fmtInt(e.count), "transitions"], [fmtDuration(e.avg_ms), `avg time in ${label(e.from)} before`]]));
      g.addEventListener("click", () => onEdge(e));
      g.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") onEdge(e);
      });
      svg.appendChild(g);
    }
    for (const n of L.nodes) {
      const g = s("g", { class: "mark node clickable", tabindex: 0, "aria-label": `${label(n.id)}: ${n.segments} segments in ${n.sessions} sessions` });
      g.appendChild(s("circle", { cx: n.x, cy: n.y, r: n.r + 6, class: "hit" }));
      g.appendChild(s("circle", { cx: n.x, cy: n.y, r: n.r, class: "node-dot" }));
      g.appendChild(s("text", { x: n.x, y: n.y + n.r + 16, "text-anchor": "middle", class: "t-primary small" }, label(n.id)));
      attachTooltip(g, () => tipRows(label(n.id), [[fmtInt(n.segments), "segments"], [fmtInt(n.sessions), "sessions"], [fmtDuration(n.total_ms), "total time"]]));
      g.addEventListener("click", () => onNode(n.id));
      g.addEventListener("keydown", (ev) => {
        if ((ev as KeyboardEvent).key === "Enter") onNode(n.id);
      });
      svg.appendChild(g);
    }
    return svg;
  }, 520);
}
