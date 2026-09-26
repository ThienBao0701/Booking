/**
 * GET /v1/reports/sessions/:id?format=json|csv|html|print&table=findings|events|evidence&compare=<id>&download=1
 * Same pipeline as every /v1 route (host → origin → token → rate limit).
 * HTML reports carry their own CSP (no scripts; hash-allowed stylesheet only).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Store } from "../db/store.ts";
import type { AnalysisService } from "../analysis/service.ts";
import { REPORT_CSV_TABLES, REPORT_FORMATS } from "../shared.ts";
import { HttpError, send } from "../http.ts";
import { REPORT_CSP, ReportError, buildReport, renderReport, reportFileName } from "../reports/index.ts";
import { ID_RE, enumParam, idParam } from "./params.ts";

export interface ReportRouteCtx {
  store: Store;
  analysis: AnalysisService;
}

export async function routeReports(ctx: ReportRouteCtx, method: string, path: string, url: URL, _req: IncomingMessage, res: ServerResponse): Promise<number | undefined> {
  const m = /^\/v1\/reports\/sessions\/([^/]+)$/.exec(path);
  if (method !== "GET" || !m) return undefined;
  const id = decodeURIComponent(m[1] as string);
  if (!ID_RE.test(id)) throw new HttpError(400, "invalid_id");
  const format = enumParam(url, "format", REPORT_FORMATS) ?? "json";
  const table = enumParam(url, "table", REPORT_CSV_TABLES) ?? "findings";
  const compare = idParam(url, "compare");
  const download = url.searchParams.get("download") === "1";

  let report;
  try {
    report = buildReport(ctx.store, ctx.analysis, id, { compare });
  } catch (err) {
    if (err instanceof ReportError) throw new HttpError(err.code === "compare_not_found" ? 404 : 400, err.code);
    throw err;
  }
  if (!report) {
    send(res, 404, { error: "not_found" });
    return 404;
  }
  const out = renderReport(report, format, table);
  const headers: Record<string, string> = {
    "content-type": out.contentType,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "x-report-digest": `sha256:${report.integrity.digest}`,
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${reportFileName(id, format, table, report.generated_at, out.extension)}"`,
  };
  if (format === "html" || format === "print") {
    Object.assign(headers, {
      "content-security-policy": `${REPORT_CSP}; frame-ancestors 'none'`,
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
  }
  res.writeHead(200, headers);
  res.end(out.body);
  return 200;
}
