/**
 * Localhost HTTP API (Component 2/13). Middleware order: host-check →
 * origin-check → (health bypasses auth) → auth → rate-limit → route.
 * All responses are JSON. Bodies are size-limited.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

import type { ServiceConfig } from "./config.ts";
import type { Store } from "./db/store.ts";
import type { EventBus } from "./eventbus.ts";
import type { Logger } from "./logger.ts";
import { parseBearer, verifyToken, tokenId } from "./auth.ts";
import { isHostAllowed, isOriginAllowed, RateLimiter } from "./security.ts";
import {
  type LabEvent,
  newPrefixedId,
  validateEventBatch,
  fromLabEvent,
  isLoopbackUrl,
  isWorkflowLabel,
  DEFAULT_SAFETY_MODE,
  CONTRACT_VERSION,
  LAB_VERSION,
} from "./shared.ts";
import { recordingToWorkflow } from "./automation/convert.ts";
import { HttpError, MAX_BODY_BYTES, readBody, send } from "./http.ts";
import { AnalysisService } from "./analysis/service.ts";
import { routeAnalysis } from "./routes/analysis.ts";
import { routeQuery } from "./routes/query.ts";
import { routeReports } from "./routes/reports.ts";
import { routeScreenshots } from "./routes/screenshots.ts";
import { routeReplay } from "./routes/replay.ts";
import { WorkflowLibrary } from "./automation/library.ts";
import { type ControllerFactory, ReplayManager } from "./automation/manager.ts";
import { MockExtranetController } from "./automation/mock-controller.ts";
import { BrowserAdapterController, PlaywrightAdapter } from "./automation/browser/index.ts";
import { join } from "node:path";
import { ScreenshotService } from "./screenshots/service.ts";
import { serveDashboard } from "./routes/dashboard.ts";
import { intParam, searchParam } from "./routes/params.ts";

/** Max events accepted per POST /v1/events (request validation; bridge batches below this). */
export const MAX_BATCH_EVENTS = 500;
const START_TS = Date.now();

export interface Ctx {
  config: ServiceConfig;
  store: Store;
  bus: EventBus;
  logger: Logger;
  limiter: RateLimiter;
  /** Workflow analyzer (Phase 8). Created on demand when not supplied. */
  analysis?: AnalysisService;
  /** Screenshot storage (Phase 12). Created on demand (disabled by default). */
  screenshots?: ScreenshotService;
  /** Phase 15: where the configuration came from ("recovered" after a bad config file). */
  configStatus?: "ok" | "recovered";
  /** Dashboard replays (Phase 13). Created on demand. */
  replay?: ReplayManager;
  library?: WorkflowLibrary;
}

/** Controllers for dashboard replays: the mock page model, or Chromium behind its browser policy. */
export const defaultControllerFactory: ControllerFactory = ({ kind, policy }) => {
  if (kind === "mock") return new MockExtranetController();
  if (!policy) throw new Error("browser controller requires an allowlist policy");
  return new BrowserAdapterController({ adapter: new PlaywrightAdapter(), policy, executablePath: process.env.LAB_BROWSER_EXECUTABLE || undefined });
};

export function createApiServer(ctx: Ctx): Server {
  const { config, store, bus, logger, limiter } = ctx;
  const analysis = ctx.analysis ?? new AnalysisService({ store, dataDir: config.dataDir });
  const screenshots = ctx.screenshots ?? new ScreenshotService({ store, dataDir: config.dataDir });
  const replay =
    ctx.replay ??
    new ReplayManager({
      serviceMode: () => config.safetyMode,
      controllerFactory: defaultControllerFactory,
      persist: (r) => store.saveRun(r),
      onScreenshot: (s) => void screenshots.storeReplay({ runId: s.runId, stepId: s.stepId, workflow: s.workflow, data: s.data }),
    });
  const library = ctx.library ?? new WorkflowLibrary({ libraryDir: config.workflowsDir ?? join(config.dataDir, "workflows") });
  const routeCtx = { ...ctx, analysis, screenshots, replay, library };

  const server = createServer((req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);
    const path = url.pathname;

    const done = (status: number, extra: Record<string, unknown> = {}) => {
      logger.info("request", {
        method,
        path,
        status,
        ms: Date.now() - started,
        ...extra,
      });
    };

    // 1) Host-header validation (anti DNS-rebinding).
    if (!isHostAllowed({ hostHeader: req.headers.host, expectedHost: config.host, expectedPort: config.port })) {
      send(res, 403, { error: "forbidden_host" });
      return done(403, { reason: "host" });
    }

    // 2) Origin validation. The service's own origin (the dashboard it serves,
    //    ADR-0006) is derived from the Host header validated above.
    const origin = req.headers.origin;
    const selfOrigin = `http://${String(req.headers.host).trim()}`;
    if (!isOriginAllowed({ origin, allowedOrigins: config.allowedOrigins, selfOrigin })) {
      send(res, 403, { error: "forbidden_origin" });
      return done(403, { reason: "origin" });
    }

    // 2b) Static dashboard files (no data; the API below still needs the token).
    if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/dashboard" || path.startsWith("/dashboard/"))) {
      if (!limiter.allow(`static:${path === "/" ? "/" : "/dashboard"}`)) {
        send(res, 429, { error: "rate_limited" });
        return done(429);
      }
      return done(serveDashboard(config.dashboardDir, method, path, res));
    }

    // 3) Health check bypasses auth (watchdog liveness).
    if (method === "GET" && path === "/healthz") {
      send(res, 200, {
        status: "ok",
        uptimeMs: Date.now() - START_TS,
        schemaVersion: store.getMeta("schema_version") ?? null,
        safetyMode: config.safetyMode,
        busSubscribers: bus.size,
        config: ctx.configStatus ?? "ok",
      });
      return done(200);
    }

    // 4) Auth.
    const token = parseBearer(req.headers.authorization);
    if (!verifyToken(token, config.authToken)) {
      send(res, 401, { error: "unauthorized" });
      return done(401);
    }
    const tid = tokenId(config.authToken);

    // 5) Rate limit (per token+route).
    if (!limiter.allow(`${tid}:${method}:${path}`)) {
      send(res, 429, { error: "rate_limited" });
      return done(429);
    }

    // 6) Routes.
    void route(routeCtx, method, path, url, req, res).then(done).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.code });
        return done(err.status);
      }
      logger.error("route_error", { path, error: String(err) });
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      done(500);
    });
  });
  // A manager created here belongs to this server: stop its runs (and any browser) with it.
  if (!ctx.replay) server.on("close", () => void replay.shutdown());
  return server;
}

async function route(
  ctx: Ctx & { analysis: AnalysisService; screenshots: ScreenshotService; replay: ReplayManager; library: WorkflowLibrary },
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number> {
  const { store, bus } = ctx;

  // POST /v1/sessions
  if (method === "POST" && path === "/v1/sessions") {
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : newPrefixedId("session");
    const mode = typeof body.mode === "string" ? body.mode : DEFAULT_SAFETY_MODE;
    const target = (body.target as { kind?: string; host?: string }) ?? { kind: "observe" };
    // Idempotent: a bridge reconnect may re-register the same session id.
    const created = store.createSession({
      id: sessionId,
      startedAt: typeof body.startedAt === "number" ? body.startedAt : Date.now(),
      mode,
      targetKind: target.kind ?? "observe",
      ...(target.host ? { targetHost: target.host } : {}),
      metadata: (body.metadata as Record<string, unknown>) ?? {},
    });
    if (created) bus.publish({ type: "session.start", payload: { sessionId } });
    const status = created ? 201 : 200;
    send(res, status, { sessionId, created });
    return status;
  }

  // GET /v1/bridge/handshake — authenticated capability/contract check for the
  // extension bridge (verifies token + contract compatibility in one call).
  if (method === "GET" && path === "/v1/bridge/handshake") {
    send(res, 200, {
      service: "lab-service",
      labVersion: LAB_VERSION,
      contractVersion: CONTRACT_VERSION,
      safetyMode: ctx.config.safetyMode,
      maxBatchEvents: MAX_BATCH_EVENTS,
      maxBodyBytes: MAX_BODY_BYTES,
      // Phase 12: whether the extension should upload screenshot images.
      screenshots: { enabled: ctx.screenshots.settings.enabled, maxImageBytes: ctx.screenshots.settings.maxImageBytes },
    });
    return 200;
  }

  // POST /v1/sessions/:id/end
  const endMatch = /^\/v1\/sessions\/([^/]+)\/end$/.exec(path);
  if (method === "POST" && endMatch) {
    const id = decodeURIComponent(endMatch[1] as string);
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    // A bridge that was offline delivers the end late; honour the client's end
    // time (bounded: finite and not in the future) so the timeline stays accurate.
    const now = Date.now();
    const endedAt =
      typeof body.endedAt === "number" && Number.isFinite(body.endedAt) && body.endedAt <= now + 60_000
        ? Math.floor(body.endedAt)
        : now;
    const ok = store.endSession(id, endedAt);
    if (!ok) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    bus.publish({ type: "session.end", payload: { sessionId: id } });
    send(res, 200, { ended: true });
    return 200;
  }

  // GET /v1/sessions?from=&to=&q=&workflow=&limit=&offset= — summaries, newest first
  if (method === "GET" && path === "/v1/sessions") {
    const workflow = url.searchParams.get("workflow") ?? "";
    if (workflow !== "" && !isWorkflowLabel(workflow)) throw new HttpError(400, "invalid_workflow");
    const out = store.listSessionSummaries({
      from: intParam(url, "from"),
      to: intParam(url, "to"),
      q: searchParam(url),
      workflow: workflow || undefined,
      limit: intParam(url, "limit"),
      offset: intParam(url, "offset"),
    });
    send(res, 200, out);
    return 200;
  }

  // GET /v1/sessions/:id
  const getMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
  if (method === "GET" && getMatch) {
    const id = decodeURIComponent(getMatch[1] as string);
    const s = store.getSession(id);
    if (!s) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    send(res, 200, { session: s, eventCount: store.countEvents(id) });
    return 200;
  }

  // GET /v1/sessions/:id/workflow?baseUrl=&name= — replayable draft of a recording
  const wfMatch = /^\/v1\/sessions\/([^/]+)\/workflow$/.exec(path);
  if (method === "GET" && wfMatch) {
    const id = decodeURIComponent(wfMatch[1] as string);
    if (!store.hasSession(id)) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    const baseUrl = url.searchParams.get("baseUrl") ?? "http://127.0.0.1:4599";
    if (!isLoopbackUrl(baseUrl)) {
      // Drafts always target the local mock; retargeting to an authorized system
      // is a deliberate operator edit (kind "authorized" + authorization record).
      send(res, 400, { error: "draft_target_must_be_local_mock" });
      return 400;
    }
    const events = store.getLabEvents(id).map(fromLabEvent);
    const draft = recordingToWorkflow(events, {
      workflow: url.searchParams.get("name") ?? `replay-${id}`,
      target: { kind: "mock", baseUrl },
    });
    send(res, 200, draft);
    return 200;
  }

  // GET /v1/runs/:id — persisted replay run record
  const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
  if (method === "GET" && runMatch) {
    const run = store.getRun(decodeURIComponent(runMatch[1] as string));
    if (!run) {
      send(res, 404, { error: "not_found" });
      return 404;
    }
    send(res, 200, { run });
    return 200;
  }

  // GET /v1/sessions/:id/events
  const evMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(path);
  if (method === "GET" && evMatch) {
    const id = decodeURIComponent(evMatch[1] as string);
    send(res, 200, { events: store.getEvents(id) });
    return 200;
  }

  // POST /v1/events  { events: [...] }
  if (method === "POST" && path === "/v1/events") {
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    if (Array.isArray(body.events) && body.events.length > MAX_BATCH_EVENTS) {
      send(res, 413, { error: "batch_too_large", maxBatchEvents: MAX_BATCH_EVENTS });
      return 413;
    }
    const { valid, invalid } = validateEventBatch(body.events);
    const rawEvents = Array.isArray(body.events) ? (body.events as unknown[]) : [];
    const idAt = (index: number): string | undefined => {
      const item = rawEvents[index] as { id?: unknown } | undefined;
      return item && typeof item.id === "string" ? item.id : undefined;
    };
    const invalidDetail: Array<{ index: number; id?: string; code?: string; errors: string[] }> = invalid.map(
      (i) => {
        const id = idAt(i.index);
        return { ...i, ...(id !== undefined ? { id } : {}), code: "INVALID_EVENT" };
      },
    );

    // Events for a session the service does not know are reported (not a 500),
    // so the bridge can re-register the session and resend just those events.
    const known = new Map<string, boolean>();
    const accepted: LabEvent[] = [];
    valid.forEach((ev) => {
      let k = known.get(ev.sessionId);
      if (k === undefined) {
        k = store.hasSession(ev.sessionId);
        known.set(ev.sessionId, k);
      }
      if (k) accepted.push(ev);
      else {
        invalidDetail.push({
          index: rawEvents.indexOf(ev),
          id: ev.id,
          code: "UNKNOWN_SESSION",
          errors: [`unknown session ${ev.sessionId}`],
        });
      }
    });

    let stored = 0;
    let quarantined = 0;
    let duplicates = 0;
    const published: LabEvent[] = [];
    // One transaction per batch: atomic and a single disk sync.
    store.transaction(() => {
      for (const ev of accepted) {
        const outcome = store.insertEvent(ev);
        if (outcome === "duplicate") duplicates += 1;
        else {
          if (outcome === "quarantined") quarantined += 1;
          else stored += 1;
          published.push(ev);
        }
      }
    });
    for (const ev of published) bus.publish({ type: "event", payload: ev });
    send(res, 202, { stored, quarantined, duplicates, invalid: invalidDetail.length, invalidDetail });
    return 202;
  }

  // Analysis, findings and rule configuration (Phase 8).
  const handled = await routeAnalysis(ctx, method, path, url, req, res);
  if (handled !== undefined) return handled;

  // Dashboard read queries (Phase 9).
  const queried = await routeQuery(ctx, method, path, url, req, res);
  if (queried !== undefined) return queried;

  // Dashboard replays (Phase 13).
  const replayed = await routeReplay({ ...ctx, serviceMode: () => ctx.config.safetyMode }, method, path, url, req, res);
  if (replayed !== undefined) return replayed;

  // Screenshot storage (Phase 12).
  const shot = await routeScreenshots(ctx, method, path, url, req, res);
  if (shot !== undefined) return shot;

  // Forensic reports (Phase 10).
  const reported = await routeReports(ctx, method, path, url, req, res);
  if (reported !== undefined) return reported;

  send(res, 404, { error: "not_found" });
  return 404;
}
