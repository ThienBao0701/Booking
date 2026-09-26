/**
 * Workflow-analysis orchestrator (Phase 8). Pure and deterministic given the
 * same events, rules and clock: segmentation → timing → repeated sequences →
 * environment → rule evaluation (with cohort) → validated findings.
 */

import { createHash } from "node:crypto";

import type {
  AnalysisResult,
  Finding,
  RuleSet,
  SessionComparison,
  WorkflowGraph,
  WorkflowLabel,
  Segment,
  TimingSummary,
  EnvironmentReport,
} from "../shared.ts";
import type { SessionData } from "./model.ts";
import { repeatedSequences, segmentSession, timingSummary, workflowGraph, workflowSequence } from "./segment.ts";
import { compareSessions, extractEnvironment } from "./compare.ts";
import { type EvalContext, MAX_MATCHES_PER_RULE, type RuleMatch, evaluateRule } from "./rules/engine.ts";
import { buildFinding } from "./findings.ts";

export interface AnalyzeOptions {
  rules: RuleSet;
  now?: () => number;
}

interface Prepared {
  session_id: string;
  data: SessionData;
  segments: Segment[];
  sequence: WorkflowLabel[];
  timing: TimingSummary;
  environment: EnvironmentReport;
}

export function rulesVersion(rules: RuleSet): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 12);
}

function prepare(data: SessionData): Prepared {
  const segments = segmentSession(data);
  const timing = timingSummary(data, segments);
  return {
    session_id: data.session.sessionId,
    data,
    segments,
    sequence: workflowSequence(segments),
    timing,
    environment: extractEnvironment(data, timing.session_duration_ms),
  };
}

function dataQuality(data: SessionData): AnalysisResult["data_quality"] {
  let seqGaps = 0;
  let regressions = 0;
  const ev = data.events;
  for (let i = 1; i < ev.length; i++) {
    const a = ev[i - 1];
    const b = ev[i];
    if (!a || !b) continue;
    if (b.seq - a.seq > 1) seqGaps += 1;
    if (b.timestamp < a.timestamp - 1000) regressions += 1;
  }
  return {
    quarantined: ev.filter((e) => e.quarantined).length,
    seq_gaps: seqGaps,
    ts_regressions: regressions,
    terminated: data.session.endedAt !== undefined || ev.some((e) => e.action === "session_end"),
  };
}

/**
 * Analyse every session of a cohort. Each session's findings are computed with
 * the rest of the cohort as baseline (outliers) and comparison set
 * (cross-session correlation).
 */
export function analyzeCohort(sessions: readonly SessionData[], opts: AnalyzeOptions): Map<string, AnalysisResult> {
  const now = (opts.now ?? Date.now)();
  const version = rulesVersion(opts.rules);
  const prepared = sessions.map(prepare);
  const rules = opts.rules.rules.filter((r) => r.enabled !== false);

  // 1. Raw matches per session per rule (needed first for cross-session prevalence).
  const matchesBy = new Map<string, Map<string, RuleMatch[]>>();
  const warnings = new Map<string, string[]>();
  for (const p of prepared) {
    const ctx: EvalContext = {
      data: p.data,
      segments: p.segments,
      sequence: p.sequence,
      cohort: prepared.filter((o) => o !== p).map((o) => ({ session_id: o.session_id, data: o.data, segments: o.segments, sequence: o.sequence })),
    };
    const perRule = new Map<string, RuleMatch[]>();
    const warn: string[] = [];
    for (const rule of rules) {
      try {
        perRule.set(rule.id, evaluateRule(rule, ctx));
      } catch (err) {
        warn.push(`${rule.id}: evaluation failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    matchesBy.set(p.session_id, perRule);
    warnings.set(p.session_id, warn);
  }
  const prevalence = new Map<string, number>();
  for (const perRule of matchesBy.values()) {
    for (const [ruleId, m] of perRule) if (m.length > 0) prevalence.set(ruleId, (prevalence.get(ruleId) ?? 0) + 1);
  }

  // 2. Findings + structured outputs.
  const results = new Map<string, AnalysisResult>();
  for (const p of prepared) {
    const perRule = matchesBy.get(p.session_id) as Map<string, RuleMatch[]>;
    const warn = warnings.get(p.session_id) as string[];
    const findings: Finding[] = [];
    for (const rule of rules) {
      const all = perRule.get(rule.id) ?? [];
      if (all.length > MAX_MATCHES_PER_RULE) warn.push(`${rule.id}: ${all.length} matches, first ${MAX_MATCHES_PER_RULE} reported`);
      for (const m of all.slice(0, MAX_MATCHES_PER_RULE)) {
        const f = buildFinding(rule, m, {
          data: p.data,
          cohortSize: prepared.length,
          ruleSessions: prevalence.get(rule.id) ?? 1,
          frequency: all.length,
          rulesVersion: version,
          now,
        });
        if ("error" in f) warn.push(f.error);
        else findings.push(f);
      }
    }
    const unique = [...new Map(findings.map((f) => [f.finding_id, f])).values()].sort(
      (a, b) => a.timestamp_range.start - b.timestamp_range.start || a.rule_id.localeCompare(b.rule_id),
    );
    results.set(p.session_id, {
      session_id: p.session_id,
      analyzed_at: now,
      cohort_session_ids: prepared.map((o) => o.session_id),
      rules_version: version,
      event_count: p.data.events.length,
      segments: p.segments,
      workflow_sequence: p.sequence,
      timing: p.timing,
      repeated_sequences: repeatedSequences(p.data),
      graph: workflowGraph([{ session_id: p.session_id, segments: p.segments }]),
      environment: p.environment,
      findings: unique,
      data_quality: dataQuality(p.data),
      warnings: warn,
    });
  }
  return results;
}

export function analyzeSession(subject: SessionData, cohort: readonly SessionData[], opts: AnalyzeOptions): AnalysisResult {
  const others = cohort.filter((c) => c.session.sessionId !== subject.session.sessionId);
  return analyzeCohort([subject, ...others], opts).get(subject.session.sessionId) as AnalysisResult;
}

export function compare(a: SessionData, b: SessionData): SessionComparison {
  const pa = prepare(a);
  const pb = prepare(b);
  return compareSessions(pa, pb);
}

export function cohortGraph(sessions: readonly SessionData[]): WorkflowGraph {
  return workflowGraph(sessions.map((s) => ({ session_id: s.session.sessionId, segments: segmentSession(s) })));
}
