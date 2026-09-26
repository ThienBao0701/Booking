/**
 * Dashboard replay API (Phase 13). Same pipeline as every /v1 route.
 *
 *   GET    /v1/replay/workflows                 library (bundled examples + operator dir)
 *   GET    /v1/replay/workflows/:id             one workflow + example params
 *   POST   /v1/replay/prepare                   dry-run plan + single-use confirmation token
 *   GET    /v1/replay/runs                      managed runs
 *   GET    /v1/replay/runs/:id?since=<logSeq>   status, progress, logs
 *   POST   /v1/replay/runs/:id/start            { confirmToken, acknowledge: true }
 *   POST   /v1/replay/runs/:id/{pause|resume|stop|step|retry|checkpoint|rollback}
 *   DELETE /v1/replay/runs/:id                  discard a prepared run
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Store } from "../db/store.ts";
import { type SafetyMode, fromLabEvent, isLoopbackUrl, isSafetyMode } from "../shared.ts";
import { HttpError, readBody, send } from "../http.ts";
import type { WorkflowLibrary } from "../automation/library.ts";
import { type ControllerKind, type ReplayManager, ReplayManagerError } from "../automation/manager.ts";
import { recordingToWorkflow } from "../automation/convert.ts";
import { ID_RE, intParam } from "./params.ts";

export interface ReplayRouteCtx {
  store: Store;
  replay: ReplayManager;
  library: WorkflowLibrary;
  serviceMode: () => SafetyMode;
}

const ACTIONS = new Set(["pause", "resume", "stop", "step", "retry", "checkpoint", "rollback"]);

function strings(v: unknown, field: string, max: number, maxLen = 300): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && x.length <= maxLen)) throw new HttpError(400, `invalid_${field}`);
  return v as string[];
}

function params(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "invalid_params");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 100) throw new HttpError(400, "invalid_params");
  for (const [k, val] of entries) {
    if (!/^[\w.-]{1,64}$/.test(k) || typeof val !== "string" || val.length > 2000) throw new HttpError(400, "invalid_params");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export async function routeReplay(ctx: ReplayRouteCtx, method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<number | undefined> {
  if (!path.startsWith("/v1/replay/")) return undefined;
  const { replay, library, store } = ctx;
  try {
    if (method === "GET" && path === "/v1/replay/workflows") {
      send(res, 200, { workflows: library.list(), serviceMode: ctx.serviceMode() });
      return 200;
    }
    const wf = /^\/v1\/replay\/workflows\/([^/]+)$/.exec(path);
    if (method === "GET" && wf) {
      const got = library.get(decodeURIComponent(wf[1] as string));
      if (!got) {
        send(res, 404, { error: "not_found" });
        return 404;
      }
      send(res, 200, got);
      return 200;
    }

    if (method === "POST" && path === "/v1/replay/prepare") {
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body");
      const mode = body.mode ?? "SIMULATE";
      if (!isSafetyMode(mode)) throw new HttpError(400, "invalid_mode");
      const controller = body.controller ?? "mock";
      if (controller !== "mock" && controller !== "browser") throw new HttpError(400, "invalid_controller");
      let workflow: unknown;
      let source: string;
      let sourceSessionId: string | undefined;
      if (typeof body.workflowId === "string") {
        const got = library.get(body.workflowId);
        if (!got) throw new HttpError(404, "workflow_not_found");
        workflow = got.workflow;
        source = body.workflowId;
      } else if (typeof body.sessionId === "string") {
        if (!ID_RE.test(body.sessionId) || !store.hasSession(body.sessionId)) throw new HttpError(404, "session_not_found");
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "http://127.0.0.1:4599";
        if (!isLoopbackUrl(baseUrl)) throw new HttpError(400, "draft_target_must_be_local_mock");
        workflow = recordingToWorkflow(store.getLabEvents(body.sessionId).map(fromLabEvent), { workflow: `replay-${body.sessionId}`, target: { kind: "mock", baseUrl } }).file;
        source = `recording:${body.sessionId}`;
        sourceSessionId = body.sessionId;
      } else if (body.workflow !== undefined) {
        workflow = body.workflow;
        source = "inline";
      } else throw new HttpError(400, "workflow_required");
      const out = await replay.prepare({
        workflow,
        source,
        mode,
        controller: controller as ControllerKind,
        allowOrigins: strings(body.allowOrigins, "allowOrigins", 50),
        resourceOrigins: strings(body.resourceOrigins, "resourceOrigins", 50),
        params: params(body.params),
        sourceSessionId,
      });
      send(res, 201, out);
      return 201;
    }

    if (method === "GET" && path === "/v1/replay/runs") {
      send(res, 200, { runs: replay.list(), serviceMode: ctx.serviceMode() });
      return 200;
    }
    const run = /^\/v1\/replay\/runs\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (run) {
      const id = decodeURIComponent(run[1] as string);
      if (!ID_RE.test(id)) throw new HttpError(400, "invalid_id");
      const action = run[2];
      if (method === "GET" && !action) {
        send(res, 200, replay.status(id, intParam(url, "since") ?? 0));
        return 200;
      }
      if (method === "DELETE" && !action) {
        replay.discard(id);
        send(res, 200, { discarded: true });
        return 200;
      }
      if (method === "POST" && action === "start") {
        const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
        send(res, 200, replay.start(id, { confirmToken: body.confirmToken, acknowledge: body.acknowledge }));
        return 200;
      }
      if (method === "POST" && action && ACTIONS.has(action)) {
        const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
        send(res, 200, await replay.control(id, action as "pause", { label: body.label, checkpointId: body.checkpointId }));
        return 200;
      }
    }
  } catch (err) {
    if (err instanceof ReplayManagerError) {
      send(res, err.status, { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      return err.status;
    }
    throw err;
  }
  return undefined;
}
