/**
 * Chart geometry (pure, unit-tested): nice ticks, time ticks, the workflow arc
 * diagram and the session timeline. Rendering lives in components/*.
 */

import { WORKFLOW_LABELS, type WorkflowGraph } from "./shared.ts";

/** "Nice" axis ticks (1/2/5 × 10^k) from 0 to ≥ max. */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((s) => s * 1000);

/** Time-axis ticks within [t0, t1] for an axis `width` px wide (~90 px per tick). */
export function timeTicks(t0: number, t1: number, width: number): number[] {
  const span = Math.max(1, t1 - t0);
  const maxTicks = Math.max(2, Math.floor(width / 90));
  const step = TIME_STEPS.find((s) => span / s <= maxTicks) ?? Math.ceil(span / maxTicks / 86_400_000) * 86_400_000;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}

/** Approximate rendered width of `text` at the UI font size (px). */
export function textWidth(text: string, fontPx = 11): number {
  return Math.ceil(text.length * fontPx * 0.6);
}

// ---------------------------------------------------------------- arc diagram

export interface ArcNode {
  id: string;
  x: number;
  y: number;
  r: number;
  segments: number;
  sessions: number;
  total_ms: number;
}

export interface ArcEdge {
  from: string;
  to: string;
  count: number;
  avg_ms: number;
  /** SVG path data. Forward transitions arc above the axis, backward ones below. */
  d: string;
  width: number;
  above: boolean;
  labelX: number;
  labelY: number;
  samples: Array<{ session_id: string; event_id: string }>;
}

export interface ArcLayout {
  width: number;
  height: number;
  baseline: number;
  nodes: ArcNode[];
  edges: ArcEdge[];
}

/**
 * Arc diagram: workflows on one axis in canonical order; each transition is an
 * arc whose thickness grows with its count. Deterministic for a given graph.
 */
export function arcLayout(graph: WorkflowGraph, width: number): ArcLayout {
  const order = WORKFLOW_LABELS.filter((w) => graph.nodes.some((n) => n.id === w));
  const margin = 56;
  const stepX = order.length > 1 ? (width - margin * 2) / (order.length - 1) : 0;
  const xOf = new Map<string, number>(order.map((w, i) => [w, order.length > 1 ? margin + i * stepX : width / 2]));
  const idx = (w: string) => (order as readonly string[]).indexOf(w);
  const spanOf = (e: { from: string; to: string }) => Math.abs((xOf.get(e.to) ?? 0) - (xOf.get(e.from) ?? 0));
  const arcH = (span: number) => Math.min(150, 24 + span * 0.42);
  const upH = Math.max(0, ...graph.edges.filter((e) => idx(e.from) < idx(e.to)).map((e) => arcH(spanOf(e))));
  const downH = Math.max(0, ...graph.edges.filter((e) => idx(e.from) > idx(e.to)).map((e) => arcH(spanOf(e))));
  const baseline = Math.round(Math.max(60, upH * 0.75 + 28));
  const height = Math.round(baseline + Math.max(48, downH * 0.75 + 36));
  const maxSeg = Math.max(1, ...graph.nodes.map((n) => n.segments));
  const maxCount = Math.max(1, ...graph.edges.map((e) => e.count));

  const nodes: ArcNode[] = order.map((w) => {
    const n = graph.nodes.find((x) => x.id === w) as WorkflowGraph["nodes"][number];
    return {
      id: w,
      x: Math.round(xOf.get(w) ?? 0),
      y: baseline,
      r: Math.round(6 + 10 * Math.sqrt(n.segments / maxSeg)),
      segments: n.segments,
      sessions: n.sessions,
      total_ms: n.total_ms,
    };
  });
  const edges: ArcEdge[] = graph.edges
    .filter((e) => xOf.has(e.from) && xOf.has(e.to))
    .map((e) => {
      const x1 = xOf.get(e.from) as number;
      const x2 = xOf.get(e.to) as number;
      const above = x2 > x1;
      const h = arcH(Math.abs(x2 - x1)) * (above ? -1 : 1);
      const cy = baseline + h;
      return {
        from: e.from,
        to: e.to,
        count: e.count,
        avg_ms: e.avg_ms,
        d: `M ${Math.round(x1)} ${baseline} C ${Math.round(x1)} ${Math.round(cy)}, ${Math.round(x2)} ${Math.round(cy)}, ${Math.round(x2)} ${baseline}`,
        width: Math.round((1.5 + 6.5 * Math.sqrt(e.count / maxCount)) * 10) / 10,
        above,
        labelX: Math.round((x1 + x2) / 2),
        labelY: Math.round(baseline + h * 0.75 + (above ? -6 : 14)),
        samples: e.samples,
      };
    });
  return { width, height, baseline, nodes, edges };
}

// ------------------------------------------------------------------- timeline

export interface TimelineInput {
  t0: number;
  t1: number;
  segments: ReadonlyArray<{ segment_id: string; tab_id: number | null; workflow: string; start_ts: number; duration_ms: number; end_ts: number; event_count: number }>;
  events: ReadonlyArray<{ id: string; ts: number; tab_id: number | null; kind: string; severity: string }>;
  findings: ReadonlyArray<{ finding_id: string; title: string; severity: string; timestamp_range: { start: number; end: number } }>;
}

export interface TimelineLayout {
  width: number;
  height: number;
  x: (t: number) => number;
  lanes: Array<{ key: string; label: string; y: number; h: number }>;
  segments: Array<{ id: string; x: number; y: number; w: number; h: number; workflow: string; showLabel: boolean }>;
  ticks: Array<{ id: string; x: number; y1: number; y2: number; kind: string; severity: string }>;
  findingBands: Array<{ id: string; x: number; y: number; w: number; h: number; severity: string; title: string }>;
  axis: Array<{ x: number; t: number }>;
  axisY: number;
  findingsY: number;
}

export const TIMELINE = { left: 72, right: 16, top: 8, laneH: 34, gap: 6, findingsLaneH: 22, findingsRowH: 14, axisH: 24 } as const;

/**
 * Swimlanes per tab (plus "session" for tab-less lifecycle events) and a
 * findings lane. Segments carry workflow labels as text (identity is never
 * colour-only); event ticks sit inside their lane.
 */
export function timelineLayout(input: TimelineInput, width: number): TimelineLayout {
  const { left, right, top, laneH, gap, findingsLaneH, findingsRowH, axisH } = TIMELINE;
  const t0 = input.t0;
  const t1 = Math.max(input.t1, input.t0 + 1);
  const plotW = Math.max(40, width - left - right);
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * plotW;

  const tabs = [...new Set([...input.segments.map((s) => s.tab_id), ...input.events.map((e) => e.tab_id)])].sort((a, b) =>
    a === null ? 1 : b === null ? -1 : a - b,
  );
  const lanes = tabs.map((t, i) => ({
    key: t === null ? "session" : `tab:${t}`,
    label: t === null ? "session" : `tab ${t}`,
    y: top + i * (laneH + gap),
    h: laneH,
  }));
  const laneOf = new Map(tabs.map((t, i) => [t, lanes[i] as (typeof lanes)[number]]));
  const findingsY = top + lanes.length * (laneH + gap);

  const segments = input.segments.map((s) => {
    const lane = laneOf.get(s.tab_id) as (typeof lanes)[number];
    const x1 = x(s.start_ts);
    const x2 = x(s.start_ts + Math.max(s.duration_ms, s.end_ts - s.start_ts));
    const w = Math.max(2, x2 - x1 - 2); // 2px surface gap between touching segments
    return { id: s.segment_id, x: Math.round(x1), y: lane.y + 4, w: Math.round(w), h: lane.h - 8, workflow: s.workflow, showLabel: w >= textWidth(s.workflow) + 12 };
  });
  const ticks = input.events.map((e) => {
    const lane = laneOf.get(e.tab_id) as (typeof lanes)[number];
    return { id: e.id, x: Math.round(x(e.ts) * 10) / 10, y1: lane.y + 2, y2: lane.y + lane.h - 2, kind: e.kind, severity: e.severity };
  });
  // Overlapping finding ranges are packed into rows so none hides another.
  const rowEnds: number[] = [];
  const findingBands = [...input.findings]
    .sort((a, b) => a.timestamp_range.start - b.timestamp_range.start || a.finding_id.localeCompare(b.finding_id))
    .map((f) => {
      const x1 = Math.round(x(f.timestamp_range.start));
      const w = Math.max(6, Math.round(x(f.timestamp_range.end) - x1));
      let row = rowEnds.findIndex((end) => end + 3 <= x1);
      if (row < 0) {
        row = rowEnds.length;
        rowEnds.push(0);
      }
      rowEnds[row] = x1 + w;
      return { id: f.finding_id, x: x1, y: findingsY + 3 + row * findingsRowH, w, h: findingsRowH - 4, severity: f.severity, title: f.title };
    });
  const findingsH = Math.max(findingsLaneH, rowEnds.length * findingsRowH + 6);
  const axisY = findingsY + findingsH + 4;
  return {
    width,
    height: axisY + axisH,
    x,
    lanes,
    segments,
    ticks,
    findingBands,
    axis: timeTicks(t0, t1, plotW).map((t) => ({ t, x: Math.round(x(t)) })),
    axisY,
    findingsY,
  };
}
