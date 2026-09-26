/**
 * JSON rule engine (Phase 8): evaluates declarative rule conditions against a
 * session (plus an optional cohort of other sessions for outlier baselines and
 * cross-session correlation). Produces raw matches; findings.ts turns them into
 * validated, non-conclusive Findings.
 */

import type {
  AnalysisRule,
  Matcher,
  RuleCondition,
  Segment,
  WorkflowLabel,
} from "../../shared.ts";
import { type AEvent, type SessionData, USER_ACTIONS, actionToken, median, robustZ, targetText } from "../model.ts";
import { repeatedSequences } from "../segment.ts";
import { actionTrigrams, workflowBigrams } from "../compare.ts";

/** Everything a rule may look at for one subject session. */
export interface EvalContext {
  data: SessionData;
  segments: Segment[];
  sequence: WorkflowLabel[];
  cohort: ReadonlyArray<{ session_id: string; data: SessionData; segments: Segment[]; sequence: WorkflowLabel[] }>;
}

export interface RuleMatch {
  /** Events that produced the match (become the finding's event_ids). */
  events: AEvent[];
  vars: Record<string, string | number>;
  workflow?: WorkflowLabel;
  context?: Record<string, unknown>;
}

/** Hard cap on matches per rule per session (the rest are counted, not listed). */
export const MAX_MATCHES_PER_RULE = 25;

// ---- matching ----

const regexCache = new Map<string, RegExp>();
function rx(src: string): RegExp {
  let r = regexCache.get(src);
  if (!r) {
    r = new RegExp(src, "i");
    regexCache.set(src, r);
  }
  return r;
}
const inList = <T>(v: T, spec: T | T[] | undefined) => spec === undefined || (Array.isArray(spec) ? spec.includes(v) : spec === v);

export function matches(m: Matcher, e: AEvent): boolean {
  if (!inList(e.kind, m.kind)) return false;
  if (!inList(e.action, m.action)) return false;
  if (!inList(e.workflow, m.workflow)) return false;
  if (!inList(e.severity, m.severity)) return false;
  if (m.target !== undefined && !rx(m.target).test(targetText(e.target))) return false;
  if (m.page !== undefined && !rx(m.page).test(e.page)) return false;
  if (m.metadata) {
    for (const [k, v] of Object.entries(m.metadata)) if (e.metadata[k] !== v) return false;
  }
  return true;
}

function describe(m: Matcher): string {
  const parts: string[] = [];
  for (const k of ["kind", "action", "workflow", "severity"] as const) {
    const v = m[k];
    if (v !== undefined) parts.push(Array.isArray(v) ? v.join("|") : String(v));
  }
  if (m.target) parts.push(`target~/${m.target}/`);
  if (m.page) parts.push(`page~/${m.page}/`);
  return parts.join(" ") || "any event";
}

const secs = (ms: number) => Math.round(ms / 100) / 10;

// ---- condition evaluators ----

function evalSequence(c: Extract<RuleCondition, { type: "sequence" }>, ctx: EvalContext): RuleMatch[] {
  const ev = ctx.data.events;
  const within = c.within_ms ?? Number.POSITIVE_INFINITY;
  const out: RuleMatch[] = [];
  let lastEnd = -1;
  for (let i = 0; i < ev.length; i++) {
    const start = ev[i] as AEvent;
    if (start.seq <= lastEnd || !matches(c.steps[0] as Matcher, start)) continue;
    const chain = [start];
    let cur = i;
    for (let s = 1; s < c.steps.length; s++) {
      let found = -1;
      for (let j = cur + 1; j < ev.length; j++) {
        const e = ev[j] as AEvent;
        if (e.timestamp - start.timestamp > within) break;
        if (c.same_tab && e.tab_id !== start.tab_id) continue;
        if (matches(c.steps[s] as Matcher, e)) {
          found = j;
          break;
        }
      }
      if (found < 0) break;
      chain.push(ev[found] as AEvent);
      cur = found;
    }
    if (chain.length === c.steps.length) {
      const last = chain[chain.length - 1] as AEvent;
      out.push({ events: chain, vars: { within_s: Number.isFinite(within) ? secs(within) : "n/a", duration_s: secs(last.timestamp - start.timestamp) } });
      lastEnd = last.seq;
    }
  }
  return out;
}

/** Densest window of `events` (sorted by time) no longer than `windowMs`. */
function densest(events: AEvent[], windowMs: number): AEvent[] {
  let best: AEvent[] = [];
  let lo = 0;
  for (let hi = 0; hi < events.length; hi++) {
    while ((events[hi] as AEvent).timestamp - (events[lo] as AEvent).timestamp > windowMs) lo++;
    if (hi - lo + 1 > best.length) best = events.slice(lo, hi + 1);
  }
  return best;
}

function evalRepetition(c: Extract<RuleCondition, { type: "repetition" }>, ctx: EvalContext): RuleMatch[] {
  const within = c.within_ms ?? Number.POSITIVE_INFINITY;
  const groups = new Map<string, AEvent[][]>();
  const lastToken = new Map<number | null, string>();
  for (const e of ctx.data.events) {
    const isAction = USER_ACTIONS.has(e.action);
    const token = actionToken(e);
    if (matches(c.match, e)) {
      const key = `${token}|${e.tab_id}`;
      const runs = groups.get(key) ?? [[]];
      // consecutive: a different operator action in the same tab breaks the run
      if (c.consecutive && lastToken.get(e.tab_id) !== undefined && lastToken.get(e.tab_id) !== token) runs.push([]);
      (runs[runs.length - 1] as AEvent[]).push(e);
      groups.set(key, runs);
    }
    if (isAction) lastToken.set(e.tab_id, token);
  }
  const out: RuleMatch[] = [];
  for (const runs of groups.values()) {
    let best: AEvent[] = [];
    for (const run of runs) {
      const d = densest(run, within);
      if (d.length > best.length) best = d;
    }
    if (best.length >= c.min_count) {
      out.push({
        events: best,
        vars: {
          count: best.length,
          within_s: Number.isFinite(within) ? secs(within) : "n/a",
          pattern: actionToken(best[0] as AEvent),
          duration_s: secs((best[best.length - 1] as AEvent).timestamp - (best[0] as AEvent).timestamp),
        },
      });
    }
  }
  return out;
}

function evalRepeatedSequence(c: Extract<RuleCondition, { type: "repeated_sequence" }>, ctx: EvalContext): RuleMatch[] {
  const byId = new Map(ctx.data.events.map((e) => [e.event_id, e]));
  return repeatedSequences(ctx.data, c.min_length, c.max_length, c.min_count).map((r) => ({
    events: r.occurrences.flat().map((id) => byId.get(id)).filter((e): e is AEvent => e !== undefined),
    vars: { count: r.count, length: r.tokens.length, pattern: r.tokens.join(" → ") },
    context: { tokens: r.tokens, occurrences: r.occurrences },
  }));
}

function evalGap(c: Extract<RuleCondition, { type: "gap" }>, ctx: EvalContext): RuleMatch[] {
  const ev = ctx.data.events;
  const out: RuleMatch[] = [];
  for (let i = 1; i < ev.length; i++) {
    const a = ev[i - 1] as AEvent;
    const b = ev[i] as AEvent;
    const gap = b.timestamp - a.timestamp;
    if (gap < c.min_ms) continue;
    if (c.after && !matches(c.after, a)) continue;
    if (c.before && !matches(c.before, b)) continue;
    out.push({ events: [a, b], vars: { gap_s: secs(gap), threshold_s: secs(c.min_ms) } });
  }
  return out;
}

function evalDuration(c: Extract<RuleCondition, { type: "duration" }>, ctx: EvalContext): RuleMatch[] {
  const byId = new Map(ctx.data.events.map((e) => [e.event_id, e]));
  const out: RuleMatch[] = [];
  const perTab = new Map<number | null, Segment[]>();
  for (const s of ctx.segments) perTab.set(s.tab_id, [...(perTab.get(s.tab_id) ?? []), s]);
  for (const list of perTab.values()) {
    list.forEach((s, i) => {
      if (s.workflow === "UNKNOWN" || !inList(s.workflow, c.workflow)) return;
      if (c.min_events !== undefined && s.event_count < c.min_events) return;
      const tooShort = c.min_ms !== undefined && s.duration_ms < c.min_ms;
      const tooLong = c.max_ms !== undefined && s.duration_ms > c.max_ms;
      if (!tooShort && !tooLong) return;
      const ids = [s.event_ids[0], s.event_ids[s.event_ids.length - 1], list[i + 1]?.event_ids[0]];
      const events = [...new Set(ids)].map((id) => (id ? byId.get(id) : undefined)).filter((e): e is AEvent => e !== undefined);
      out.push({
        events,
        workflow: s.workflow,
        vars: { duration_s: secs(s.duration_ms), threshold_s: secs((tooShort ? c.min_ms : c.max_ms) as number), workflow: s.workflow, count: s.event_count },
        context: { segment_id: s.segment_id },
      });
    });
  }
  return out;
}

function evalCount(c: Extract<RuleCondition, { type: "count" }>, ctx: EvalContext): RuleMatch[] {
  const hits = ctx.data.events.filter((e) => matches(c.match, e));
  const n = hits.length;
  // A finding must cite events: count rules only fire when they matched something.
  if (n === 0) return [];
  if (c.min !== undefined && n < c.min) return [];
  if (c.max !== undefined && n > c.max) return [];
  return [{ events: hits.slice(0, 50), vars: { count: n }, context: { total_matches: n } }];
}

function evalRate(c: Extract<RuleCondition, { type: "rate" }>, ctx: EvalContext): RuleMatch[] {
  const best = densest(ctx.data.events.filter((e) => matches(c.match, e)), c.window_ms);
  if (best.length < c.min_count) return [];
  return [{ events: best, vars: { count: best.length, window_s: secs(c.window_ms) } }];
}

function evalAbsence(c: Extract<RuleCondition, { type: "absence" }>, ctx: EvalContext): RuleMatch[] {
  const ev = ctx.data.events;
  const lastTs = ev[ev.length - 1]?.timestamp ?? 0;
  const out: RuleMatch[] = [];
  ev.forEach((a, i) => {
    if (!matches(c.after, a)) return;
    // Only judge when the whole window was observed (the session went on long enough).
    if (lastTs - a.timestamp < c.within_ms) return;
    for (let j = i + 1; j < ev.length; j++) {
      const e = ev[j] as AEvent;
      if (e.timestamp - a.timestamp > c.within_ms) break;
      if ((a.tab_id === null || e.tab_id === null || e.tab_id === a.tab_id) && matches(c.expect, e)) return;
    }
    out.push({ events: [a], vars: { within_s: secs(c.within_ms), expected: describe(c.expect), pattern: actionToken(a) } });
  });
  return out;
}

function evalOutlier(c: Extract<RuleCondition, { type: "outlier" }>, ctx: EvalContext): RuleMatch[] {
  const zMin = c.z ?? 3.5;
  const out: RuleMatch[] = [];
  if (c.metric === "inter_event_gap") {
    const ev = ctx.data.events;
    const gaps: Array<{ ms: number; a: AEvent; b: AEvent }> = [];
    for (let i = 1; i < ev.length; i++) {
      const ms = (ev[i] as AEvent).timestamp - (ev[i - 1] as AEvent).timestamp;
      if (ms >= 0) gaps.push({ ms, a: ev[i - 1] as AEvent, b: ev[i] as AEvent });
    }
    if (gaps.length < (c.min_samples ?? 12)) return [];
    const sample = gaps.map((g) => g.ms);
    const floor = c.min_ms ?? 10_000;
    for (const g of gaps) {
      const z = robustZ(g.ms, sample);
      if (z >= zMin && g.ms >= floor) {
        out.push({ events: [g.a, g.b], vars: { gap_s: secs(g.ms), z: Math.round(z * 10) / 10, metric: "inter_event_gap" } });
      }
    }
    return out;
  }
  // segment_duration: this session's segments vs. the same workflow in the cohort.
  const byId = new Map(ctx.data.events.map((e) => [e.event_id, e]));
  for (const s of ctx.segments) {
    if (s.workflow === "UNKNOWN") continue;
    const baseline = ctx.cohort.flatMap((o) => o.segments.filter((x) => x.workflow === s.workflow).map((x) => x.duration_ms));
    if (baseline.length < (c.min_samples ?? 4)) continue;
    const z = robustZ(s.duration_ms, baseline);
    if (Math.abs(z) >= zMin && Math.abs(s.duration_ms - median(baseline)) >= (c.min_ms ?? 2000)) {
      const events = [s.event_ids[0], s.event_ids[s.event_ids.length - 1]]
        .map((id) => (id ? byId.get(id) : undefined))
        .filter((e): e is AEvent => e !== undefined);
      out.push({
        events: [...new Set(events)],
        workflow: s.workflow,
        vars: { duration_s: secs(s.duration_ms), z: Math.round(z * 10) / 10, metric: "segment_duration", workflow: s.workflow, count: baseline.length },
        context: { segment_id: s.segment_id, baseline_median_ms: median(baseline), baseline_samples: baseline.length },
      });
    }
  }
  return out;
}

function evalDataQuality(c: Extract<RuleCondition, { type: "data_quality" }>, ctx: EvalContext): RuleMatch[] {
  const ev = ctx.data.events;
  if (ev.length === 0) return [];
  switch (c.check) {
    case "seq_gap": {
      const border: AEvent[] = [];
      let gaps = 0;
      let missing = 0;
      for (let i = 1; i < ev.length; i++) {
        const d = (ev[i] as AEvent).seq - (ev[i - 1] as AEvent).seq;
        if (d > 1) {
          gaps += 1;
          missing += d - 1;
          border.push(ev[i - 1] as AEvent, ev[i] as AEvent);
        }
      }
      return gaps ? [{ events: border.slice(0, 50), vars: { count: gaps }, context: { missing_seq_numbers: missing } }] : [];
    }
    case "ts_regression": {
      const hits: AEvent[] = [];
      for (let i = 1; i < ev.length; i++) {
        if ((ev[i] as AEvent).timestamp < (ev[i - 1] as AEvent).timestamp - 1000) hits.push(ev[i - 1] as AEvent, ev[i] as AEvent);
      }
      return hits.length ? [{ events: hits.slice(0, 50), vars: { count: hits.length / 2 } }] : [];
    }
    case "quarantined": {
      const q = ev.filter((e) => e.quarantined);
      return q.length ? [{ events: q.slice(0, 50), vars: { count: q.length } }] : [];
    }
    case "unterminated": {
      const ended = ctx.data.session.endedAt !== undefined || ev.some((e) => e.action === "session_end");
      return ended ? [] : [{ events: [ev[ev.length - 1] as AEvent], vars: { count: ev.length } }];
    }
  }
}

function transitionEvents(ctx: EvalContext): Map<string, AEvent[]> {
  const byId = new Map(ctx.data.events.map((e) => [e.event_id, e]));
  const out = new Map<string, AEvent[]>();
  const perTab = new Map<number | null, Segment[]>();
  for (const s of ctx.segments) if (s.workflow !== "UNKNOWN") perTab.set(s.tab_id, [...(perTab.get(s.tab_id) ?? []), s]);
  for (const list of perTab.values()) {
    for (let i = 1; i < list.length; i++) {
      const from = list[i - 1] as Segment;
      const to = list[i] as Segment;
      if (from.workflow === to.workflow) continue;
      const ev = to.event_ids[0] ? byId.get(to.event_ids[0]) : undefined;
      if (!ev) continue;
      const key = `${from.workflow}→${to.workflow}`;
      out.set(key, [...(out.get(key) ?? []), ev]);
    }
  }
  return out;
}

function evalCrossSession(c: Extract<RuleCondition, { type: "cross_session" }>, ctx: EvalContext): RuleMatch[] {
  const total = ctx.cohort.length + 1;
  if (ctx.cohort.length === 0 || total < (c.min_cohort ?? 2)) return [];
  const qualifies = (withIt: number) =>
    withIt >= c.min_sessions && withIt / total >= (c.min_share ?? 0) && withIt / total <= (c.max_share ?? 1);

  // Candidate patterns in the subject session, each with the events that realised it.
  const candidates = new Map<string, AEvent[]>();
  let presentIn: (sessionIdx: number, pattern: string) => boolean;
  if (c.pattern === "workflow_bigram") {
    for (const [bigram, events] of transitionEvents(ctx)) candidates.set(bigram, events);
    const sets = ctx.cohort.map((o) => workflowBigrams(o.sequence));
    presentIn = (i, p) => (sets[i] as Set<string>).has(p);
  } else {
    const tokens = ctx.data.events.filter((e) => USER_ACTIONS.has(e.action));
    for (let i = 2; i < tokens.length; i++) {
      const tri = [tokens[i - 2], tokens[i - 1], tokens[i]].map((e) => actionToken(e as AEvent)).join(" → ");
      if (!candidates.has(tri)) candidates.set(tri, [tokens[i - 2], tokens[i - 1], tokens[i]] as AEvent[]);
    }
    const sets = ctx.cohort.map((o) => actionTrigrams(o.data));
    presentIn = (i, p) => (sets[i] as Set<string>).has(p);
  }

  // One aggregated match per session (avoids one near-identical finding per pattern).
  const hits: Array<{ pattern: string; sessions_with: number; related: string[]; events: AEvent[] }> = [];
  for (const [pattern, events] of candidates) {
    const related = ctx.cohort.filter((_, i) => presentIn(i, pattern)).map((o) => o.session_id);
    const withIt = related.length + 1;
    if (qualifies(withIt)) hits.push({ pattern, sessions_with: withIt, related, events });
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => b.sessions_with - a.sessions_with || a.pattern.localeCompare(b.pattern));
  const listed = hits.map((h) => `${h.pattern} (${h.sessions_with}/${total})`).join(", ");
  const firstTo = hits[0]?.pattern.split("→")[1]?.trim();
  return [
    {
      events: hits.flatMap((h) => h.events).slice(0, 50),
      ...(c.pattern === "workflow_bigram" && hits.length === 1 && firstTo ? { workflow: firstTo as WorkflowLabel } : {}),
      vars: {
        count: hits.length,
        pattern: listed.length > 240 ? `${listed.slice(0, 237)}...` : listed,
        sessions_with: Math.max(...hits.map((h) => h.sessions_with)),
        sessions_total: total,
      },
      context: {
        patterns: hits.map((h) => ({ pattern: h.pattern, sessions_with: h.sessions_with, related_session_ids: h.related })),
        related_session_ids: [...new Set(hits.flatMap((h) => h.related))],
      },
    },
  ];
}

export function evaluateRule(rule: AnalysisRule, ctx: EvalContext): RuleMatch[] {
  const c = rule.when;
  switch (c.type) {
    case "sequence":
      return evalSequence(c, ctx);
    case "repetition":
      return evalRepetition(c, ctx);
    case "repeated_sequence":
      return evalRepeatedSequence(c, ctx);
    case "gap":
      return evalGap(c, ctx);
    case "duration":
      return evalDuration(c, ctx);
    case "count":
      return evalCount(c, ctx);
    case "rate":
      return evalRate(c, ctx);
    case "absence":
      return evalAbsence(c, ctx);
    case "outlier":
      return evalOutlier(c, ctx);
    case "data_quality":
      return evalDataQuality(c, ctx);
    case "cross_session":
      return evalCrossSession(c, ctx);
  }
}
