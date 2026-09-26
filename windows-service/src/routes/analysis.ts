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

export interface AnalysisRouteCtx {
  store: Store;
  analysis: AnalysisService;
}

/** Max sessions accepted in one run / graph request. */
export const MAX_ANALYSIS_SESSIONS = 200;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function sessionIdList(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = typeof raw === "string" ? raw.split(",").filter((s) => s.length > 0) : raw;
  if (!Array.isArray(list)) throw new HttpError(400, `${field}_must_be_list`);
  if (list.length > MAX_ANALYSIS_SESSIONS) throw new HttpError(400, `${field}_too_many`);
  for (const id of list) if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(400, `${field}_invalid_id`);
  return [...new Set(list as string[])];
}

function intParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new HttpError(400, `invalid_${name}`);
  return n;
}

function enumParam(url: URL, name: string, allowed: readonly string[]): string | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (!allowed.includes(v)) throw new HttpError(400, `invalid_${name}`);
  return v;
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

  // POST /v1/analysis/run  { sessionIds?: string[] } — analyse + persist findings
  if (method === "POST" && path === "/v1/analysis/run") {
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body");
    const ids = sessionIdList(body.sessionIds, "sessionIds");
    send(res, 200, analysis.run(ids));
    return 200;
  }

  // GET /v1/analysis/compare?a=&b=
  if (method === "GET" && path === "/v1/analysis/compare") {
    const a = url.searchParams.get("a") ?? "";
    const b = url.searchParams.get("b") ?? "";
    if (!ID_RE.test(a) || !ID_RE.test(b)) throw new HttpError(400, "a_and_b_required");
    const cmp = analysis.compare(a, b);
    if (!cmp) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    send(res, 200, cmp);
    return 200;
  }

  // GET /v1/analysis/graph?sessions=a,b — workflow transition graph
  if (method === "GET" && path === "/v1/analysis/graph") {
    const ids = sessionIdList(url.searchParams.get("sessions") ?? undefined, "sessions");
    send(res, 200, analysis.graph(ids));
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
    send(res, 200, { finding, events, missing_event_ids: cited.filter((id) => !found.has(id)) });
    return 200;
  }

  return undefined;
}
