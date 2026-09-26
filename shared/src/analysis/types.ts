/**
 * Analysis contracts (Phase 8 / Component 6): findings, rule schema and the
 * structured outputs of the workflow analyzer. Shared by the service
 * (analyzer, API, reports) and the dashboard.
 *
 * Findings are DIAGNOSTIC OBSERVATIONS about recorded events. They never assert
 * that any external platform took an action. `confidence` is the confidence
 * that the described pattern is present in the recorded data — it is not a
 * probability of any platform outcome (see docs/14-analysis.md).
 */

import type { EventKind, Severity } from "../events/types.ts";
import type { RecordedAction } from "../events/recorded.ts";
import type { WorkflowLabel } from "../workflow/types.ts";

export const FINDING_CATEGORIES = [
  "EVENT_SEQUENCE",
  "TIMING",
  "REPETITION",
  "NAVIGATION",
  "FORM_ACTIVITY",
  "DOM_CHANGE",
  "SESSION_CHANGE",
  "ERROR",
  "HTTP_STATUS",
  "WORKFLOW_TRANSITION",
  "ANOMALY",
  "DATA_QUALITY",
  "CORRELATION",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** One recorded event cited as evidence, with a human-readable summary. */
export interface EvidenceItem {
  event_id: string;
  seq: number;
  timestamp: number;
  kind: EventKind;
  action: RecordedAction;
  workflow: WorkflowLabel;
  page: string;
  /** e.g. "CLICK #res-submit (RESERVATION)". */
  summary: string;
  /** "trigger" = produced the finding; "context" = surrounding event. */
  role: "trigger" | "context";
}

export interface Finding {
  finding_id: string;
  session_id: string;
  workflow: WorkflowLabel;
  /** The exact recorded events that produced this finding (non-empty). */
  event_ids: string[];
  timestamp_range: { start: number; end: number };
  rule_id: string;
  category: FindingCategory;
  severity: Severity;
  /** Short name of the observed pattern (stored as `observed_pattern`). */
  title: string;
  description: string;
  evidence: EvidenceItem[];
  /** 0.05..0.95 — confidence the pattern is present in the data; never 1. */
  confidence: number;
  /** Observations that weaken or bound any interpretation (non-empty). */
  counter_evidence: string[];
  recommended_next_test: string;
  /** Component 6 fields. */
  frequency: number;
  context: Record<string, unknown>;
  possible_explanation: string;
  created_at: number;
}

// ---- rule schema (the JSON rule engine) ----

/** Declarative event matcher; every given field must match. */
export interface Matcher {
  kind?: EventKind | EventKind[];
  action?: RecordedAction | RecordedAction[];
  workflow?: WorkflowLabel | WorkflowLabel[];
  severity?: Severity | Severity[];
  /** Regex source tested against target selector / label / name. */
  target?: string;
  /** Regex source tested against the page path. */
  page?: string;
  /** Exact-match metadata fields. */
  metadata?: Record<string, string | number | boolean | null>;
}

export type RuleCondition =
  | { type: "sequence"; steps: Matcher[]; within_ms?: number; same_tab?: boolean }
  | { type: "repetition"; match: Matcher; min_count: number; within_ms?: number; consecutive?: boolean }
  | { type: "repeated_sequence"; min_length: number; max_length: number; min_count: number }
  | { type: "gap"; min_ms: number; after?: Matcher; before?: Matcher }
  | { type: "duration"; workflow?: WorkflowLabel | WorkflowLabel[]; min_ms?: number; max_ms?: number; min_events?: number }
  | { type: "count"; match: Matcher; min?: number; max?: number }
  | { type: "rate"; match: Matcher; window_ms: number; min_count: number }
  | { type: "absence"; after: Matcher; expect: Matcher; within_ms: number }
  | { type: "outlier"; metric: "inter_event_gap" | "segment_duration"; z?: number; min_samples?: number; min_ms?: number }
  | { type: "data_quality"; check: "seq_gap" | "ts_regression" | "quarantined" | "unterminated" }
  | {
      type: "cross_session";
      pattern: "workflow_bigram" | "action_trigram";
      /** Fire for patterns present in at least this many sessions (subject included). */
      min_sessions: number;
      min_share?: number;
      /** Fire for RARE patterns: share of sessions containing it at most this. */
      max_share?: number;
      /** Minimum analysed sessions (subject included) before the rule applies. */
      min_cohort?: number;
    };

export type RuleConditionType = RuleCondition["type"];

export const RULE_CONDITION_TYPES: readonly RuleConditionType[] = [
  "sequence",
  "repetition",
  "repeated_sequence",
  "gap",
  "duration",
  "count",
  "rate",
  "absence",
  "outlier",
  "data_quality",
  "cross_session",
];

export interface AnalysisRule {
  /** e.g. "SEQ-RESERVATION-CANCEL". */
  id: string;
  version: number;
  enabled?: boolean;
  category: FindingCategory;
  severity: Severity;
  /** Templates may use {{placeholders}} (see RULE_PLACEHOLDERS). */
  title: string;
  description: string;
  possible_explanation: string;
  recommended_next_test: string;
  counter_evidence?: string[];
  /** Base confidence 0.05..0.95 (adjusted by data quality / sample size / frequency). */
  confidence: number;
  when: RuleCondition;
}

export interface RuleSet {
  version: 1;
  rules: AnalysisRule[];
}

/** Placeholders the engine can fill in rule templates. */
export const RULE_PLACEHOLDERS = [
  "count",
  "within_s",
  "window_s",
  "gap_s",
  "duration_s",
  "threshold_s",
  "workflow",
  "session_id",
  "first_seq",
  "last_seq",
  "rule_id",
  "pattern",
  "expected",
  "metric",
  "z",
  "sessions_with",
  "sessions_total",
  "length",
] as const;

// ---- structured analyzer outputs ----

export interface Segment {
  segment_id: string;
  session_id: string;
  workflow: WorkflowLabel;
  tab_id: number | null;
  start_ts: number;
  end_ts: number;
  /** Time until the next segment in the same tab started (or last event). */
  duration_ms: number;
  first_seq: number;
  last_seq: number;
  event_count: number;
  event_ids: string[];
  actions: Record<string, number>;
}

export interface DistributionStats {
  count: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}

export interface TimingSummary {
  session_duration_ms: number;
  event_count: number;
  events_per_minute: number;
  inter_event_gap_ms: DistributionStats;
  workflow_duration_ms: Partial<Record<WorkflowLabel, number>>;
  longest_gaps: Array<{ ms: number; before_event_id: string; after_event_id: string }>;
}

export interface RepeatedSequence {
  tokens: string[];
  count: number;
  occurrences: string[][];
}

export interface GraphNode {
  id: WorkflowLabel;
  segments: number;
  total_ms: number;
  sessions: number;
}

export interface GraphEdge {
  from: WorkflowLabel;
  to: WorkflowLabel;
  count: number;
  avg_ms: number;
  /** Transition events that realised this edge (capped), with their session. */
  samples: Array<{ session_id: string; event_id: string }>;
}

export interface WorkflowGraph {
  session_ids: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface EnvironmentReport {
  session_id: string;
  captured: boolean;
  browser?: string;
  browser_major?: number;
  platform?: string;
  language?: string;
  timezone?: string;
  timezone_offset_min?: number;
  viewport?: { width: number; height: number };
  screen?: { width: number; height: number };
  device_pixel_ratio?: number;
  color_scheme?: string;
  hardware_concurrency?: number;
  extension_version?: string;
  session_duration_ms: number;
  source_event_ids: string[];
}

export interface SessionComparison {
  a: string;
  b: string;
  similarity: number;
  workflow_sequence: {
    a: WorkflowLabel[];
    b: WorkflowLabel[];
    common: WorkflowLabel[];
    only_a: WorkflowLabel[];
    only_b: WorkflowLabel[];
  };
  workflows: Array<{
    workflow: WorkflowLabel;
    a_ms: number | null;
    b_ms: number | null;
    delta_ms: number | null;
    ratio: number | null;
  }>;
  counts: { a_events: number; b_events: number; a_errors: number; b_errors: number };
  timing: { a_median_gap_ms: number; b_median_gap_ms: number };
  actions: { jaccard: number; only_a: string[]; only_b: string[] };
  environment_differences: Array<{ field: string; a: unknown; b: unknown }>;
  notes: string[];
}

export interface AnalysisResult {
  session_id: string;
  analyzed_at: number;
  cohort_session_ids: string[];
  rules_version: string;
  event_count: number;
  segments: Segment[];
  workflow_sequence: WorkflowLabel[];
  timing: TimingSummary;
  repeated_sequences: RepeatedSequence[];
  graph: WorkflowGraph;
  environment: EnvironmentReport;
  findings: Finding[];
  data_quality: { quarantined: number; seq_gaps: number; ts_regressions: number; terminated: boolean };
  /** Rules that failed to evaluate or findings rejected by validation (never silent). */
  warnings: string[];
}
