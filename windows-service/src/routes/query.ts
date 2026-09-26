/**
 * Read-only query routes for the dashboard (ADR-0006): overview statistics,
 * cross-session event search, single events, replay runs. Same pipeline as
 * every /v1 route (host → origin → token → rate limit).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Store } from "../db/store.ts";
import { EVENT_CATEGORIES, EVENT_KINDS, RUN_STATUSES, SEVERITIES, isWorkflowLabel } from "../shared.ts";
import { HttpError, send } from "../http.ts";
import { ID_RE, boundedIntParam, enumParam, idParam, intParam, searchParam } from "./params.ts";

export interface QueryRouteCtx {
  store: Store;
}

function workflowParam(url: URL): string | undefined {
  const w = url.searchParams.get("workflow");
  if (w === null || w === "") return undefined;
  if (!isWorkflowLabel(w)) throw new HttpError(400, "invalid_workflow");
  return w;
}

/** Returns the status sent, or undefined when the path is not a query route. */
export async function routeQuery(
  ctx: QueryRouteCtx,
  method: string,
  path: string,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<number | undefined> {
  if (method !== "GET") return undefined;
  const { store } = ctx;

  // GET /v1/stats?from=&to=&tz=
  if (path === "/v1/stats") {
    send(res, 200, {
      ...store.stats({ from: intParam(url, "from"), to: intParam(url, "to"), tzOffsetMin: boundedIntParam(url, "tz", -840, 840) }),
      generated_at: Date.now(),
    });
    return 200;
  }

  // GET /v1/events?session=&kind=&workflow=&severity=&category=&q=&from=&to=&order=&limit=&offset=
  if (path === "/v1/events") {
    send(
      res,
      200,
      store.queryEvents({
        sessionId: idParam(url, "session"),
        kind: enumParam(url, "kind", EVENT_KINDS),
        workflow: workflowParam(url),
        severity: enumParam(url, "severity", SEVERITIES),
        category: enumParam(url, "category", EVENT_CATEGORIES),
        q: searchParam(url),
        from: intParam(url, "from"),
        to: intParam(url, "to"),
        order: enumParam(url, "order", ["asc", "desc"] as const),
        limit: intParam(url, "limit"),
        offset: intParam(url, "offset"),
      }),
    );
    return 200;
  }

  // GET /v1/events/:id
  const evMatch = /^\/v1\/events\/([^/]+)$/.exec(path);
  if (evMatch) {
    const id = decodeURIComponent(evMatch[1] as string);
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid_id");
    const [event] = store.getEventsByIds([id]);
    if (!event) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    send(res, 200, { event });
    return 200;
  }

  // GET /v1/runs?status=&workflow=&limit=&offset=
  if (path === "/v1/runs") {
    const workflow = url.searchParams.get("workflow") ?? undefined;
    if (workflow !== undefined && workflow.length > 128) throw new HttpError(400, "invalid_workflow");
    send(
      res,
      200,
      store.listRuns({
        status: enumParam(url, "status", RUN_STATUSES),
        workflow: workflow || undefined,
        limit: intParam(url, "limit"),
        offset: intParam(url, "offset"),
      }),
    );
    return 200;
  }

  return undefined;
}
