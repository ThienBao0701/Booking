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
  DEFAULT_SAFETY_MODE,
  CONTRACT_VERSION,
  LAB_VERSION,
} from "./shared.ts";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB per request
/** Max events accepted per POST /v1/events (request validation; bridge batches below this). */
export const MAX_BATCH_EVENTS = 500;
const START_TS = Date.now();

interface Ctx {
  config: ServiceConfig;
  store: Store;
  bus: EventBus;
  logger: Logger;
  limiter: RateLimiter;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(json);
}

/** A client error with an HTTP status (request validation), never a 500. */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "payload_too_large"));
        req.resume(); // drain without buffering so the 413 can be sent
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return;
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

export function createApiServer(ctx: Ctx): Server {
  const { config, store, bus, logger, limiter } = ctx;

  return createServer((req, res) => {
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

    // 2) Origin validation.
    const origin = req.headers.origin;
    if (!isOriginAllowed({ origin, allowedOrigins: config.allowedOrigins })) {
      send(res, 403, { error: "forbidden_origin" });
      return done(403, { reason: "origin" });
    }

    // 3) Health check bypasses auth (watchdog liveness).
    if (method === "GET" && path === "/healthz") {
      send(res, 200, {
        status: "ok",
        uptimeMs: Date.now() - START_TS,
        schemaVersion: store.getMeta("schema_version") ?? null,
        safetyMode: config.safetyMode,
        busSubscribers: bus.size,
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
    void route(ctx, method, path, url, req, res).then(done).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.code });
        return done(err.status);
      }
      logger.error("route_error", { path, error: String(err) });
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      done(500);
    });
  });
}

async function route(
  ctx: Ctx,
  method: string,
  path: string,
  _url: URL,
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

  // GET /v1/sessions
  if (method === "GET" && path === "/v1/sessions") {
    send(res, 200, { sessions: store.listSessions() });
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

  send(res, 404, { error: "not_found" });
  return 404;
}
