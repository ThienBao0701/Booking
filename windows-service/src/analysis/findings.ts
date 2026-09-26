/**
 * Rule match → Finding. Evidence extraction, template rendering, confidence,
 * counter-evidence and deterministic ids. Every finding is validated
 * (structure + non-conclusive wording) before it leaves the analyzer.
 */

import { createHash } from "node:crypto";

import {
  type AnalysisRule,
  type EvidenceItem,
  type Finding,
  type WorkflowLabel,
  PLATFORM_CAVEAT,
  validateFinding,
} from "../shared.ts";
import { type AEvent, type SessionData, evidenceItem } from "./model.ts";
import type { RuleMatch } from "./rules/engine.ts";

export interface BuildContext {
  data: SessionData;
  /** Sessions analysed together (subject included). */
  cohortSize: number;
  /** In how many cohort sessions this rule matched (subject included). */
  ruleSessions: number;
  /** Total matches of this rule in the subject session (frequency). */
  frequency: number;
  rulesVersion: string;
  now: number;
}

const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER_RE, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : "n/a"));
}

/** Deterministic id: re-analysing the same data yields the same finding ids. */
export function findingId(ruleId: string, sessionId: string, eventIds: readonly string[]): string {
  return `fnd_${createHash("sha256").update(`${ruleId}\u0000${sessionId}\u0000${eventIds.join(",")}`).digest("hex").slice(0, 20)}`;
}

function dominantWorkflow(events: readonly AEvent[]): WorkflowLabel {
  const counts = new Map<WorkflowLabel, number>();
  for (const e of events) if (e.workflow !== "UNKNOWN") counts.set(e.workflow, (counts.get(e.workflow) ?? 0) + 1);
  let best: WorkflowLabel = "UNKNOWN";
  let n = 0;
  for (const [w, c] of counts) if (c > n) [best, n] = [w, c];
  return best;
}

function dataQualityInRange(data: SessionData, firstSeq: number, lastSeq: number): { quarantined: number; gaps: number } {
  let quarantined = 0;
  let gaps = 0;
  let prev: AEvent | undefined;
  for (const e of data.events) {
    if (e.seq < firstSeq || e.seq > lastSeq) {
      prev = e;
      continue;
    }
    if (e.quarantined) quarantined += 1;
    if (prev && e.seq - prev.seq > 1 && prev.seq >= firstSeq) gaps += 1;
    prev = e;
  }
  return { quarantined, gaps };
}

export function buildFinding(rule: AnalysisRule, match: RuleMatch, ctx: BuildContext): Finding | { error: string } {
  const triggers = [...new Map(match.events.map((e) => [e.event_id, e])).values()].sort((a, b) => a.seq - b.seq);
  if (triggers.length === 0) return { error: `${rule.id}: match without events` };
  const first = triggers[0] as AEvent;
  const last = triggers[triggers.length - 1] as AEvent;
  const sid = ctx.data.session.sessionId;
  const workflow = match.workflow ?? dominantWorkflow(triggers);

  const vars: Record<string, string | number> = {
    count: triggers.length,
    session_id: sid,
    rule_id: rule.id,
    workflow,
    first_seq: first.seq,
    last_seq: last.seq,
    ...match.vars,
  };

  // Evidence: the triggering events + one context event on either side.
  const all = ctx.data.events;
  const firstIdx = all.findIndex((e) => e.event_id === first.event_id);
  const lastIdx = all.findIndex((e) => e.event_id === last.event_id);
  const evidence: EvidenceItem[] = [];
  const before = firstIdx > 0 ? all[firstIdx - 1] : undefined;
  if (before) evidence.push(evidenceItem(before, "context"));
  for (const e of triggers) evidence.push(evidenceItem(e, "trigger"));
  const after = lastIdx >= 0 ? all[lastIdx + 1] : undefined;
  if (after && !triggers.includes(after)) evidence.push(evidenceItem(after, "context"));

  // Confidence: base, adjusted for data quality, sample size and recurrence; never 1.
  const dq = dataQualityInRange(ctx.data, first.seq, last.seq);
  let confidence = rule.confidence;
  if (dq.quarantined > 0 || dq.gaps > 0) confidence -= 0.2;
  if (all.length < 10) confidence -= 0.1;
  if (ctx.frequency >= 3) confidence += 0.05;
  confidence = Math.round(Math.min(0.95, Math.max(0.05, confidence)) * 100) / 100;

  // Counter-evidence: rule-specific hints + generated bounds; the platform caveat is always last.
  const counter: string[] = (rule.counter_evidence ?? []).map((t) => render(t, vars));
  if (ctx.cohortSize > 1) {
    counter.push(
      `This rule matched in ${ctx.ruleSessions} of ${ctx.cohortSize} analysed sessions${ctx.ruleSessions / ctx.cohortSize >= 0.5 ? "; the pattern is common in this data set, not unusual" : ""}.`,
    );
  } else {
    counter.push("Only one session was analysed; there is no baseline to tell whether this pattern is unusual.");
  }
  const target = ctx.data.session.target.kind;
  if (target === "mock") counter.push("Recorded against the local mock Extranet: no external platform was involved.");
  else counter.push("Recorded passively in the operator's own browser: the data contains client-side events only.");
  if (dq.quarantined > 0 || dq.gaps > 0) {
    counter.push(`Within this range ${dq.quarantined} event(s) were quarantined and ${dq.gaps} sequence gap(s) exist; the observed sequence may be incomplete.`);
  }
  if (all.length < 10) counter.push(`The session contains only ${all.length} events; small samples are easily skewed.`);
  counter.push(PLATFORM_CAVEAT);

  const eventIds = triggers.map((e) => e.event_id);
  const finding: Finding = {
    finding_id: findingId(rule.id, sid, eventIds),
    session_id: sid,
    workflow,
    event_ids: eventIds,
    // Ordered by seq; timestamps may regress (clock changes), so take the true bounds.
    timestamp_range: { start: Math.min(...triggers.map((e) => e.timestamp)), end: Math.max(...triggers.map((e) => e.timestamp)) },
    rule_id: rule.id,
    category: rule.category,
    severity: rule.severity,
    title: render(rule.title, vars),
    description: render(rule.description, vars),
    evidence,
    confidence,
    counter_evidence: counter,
    recommended_next_test: render(rule.recommended_next_test, vars),
    frequency: Math.max(1, ctx.frequency),
    context: {
      ...match.context,
      rules_version: ctx.rulesVersion,
      rule_version: rule.version,
      cohort_size: ctx.cohortSize,
      rule_sessions: ctx.ruleSessions,
      target_kind: target,
      mode: ctx.data.session.mode,
    },
    possible_explanation: render(rule.possible_explanation, vars),
    created_at: ctx.now,
  };
  const v = validateFinding(finding);
  return v.ok ? v.value : { error: `${rule.id}: generated finding rejected — ${v.errors.join("; ")}` };
}
