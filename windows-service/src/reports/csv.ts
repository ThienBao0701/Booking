/**
 * CSV exports of a forensic report (RFC 4180, CRLF, UTF-8 with BOM for
 * spreadsheet apps). Text cells that a spreadsheet would evaluate as a formula
 * (= + - @ TAB CR) are prefixed with an apostrophe (CSV-injection defence).
 */

import type { ForensicReport, ReportCsvTable } from "../shared.ts";
import { iso } from "./text.ts";

type Cell = string | number | boolean | null | undefined;

export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${guarded.replace(/"/g, '""')}"`;
}

function toCsv(header: string[], rows: Cell[][]): string {
  return `﻿${[header.map(csvCell), ...rows.map((r) => r.map(csvCell))].map((r) => r.join(",")).join("\r\n")}\r\n`;
}

export function reportCsv(report: ForensicReport, table: ReportCsvTable): string {
  switch (table) {
    case "findings":
      return toCsv(
        ["finding_id", "session_id", "rule_id", "category", "severity", "workflow", "title", "description", "confidence", "frequency", "start_utc", "end_utc", "event_ids", "evidence_items", "counter_evidence", "recommended_next_test", "possible_explanation"],
        report.findings.map((f) => [
          f.finding_id,
          f.session_id,
          f.rule_id,
          f.category,
          f.severity,
          f.workflow,
          f.title,
          f.description,
          f.confidence,
          f.frequency,
          iso(f.timestamp_range.start),
          iso(f.timestamp_range.end),
          f.event_ids.join(" "),
          f.evidence.length,
          f.counter_evidence.join(" | "),
          f.recommended_next_test,
          f.possible_explanation,
        ]),
      );
    case "events":
      return toCsv(
        ["event_id", "session_id", "seq", "timestamp_utc", "timestamp_ms", "tab_id", "kind", "category", "workflow", "severity", "action", "summary", "quarantined", "cited_by_findings"],
        report.timeline.events.map((e) => [
          e.event_id,
          report.session.session_id,
          e.seq,
          iso(e.timestamp),
          e.timestamp,
          e.tab_id,
          e.kind,
          e.category,
          e.workflow,
          e.severity,
          e.action,
          e.summary,
          e.quarantined,
          e.cited_by.join(" "),
        ]),
      );
    case "evidence":
      return toCsv(
        ["finding_id", "rule_id", "role", "event_id", "seq", "timestamp_utc", "kind", "action", "workflow", "summary"],
        report.evidence.flatMap((ev) => ev.items.map((i) => [ev.finding_id, ev.rule_id, i.role, i.event_id, i.seq, iso(i.timestamp), i.kind, i.action, i.workflow, i.summary])),
      );
  }
}
