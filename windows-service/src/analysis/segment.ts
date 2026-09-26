/**
 * Workflow segmentation, timing analysis, repeated-sequence detection and
 * workflow-graph generation (pure functions over the analyzer model).
 */

import type {
  GraphEdge,
  GraphNode,
  RepeatedSequence,
  Segment,
  TimingSummary,
  WorkflowGraph,
  WorkflowLabel,
} from "../shared.ts";
import { type AEvent, type SessionData, USER_ACTIONS, actionToken, stats } from "./model.ts";

/**
 * Split a session into workflow segments per tab. A new segment starts when an
 * event's detected (non-UNKNOWN) workflow differs from the tab's current one —
 * which is exactly where the recorder emitted a WORKFLOW_TRANSITION. Tab-less
 * session events (start/end) belong to no segment.
 */
export function segmentSession(data: SessionData): Segment[] {
  const segments: Segment[] = [];
  const current = new Map<number, Segment>();
  const sid = data.session.sessionId;

  for (const e of data.events) {
    if (e.tab_id === null) continue;
    let seg = current.get(e.tab_id);
    const label = e.workflow;
    if (!seg || (label !== "UNKNOWN" && label !== seg.workflow)) {
      seg = {
        segment_id: `${sid}#${segments.length}`,
        session_id: sid,
        workflow: label,
        tab_id: e.tab_id,
        start_ts: e.timestamp,
        end_ts: e.timestamp,
        duration_ms: 0,
        first_seq: e.seq,
        last_seq: e.seq,
        event_count: 0,
        event_ids: [],
        actions: {},
      };
      segments.push(seg);
      current.set(e.tab_id, seg);
    }
    if (seg.workflow === "UNKNOWN" && label !== "UNKNOWN") seg.workflow = label;
    seg.end_ts = Math.max(seg.end_ts, e.timestamp);
    seg.last_seq = e.seq;
    seg.event_count += 1;
    seg.event_ids.push(e.event_id);
    seg.actions[e.action] = (seg.actions[e.action] ?? 0) + 1;
  }

  // Duration = time until the next segment in the same tab started (else own span).
  const byTab = new Map<number | null, Segment[]>();
  for (const s of segments) byTab.set(s.tab_id, [...(byTab.get(s.tab_id) ?? []), s]);
  for (const list of byTab.values()) {
    list.forEach((s, i) => {
      const next = list[i + 1];
      s.duration_ms = Math.max(0, (next ? next.start_ts : s.end_ts) - s.start_ts);
    });
  }
  return segments;
}

/** Ordered workflow labels visited (consecutive duplicates collapsed, UNKNOWN dropped). */
export function workflowSequence(segments: readonly Segment[]): WorkflowLabel[] {
  const out: WorkflowLabel[] = [];
  for (const s of [...segments].sort((a, b) => a.first_seq - b.first_seq)) {
    if (s.workflow === "UNKNOWN") continue;
    if (out[out.length - 1] !== s.workflow) out.push(s.workflow);
  }
  return out;
}

export function timingSummary(data: SessionData, segments: readonly Segment[]): TimingSummary {
  const ev = data.events;
  const gaps: Array<{ ms: number; before: AEvent; after: AEvent }> = [];
  for (let i = 1; i < ev.length; i++) {
    const a = ev[i - 1] as AEvent;
    const b = ev[i] as AEvent;
    const ms = b.timestamp - a.timestamp;
    if (ms >= 0) gaps.push({ ms, before: a, after: b });
  }
  const first = ev[0]?.timestamp ?? data.session.startedAt;
  const last = ev[ev.length - 1]?.timestamp ?? first;
  const sessionEnd = data.session.endedAt ?? last;
  const duration = Math.max(0, Math.max(last, sessionEnd) - Math.min(first, data.session.startedAt));
  const byWorkflow: Partial<Record<WorkflowLabel, number>> = {};
  for (const s of segments) byWorkflow[s.workflow] = (byWorkflow[s.workflow] ?? 0) + s.duration_ms;
  return {
    session_duration_ms: duration,
    event_count: ev.length,
    events_per_minute: duration > 0 ? Math.round((ev.length / (duration / 60_000)) * 10) / 10 : ev.length,
    inter_event_gap_ms: stats(gaps.map((g) => g.ms)),
    workflow_duration_ms: byWorkflow,
    longest_gaps: [...gaps]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((g) => ({ ms: g.ms, before_event_id: g.before.event_id, after_event_id: g.after.event_id })),
  };
}

/** Operator actions per tab, in order (the token stream for n-gram analysis). */
export function actionStream(data: SessionData): AEvent[][] {
  const tabs = new Map<number | null, AEvent[]>();
  for (const e of data.events) {
    if (!USER_ACTIONS.has(e.action)) continue;
    tabs.set(e.tab_id, [...(tabs.get(e.tab_id) ?? []), e]);
  }
  return [...tabs.values()];
}

/**
 * Repeated sequence detection: n-grams (n = minLen..maxLen) of operator action
 * tokens occurring at least `minCount` times, non-overlapping per n-gram.
 * Sub-sequences fully explained by a longer repeated sequence with the same
 * count are dropped.
 */
export function repeatedSequences(data: SessionData, minLen = 2, maxLen = 4, minCount = 2): RepeatedSequence[] {
  const found = new Map<string, RepeatedSequence>();
  for (const stream of actionStream(data)) {
    const tokens = stream.map(actionToken);
    for (let n = minLen; n <= maxLen; n++) {
      const lastEnd = new Map<string, number>();
      for (let i = 0; i + n <= tokens.length; i++) {
        const gram = tokens.slice(i, i + n);
        const key = gram.join(" → ");
        if ((lastEnd.get(key) ?? -1) > i) continue; // non-overlapping occurrences
        lastEnd.set(key, i + n);
        const entry = found.get(key) ?? { tokens: gram, count: 0, occurrences: [] };
        entry.count += 1;
        entry.occurrences.push(stream.slice(i, i + n).map((e) => e.event_id));
        found.set(key, entry);
      }
    }
  }
  const repeated = [...found.values()].filter((r) => r.count >= minCount);
  const maximal = repeated.filter(
    (r) =>
      !repeated.some(
        (o) => o !== r && o.tokens.length > r.tokens.length && o.count === r.count && o.tokens.join("\u0000").includes(r.tokens.join("\u0000")),
      ),
  );
  return maximal.sort((a, b) => b.count * b.tokens.length - a.count * a.tokens.length || a.tokens.join().localeCompare(b.tokens.join()));
}

/** Workflow graph for one or more sessions (nodes = workflows, edges = transitions). */
export function workflowGraph(sessions: ReadonlyArray<{ session_id: string; segments: readonly Segment[] }>, maxSamples = 20): WorkflowGraph {
  const nodes = new Map<WorkflowLabel, GraphNode & { _sessions: Set<string> }>();
  const edges = new Map<string, GraphEdge & { _total: number }>();
  for (const { session_id, segments } of sessions) {
    const byTab = new Map<number | null, Segment[]>();
    for (const s of segments) {
      if (s.workflow === "UNKNOWN") continue;
      byTab.set(s.tab_id, [...(byTab.get(s.tab_id) ?? []), s]);
      const n = nodes.get(s.workflow) ?? { id: s.workflow, segments: 0, total_ms: 0, sessions: 0, _sessions: new Set<string>() };
      n.segments += 1;
      n.total_ms += s.duration_ms;
      n._sessions.add(session_id);
      nodes.set(s.workflow, n);
    }
    for (const list of byTab.values()) {
      for (let i = 1; i < list.length; i++) {
        const from = list[i - 1] as Segment;
        const to = list[i] as Segment;
        if (from.workflow === to.workflow) continue;
        const key = `${from.workflow}→${to.workflow}`;
        const edge = edges.get(key) ?? { from: from.workflow, to: to.workflow, count: 0, avg_ms: 0, samples: [], _total: 0 };
        edge.count += 1;
        edge._total += from.duration_ms;
        if (edge.samples.length < maxSamples && to.event_ids[0]) edge.samples.push({ session_id, event_id: to.event_ids[0] });
        edges.set(key, edge);
      }
    }
  }
  return {
    session_ids: sessions.map((s) => s.session_id),
    nodes: [...nodes.values()]
      .map(({ _sessions, ...n }) => ({ ...n, sessions: _sessions.size }))
      .sort((a, b) => b.segments - a.segments || a.id.localeCompare(b.id)),
    edges: [...edges.values()]
      .map(({ _total, ...e }) => ({ ...e, avg_ms: e.count ? Math.round(_total / e.count) : 0 }))
      .sort((a, b) => b.count - a.count || `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`)),
  };
}
