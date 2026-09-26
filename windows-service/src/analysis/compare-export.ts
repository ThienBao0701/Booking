/**
 * Session comparison export (diagnostics): JSON (the comparison plus export
 * provenance) and CSV (one row per compared item, RFC 4180, UTF-8 with BOM,
 * formula-injection guarded by the report CSV cell encoder).
 */

import { LAB_VERSION, type SessionComparison } from "../shared.ts";
import { csvCell } from "../reports/csv.ts";

export interface ComparisonExport {
  kind: "lab-session-comparison";
  format_version: 1;
  lab_version: string;
  exported_at: string;
  comparison: SessionComparison;
}

export function comparisonJson(c: SessionComparison, exportedAt: number): ComparisonExport {
  return { kind: "lab-session-comparison", format_version: 1, lab_version: LAB_VERSION, exported_at: new Date(exportedAt).toISOString(), comparison: c };
}

type Cell = string | number | null | undefined;

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function comparisonCsv(c: SessionComparison): string {
  const rows: Cell[][] = [
    ["summary", "session", c.a, c.b, null, ""],
    ["summary", "similarity", null, null, null, String(c.similarity)],
    ["summary", "events", c.counts.a_events, c.counts.b_events, c.counts.b_events - c.counts.a_events, ""],
    ["summary", "errors", c.counts.a_errors, c.counts.b_errors, c.counts.b_errors - c.counts.a_errors, ""],
    ["summary", "median_gap_ms", c.timing.a_median_gap_ms, c.timing.b_median_gap_ms, c.timing.b_median_gap_ms - c.timing.a_median_gap_ms, ""],
    ["workflow_sequence", "order", c.workflow_sequence.a.join(" > "), c.workflow_sequence.b.join(" > "), null, ""],
    ["workflow_sequence", "common", null, null, null, c.workflow_sequence.common.join(" > ")],
    ["workflow_sequence", "only_in", c.workflow_sequence.only_a.join(" | "), c.workflow_sequence.only_b.join(" | "), null, ""],
    ...c.workflows.map((w): Cell[] => ["workflow_time_ms", w.workflow, w.a_ms, w.b_ms, w.delta_ms, w.ratio === null ? "" : `ratio ${w.ratio}`]),
    ["actions", "jaccard", null, null, null, String(c.actions.jaccard)],
    ...c.actions.only_a.map((x): Cell[] => ["actions", "only_in_a", x, null, null, ""]),
    ...c.actions.only_b.map((x): Cell[] => ["actions", "only_in_b", null, x, null, ""]),
    ...c.environment_differences.map((d): Cell[] => ["environment", d.field, text(d.a), text(d.b), null, ""]),
    ...c.notes.map((n): Cell[] => ["note", "", null, null, null, n]),
  ];
  const header = ["section", "item", "a", "b", "delta_b_minus_a", "detail"];
  return `﻿${[header, ...rows].map((r) => r.map((v) => csvCell(v)).join(",")).join("\r\n")}\r\n`;
}

export function comparisonFileName(a: string, b: string, ext: "json" | "csv"): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
  return `lab-compare-${safe(a)}-vs-${safe(b)}.${ext}`;
}
