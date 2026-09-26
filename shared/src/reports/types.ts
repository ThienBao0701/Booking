/**
 * Forensic report contract (Phase 10). One JSON document per session; the CSV
 * and HTML renderings are derived from it. Every finding carries the exact
 * event ids that produced it, and every cited event is present in `timeline`.
 */

import type {
  EnvironmentReport,
  EvidenceItem,
  Finding,
  GraphEdge,
  RepeatedSequence,
  Segment,
  SessionComparison,
  TimingSummary,
} from "../analysis/types.ts";
import type { WorkflowLabel } from "../workflow/types.ts";

export const REPORT_VERSION = 1;

export const REPORT_FORMATS = ["json", "csv", "html", "print"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_CSV_TABLES = ["findings", "events", "evidence"] as const;
export type ReportCsvTable = (typeof REPORT_CSV_TABLES)[number];

/** Report sections, in document order, with their display titles. */
export const REPORT_SECTIONS = [
  ["executive_summary", "Executive Summary"],
  ["session", "Session Information"],
  ["environment", "Environment"],
  ["timeline", "Timeline"],
  ["workflow", "Workflow"],
  ["observed_sequences", "Observed Sequences"],
  ["findings", "Findings"],
  ["evidence", "Evidence"],
  ["counter_evidence", "Counter-evidence"],
  ["comparative_analysis", "Comparative Analysis"],
  ["recommended_next_tests", "Recommended Next Test"],
] as const;
export type ReportSectionKey = (typeof REPORT_SECTIONS)[number][0];

export interface ReportEvent {
  event_id: string;
  seq: number;
  timestamp: number;
  tab_id: number | null;
  kind: string;
  category: string;
  workflow: WorkflowLabel;
  severity: string;
  action: string;
  summary: string;
  quarantined: boolean;
  /** Findings in this report that cite the event (trigger or context). */
  cited_by: string[];
}

export interface ForensicReport {
  report_version: typeof REPORT_VERSION;
  kind: "lab-forensic-report";
  generated_at: number;
  generator: { lab_version: string; contract_version: number; rules_version: string };
  disclaimer: string;
  scope: { session_id: string; target_kind: string; target_host: string | null; mode: string; statement: string };
  /** "stored": persisted findings (what the dashboard shows); "computed": analysed for this report. */
  findings_source: "stored" | "computed";
  analyzed_at: number;

  executive_summary: {
    duration_ms: number;
    event_count: number;
    workflows_visited: WorkflowLabel[];
    findings_total: number;
    findings_by_severity: Record<string, number>;
    key_findings: Array<{ finding_id: string; title: string; severity: string; confidence: number; event_ids: string[] }>;
    data_quality: { quarantined: number; seq_gaps: number; ts_regressions: number; terminated: boolean };
    statements: string[];
  };
  session: {
    session_id: string;
    started_at: number;
    ended_at: number | null;
    mode: string;
    target: { kind: string; host: string | null };
    event_count: number;
    tabs: number[];
  };
  environment: EnvironmentReport;
  timeline: {
    total_events: number;
    included_events: number;
    /** True when events were omitted; cited events are always included. */
    truncated: boolean;
    events: ReportEvent[];
  };
  workflow: {
    sequence: WorkflowLabel[];
    segments: Segment[];
    transitions: GraphEdge[];
    timing: TimingSummary;
  };
  observed_sequences: {
    workflow_sequence: WorkflowLabel[];
    repeated_sequences: RepeatedSequence[];
  };
  findings: Finding[];
  evidence: Array<{ finding_id: string; rule_id: string; event_ids: string[]; items: EvidenceItem[] }>;
  counter_evidence: Array<{ finding_id: string; items: string[] }>;
  comparative_analysis: {
    basis: "explicit" | "previous_session" | "most_recent_other" | "none";
    baseline_session_id: string | null;
    comparison: SessionComparison | null;
    cohort: { size: number; session_ids: string[] };
    rule_prevalence: Array<{ rule_id: string; sessions_with: number; cohort_size: number }>;
    notes: string[];
  };
  recommended_next_tests: Array<{ test: string; finding_ids: string[] }>;
  integrity: { algorithm: "sha256"; covers: "JSON of the report without `integrity`"; digest: string };
}
