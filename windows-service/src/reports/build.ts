/**
 * Forensic report model (Phase 10): one JSON document per session, built from
 * the stored session and events, the analyzer, the persisted findings and a
 * baseline comparison. CSV and HTML are renderings of this document.
 *
 * Traceability: every finding keeps its exact `event_ids`; every event a
 * finding cites (trigger or context) is included in `timeline`, even when the
 * timeline is truncated; each timeline event lists the findings citing it.
 */

import { createHash } from "node:crypto";

import {
  ANALYSIS_DISCLAIMER,
  CONTRACT_VERSION,
  type Finding,
  type ForensicReport,
  LAB_VERSION,
  REPORT_VERSION,
  type ReportEvent,
} from "../shared.ts";
import type { Store } from "../db/store.ts";
import type { AnalysisService } from "../analysis/service.ts";
import { summarize } from "../analysis/model.ts";
import { fmtMs } from "./text.ts";

export interface BuildReportOptions {
  /** Baseline session for the comparative analysis (default: previous session). */
  compare?: string | undefined;
  now?: number;
  /** Timeline rows beyond this are omitted (cited events are always kept). */
  maxTimelineEvents?: number;
}

export class ReportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const SEVERITY_RANK: Record<string, number> = { error: 0, warn: 1, info: 2 };

function storedFindings(store: Store, sessionId: string): Finding[] {
  const out: Finding[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = store.listFindings({ sessionId, limit: 500, offset });
    out.push(...page.findings);
    if (out.length >= page.total || page.findings.length === 0) break;
  }
  return out;
}

/** Report digest: sha256 over the JSON of the report without `integrity`. */
export function reportDigest(report: Omit<ForensicReport, "integrity"> | ForensicReport): string {
  const { integrity: _omit, ...rest } = report as ForensicReport;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

export function buildReport(store: Store, analysis: AnalysisService, sessionId: string, opts: BuildReportOptions = {}): ForensicReport | undefined {
  const session = store.getSession(sessionId);
  const data = analysis.sessionData(sessionId);
  const result = analysis.analyze(sessionId);
  if (!session || !data || !result) return undefined;
  const now = opts.now ?? Date.now();

  // Findings: the persisted set when present (what the dashboard links to), else computed now.
  const stored = storedFindings(store, sessionId);
  const findingsSource: ForensicReport["findings_source"] = stored.length > 0 ? "stored" : "computed";
  const findings = (stored.length > 0 ? stored : result.findings)
    .slice()
    .sort((a, b) => a.timestamp_range.start - b.timestamp_range.start || a.rule_id.localeCompare(b.rule_id) || a.finding_id.localeCompare(b.finding_id));
  const analyzedAt = stored.length > 0 ? Math.max(...stored.map((f) => f.created_at)) : result.analyzed_at;

  // Timeline with back-links; cited events always included.
  const citedBy = new Map<string, Set<string>>();
  for (const f of findings) {
    for (const id of [...f.event_ids, ...f.evidence.map((e) => e.event_id)]) {
      const set = citedBy.get(id) ?? new Set<string>();
      set.add(f.finding_id);
      citedBy.set(id, set);
    }
  }
  const max = Math.max(1, opts.maxTimelineEvents ?? 5000);
  const included = data.events.filter((e, i) => i < max || citedBy.has(e.event_id));
  const events: ReportEvent[] = included.map((e) => ({
    event_id: e.event_id,
    seq: e.seq,
    timestamp: e.timestamp,
    tab_id: e.tab_id,
    kind: e.kind,
    category: e.category,
    workflow: e.workflow,
    severity: e.severity,
    action: e.action,
    summary: summarize(e),
    quarantined: e.quarantined,
    cited_by: [...(citedBy.get(e.event_id) ?? [])].sort(),
  }));

  // Comparative analysis: explicit baseline, else the previous session, else the most recent other.
  let basis: ForensicReport["comparative_analysis"]["basis"] = "none";
  let baseline: string | null = null;
  if (opts.compare !== undefined) {
    if (opts.compare === sessionId) throw new ReportError("compare_is_same_session");
    if (!store.hasSession(opts.compare)) throw new ReportError("compare_not_found");
    basis = "explicit";
    baseline = opts.compare;
  } else {
    const others = store.listSessions(200).filter((s) => s.id !== sessionId);
    const previous = others.find((s) => s.startedAt <= session.startedAt);
    if (previous) {
      basis = "previous_session";
      baseline = previous.id;
    } else if (others[0]) {
      basis = "most_recent_other";
      baseline = others[0].id;
    }
  }
  const comparison = baseline ? (analysis.compare(sessionId, baseline) ?? null) : null;
  const prevalence = new Map<string, { rule_id: string; sessions_with: number; cohort_size: number }>();
  for (const f of findings) {
    const sessionsWith = Number(f.context.rule_sessions ?? 1);
    const cohortSize = Number(f.context.cohort_size ?? 1);
    if (!prevalence.has(f.rule_id)) prevalence.set(f.rule_id, { rule_id: f.rule_id, sessions_with: sessionsWith, cohort_size: cohortSize });
  }
  const compNotes: string[] = [];
  if (!comparison) compNotes.push("No other recorded session is available, so no baseline comparison was made.");
  else compNotes.push(`Baseline: ${baseline} (${basis === "explicit" ? "chosen explicitly" : basis === "previous_session" ? "the session recorded before this one" : "the most recent other session"}). Differences describe the two recordings, not their causes.`);
  if (findingsSource === "stored" && result.rules_version !== String(findings[0]?.context.rules_version ?? result.rules_version)) {
    compNotes.push("Stored findings were produced with an earlier rule set; re-run the analysis to refresh them.");
  }

  // Executive summary.
  const bySeverity: Record<string, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const key = findings
    .slice()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || b.confidence - a.confidence || a.finding_id.localeCompare(b.finding_id))
    .slice(0, 5)
    .map((f) => ({ finding_id: f.finding_id, title: f.title, severity: f.severity, confidence: f.confidence, event_ids: f.event_ids }));
  const dq = result.data_quality;
  const statements = [
    `The session lasted ${fmtMs(result.timing.session_duration_ms)} and recorded ${result.event_count} event(s)${result.workflow_sequence.length ? ` across the workflow sequence ${result.workflow_sequence.join(" → ")}` : " with no workflow detected"}.`,
    `${findings.length} finding(s) were produced by ${new Set(findings.map((f) => f.rule_id)).size} rule(s): ${bySeverity.error ?? 0} error, ${bySeverity.warn ?? 0} warn, ${bySeverity.info ?? 0} info.`,
    dq.quarantined || dq.seq_gaps || dq.ts_regressions || !dq.terminated
      ? `Recording quality: ${dq.quarantined} quarantined event(s), ${dq.seq_gaps} sequence gap(s), ${dq.ts_regressions} timestamp regression(s); session ${dq.terminated ? "terminated normally" : "was not terminated"}. Findings near these points are less certain.`
      : "Recording quality: no quarantined events, sequence gaps or timestamp regressions were detected, and the session terminated normally.",
    session.target.kind === "mock"
      ? "The session was recorded against the local mock Extranet; no external platform was involved."
      : "The session was recorded passively in the operator's own browser; the data contains client-side events only.",
    "Each finding lists the exact event ids that produced it; confidence expresses how clearly a pattern is present in the recorded data.",
  ];

  const tabs = [...new Set(data.events.map((e) => e.tab_id).filter((t): t is number => t !== null))].sort((a, b) => a - b);
  const testGroups = new Map<string, string[]>();
  for (const f of findings) testGroups.set(f.recommended_next_test, [...(testGroups.get(f.recommended_next_test) ?? []), f.finding_id]);

  const report: Omit<ForensicReport, "integrity"> = {
    report_version: REPORT_VERSION,
    kind: "lab-forensic-report",
    generated_at: now,
    generator: { lab_version: LAB_VERSION, contract_version: CONTRACT_VERSION, rules_version: result.rules_version },
    disclaimer: ANALYSIS_DISCLAIMER,
    scope: {
      session_id: sessionId,
      target_kind: session.target.kind,
      target_host: session.target.host ?? null,
      mode: session.mode,
      statement: `This report covers one recorded session (${sessionId}) of the local diagnostics lab and the diagnostic findings derived from it.`,
    },
    findings_source: findingsSource,
    analyzed_at: analyzedAt,
    executive_summary: {
      duration_ms: result.timing.session_duration_ms,
      event_count: result.event_count,
      workflows_visited: [...new Set(result.workflow_sequence)],
      findings_total: findings.length,
      findings_by_severity: bySeverity,
      key_findings: key,
      data_quality: dq,
      statements,
    },
    session: {
      session_id: sessionId,
      started_at: session.startedAt,
      ended_at: session.endedAt ?? null,
      mode: session.mode,
      target: { kind: session.target.kind, host: session.target.host ?? null },
      event_count: data.events.length,
      tabs,
    },
    environment: result.environment,
    timeline: { total_events: data.events.length, included_events: events.length, truncated: events.length < data.events.length, events },
    workflow: { sequence: result.workflow_sequence, segments: result.segments, transitions: result.graph.edges, timing: result.timing },
    observed_sequences: { workflow_sequence: result.workflow_sequence, repeated_sequences: result.repeated_sequences },
    findings,
    evidence: findings.map((f) => ({ finding_id: f.finding_id, rule_id: f.rule_id, event_ids: f.event_ids, items: f.evidence })),
    counter_evidence: findings.map((f) => ({ finding_id: f.finding_id, items: f.counter_evidence })),
    comparative_analysis: {
      basis,
      baseline_session_id: baseline,
      comparison,
      cohort: { size: result.cohort_session_ids.length, session_ids: result.cohort_session_ids },
      rule_prevalence: [...prevalence.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id)),
      notes: compNotes,
    },
    recommended_next_tests: [...testGroups.entries()].map(([test, ids]) => ({ test, finding_ids: ids })),
  };
  return { ...report, integrity: { algorithm: "sha256", covers: "JSON of the report without `integrity`", digest: reportDigest(report) } };
}
