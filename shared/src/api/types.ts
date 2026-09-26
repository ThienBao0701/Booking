/**
 * Read-API response contracts (Phases 8–9, ADR-0006). The service produces
 * these shapes and the dashboard consumes them; both import them from here so
 * there is one definition. Wire events inside are stored rows of the `events`
 * table (redacted at rest; `data` is the JSON payload as a string).
 */

import type { Finding, RuleSet } from "../analysis/types.ts";

export interface StoredEventRow {
  id: string;
  session_id: string;
  seq: number;
  ts: number;
  tab_id: number | null;
  kind: string;
  category: string;
  workflow: string | null;
  severity: string;
  redacted: number;
  data: string;
}

export interface SessionSummary {
  id: string;
  startedAt: number;
  endedAt: number | null;
  mode: string;
  targetKind: string;
  targetHost: string | null;
  eventCount: number;
  errorCount: number;
  findingCount: number;
}

export interface LabStats {
  sessions: number;
  events: number;
  findings: number;
  runs: number;
  events_by_kind: Record<string, number>;
  events_by_workflow: Record<string, number>;
  events_by_severity: Record<string, number>;
  findings_by_severity: Record<string, number>;
  findings_by_category: Record<string, number>;
  runs_by_status: Record<string, number>;
  events_by_day: Array<{ day: string; count: number }>;
}

/** One replay run without step detail (GET /v1/runs). */
export interface ReplayRunSummary {
  runId: string;
  workflow: string;
  mode: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  dryRun: boolean;
  sourceSessionId: string | null;
  targetKind: string | null;
  steps: { total: number; ok: number; failed: number };
}

/** POST /v1/analysis/run */
export interface AnalysisRunSummary {
  sessions: number;
  findings: number;
  rules_version: string;
  warnings: string[];
}

/** GET /v1/analysis/rules */
export interface RulesInfo {
  source: "default" | "custom";
  version: string;
  error: string | null;
  rules: RuleSet;
}

/** GET /v1/findings/:id */
export interface FindingDetail {
  finding: Finding;
  events: StoredEventRow[];
  missing_event_ids: string[];
}

/** Stored screenshot image (Phase 12). The image bytes are served separately. */
export interface ScreenshotRecord {
  id: string;
  session_id: string | null;
  /** The SCREENSHOT event the image belongs to (extension captures). */
  event_id: string | null;
  /** Replay screenshots: the run and step that captured it. */
  run_id: string | null;
  step_id: string | null;
  source: "extension" | "replay";
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  mime: "image/png";
  /** Capture time (the event's timestamp for extension captures). */
  ts: number;
  workflow: string | null;
  created_at: number;
}

/** Privacy controls for screenshot storage. Disabled unless explicitly enabled. */
export interface ScreenshotSettings {
  enabled: boolean;
  /** Images older than this are deleted by the retention sweep. */
  retentionDays: number;
  /** Largest accepted PNG. */
  maxImageBytes: number;
  /** Total storage budget; uploads beyond it are refused. */
  maxTotalBytes: number;
}

export interface ScreenshotUsage {
  count: number;
  bytes: number;
  files: number;
  oldest: number | null;
}
