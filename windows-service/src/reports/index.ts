/** Forensic reports (Phase 10): JSON model + CSV / HTML / print renderings. */
import type { ForensicReport, ReportCsvTable, ReportFormat } from "../shared.ts";
import { reportCsv } from "./csv.ts";
import { reportHtml } from "./html.ts";

export { buildReport, reportDigest, ReportError, type BuildReportOptions } from "./build.ts";
export { reportCsv, csvCell } from "./csv.ts";
export { reportHtml, REPORT_CSP, REPORT_CSS, REPORT_STYLE_HASH, anchor, esc } from "./html.ts";

export interface RenderedReport {
  body: string;
  contentType: string;
  extension: string;
}

/** Render a built report in the requested format. */
export function renderReport(report: ForensicReport, format: ReportFormat, table: ReportCsvTable = "findings"): RenderedReport {
  switch (format) {
    case "json":
      return { body: `${JSON.stringify(report, null, 2)}\n`, contentType: "application/json; charset=utf-8", extension: "json" };
    case "csv":
      return { body: reportCsv(report, table), contentType: "text/csv; charset=utf-8", extension: "csv" };
    case "html":
      return { body: reportHtml(report), contentType: "text/html; charset=utf-8", extension: "html" };
    case "print":
      return { body: reportHtml(report, { print: true }), contentType: "text/html; charset=utf-8", extension: "print.html" };
  }
}

/** File name for downloads: lab-report_<session>[_<table>]_<YYYYMMDD>.<ext> (ASCII-safe). */
export function reportFileName(sessionId: string, format: ReportFormat, table: ReportCsvTable, now: number, extension: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  return `lab-report_${safe}${format === "csv" ? `_${table}` : ""}_${day}.${extension}`;
}
