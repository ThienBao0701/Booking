/**
 * Analysis API (Phase 8). Runs behind the same host/origin/auth/rate-limit
 * pipeline as every other /v1 route (server.ts). Read endpoints never mutate;
 * only POST /v1/analysis/run persists findings and PUT/DELETE rules change the
 * rule configuration (validated fail-closed, docs/14-analysis.md).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Store } from "../db/store.ts";
import type { AnalysisService } from "../analysis/service.ts";
import { FINDING_CATEGORIES, SEVERITIES, isWorkflowLabel } from "../shared.ts";
import { HttpError, readBody, send } from "../http.ts";
import { comparisonCsv, comparisonFileName, comparisonJson } from "../analysis/compare-export.ts";
import { ID_RE, enumParam, intParam, sessionIdList } from "./params.ts";

export { MAX_ANALYSIS_SESSIONS } from "./params.ts";

export interface AnalysisRouteCtx {
  store: Store;
  analysis: AnalysisService;
}

/** Returns the status sent, or undefined when the path is not an analysis route. */
export async function routeAnalysis(
  ctx: AnalysisRouteCtx,
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | undefined> {
  const { store, analysis } = ctx;

  // GET /v1/sessions/:id/analysis — full analysis of one session (not persisted)
  const anMatch = /^\/v1\/sessions\/([^/]+)\/analysis$/.exec(path);
  if (method === "GET" && anMatch) {
    const result = analysis.analyze(decodeURIComponent(anMatch[1] as string));
    if (!result) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    send(res, 200, result);
    return 200;
  }

  // POST /v1/analysis/run  { sessionIds?: string[] } | { stale: true } — analyse + persist findings
  if (method === "POST" && path === "/v1/analysis/run") {
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body");
    if (body.stale !== undefined) {
      if (body.stale !== true || body.sessionIds !== undefined) throw new HttpError(400, "invalid_stale");
      send(res, 200, analysis.runStale());
      return 200;
    }
    const ids = sessionIdList(body.sessionIds, "sessionIds");
    send(res, 200, analysis.run(ids));
    return 200;
  }

  // GET /v1/analysis/status?sessions=a,b — are stored findings current? (rule version, time, staleness)
  if (method === "GET" && path === "/v1/analysis/status") {
    const ids = sessionIdList(url.searchParams.get("sessions") ?? undefined, "sessions");
    send(res, 200, analysis.status(ids));
    return 200;
  }

  // GET /v1/analysis/compare?a=&b=[&format=json|csv&download=1] — comparison, or its export
  if (method === "GET" && path === "/v1/analysis/compare") {
    const a = url.searchParams.get("a") ?? "";
    const b = url.searchParams.get("b") ?? "";
    if (!ID_RE.test(a) || !ID_RE.test(b)) throw new HttpError(400, "a_and_b_required");
    const format = enumParam(url, "format", ["json", "csv"] as const);
    const cmp = analysis.compare(a, b);
    if (!cmp) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    if (!format) {
      send(res, 200, cmp);
      return 200;
    }
    const body = format === "csv" ? comparisonCsv(cmp) : `${JSON.stringify(comparisonJson(cmp, Date.now()), null, 2)}\n`;
    res.writeHead(200, {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-disposition": `${url.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${comparisonFileName(a, b, format)}"`,
    });
    res.end(body);
    return 200;
  }

  // GET /v1/analysis/graph?sessions=a,b — workflow transition graph
  if (method === "GET" && path === "/v1/analysis/graph") {
    const ids = sessionIdList(url.searchParams.get("sessions") ?? undefined, "sessions");
    send(res, 200, analysis.graph(ids));
    return 200;
  }

  // GET /v1/analysis/environment?sessions=a,b — environment reports (derived from events)
  if (method === "GET" && path === "/v1/analysis/environment") {
    const ids = sessionIdList(url.searchParams.get("sessions") ?? undefined, "sessions");
    send(res, 200, { environments: analysis.environments(ids) });
    return 200;
  }

  // GET/PUT/DELETE /v1/analysis/rules — rule configuration
  if (path === "/v1/analysis/rules") {
    if (method === "GET") {
      send(res, 200, analysis.rulesInfo());
      return 200;
    }
    if (method === "PUT") {
      const v = analysis.setRules(await readBody(req));
      if (!v.ok) {
        send(res, 400, { error: "invalid_rules", errors: v.errors.slice(0, 50) });
        return 400;
      }
      const info = analysis.rulesInfo();
      send(res, 200, { source: info.source, version: info.version, rules: v.value.rules.length });
      return 200;
    }
    if (method === "DELETE") {
      analysis.resetRules();
      const info = analysis.rulesInfo();
      send(res, 200, { source: info.source, version: info.version });
      return 200;
    }
  }

  // GET /v1/findings — persisted findings with filters + paging
  if (method === "GET" && path === "/v1/findings") {
    const workflow = url.searchParams.get("workflow") ?? undefined;
    if (workflow !== undefined && workflow !== "" && !isWorkflowLabel(workflow)) throw new HttpError(400, "invalid_workflow");
    const session = url.searchParams.get("session") ?? undefined;
    if (session !== undefined && session !== "" && !ID_RE.test(session)) throw new HttpError(400, "invalid_session");
    const rule = url.searchParams.get("rule") ?? undefined;
    if (rule !== undefined && rule !== "" && !ID_RE.test(rule)) throw new HttpError(400, "invalid_rule");
    const q = url.searchParams.get("q") ?? undefined;
    if (q !== undefined && q.length > 200) throw new HttpError(400, "invalid_q");
    const out = store.listFindings({
      sessionId: session || undefined,
      workflow: workflow || undefined,
      severity: enumParam(url, "severity", SEVERITIES),
      ruleId: rule || undefined,
      category: enumParam(url, "category", FINDING_CATEGORIES),
      q: q || undefined,
      from: intParam(url, "from"),
      to: intParam(url, "to"),
      limit: intParam(url, "limit"),
      offset: intParam(url, "offset"),
    });
    send(res, 200, out);
    return 200;
  }

  // GET /v1/findings/:id — one finding + the exact events it cites
  const fMatch = /^\/v1\/findings\/([^/]+)$/.exec(path);
  if (method === "GET" && fMatch) {
    const finding = store.getFinding(decodeURIComponent(fMatch[1] as string));
    if (!finding) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    const cited = [...new Set([...finding.event_ids, ...finding.evidence.map((e) => e.event_id)])];
    const events = store.getEventsByIds(cited);
    const found = new Set(events.map((e) => e.id));
    const provenance = analysis.status([finding.session_id]).sessions[0];
    send(res, 200, { finding, events, missing_event_ids: cited.filter((id) => !found.has(id)), ...(provenance ? { analysis: provenance } : {}) });
    return 200;
  }

  return undefined;
}
