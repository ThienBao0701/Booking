/**
 * Screenshot storage API (Phase 12). Same pipeline as every /v1 route.
 *
 *   GET    /v1/screenshots/settings          settings + usage
 *   PUT    /v1/screenshots/settings          enable/disable, retention, limits
 *   POST   /v1/screenshots                   { sessionId, eventId, sha256, dataBase64 } (extension capture)
 *   GET    /v1/screenshots?session=&run=&from=&to=&limit=&offset=
 *   GET    /v1/screenshots/:id               metadata
 *   GET    /v1/screenshots/:id/image         image/png
 *   DELETE /v1/screenshots/:id
 *   DELETE /v1/sessions/:id/screenshots
 *   POST   /v1/screenshots/retention         apply retention now
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Store } from "../db/store.ts";
import { HttpError, readBody, send } from "../http.ts";
import { ScreenshotError, type ScreenshotService } from "../screenshots/service.ts";
import { ID_RE, idParam, intParam } from "./params.ts";

export interface ScreenshotRouteCtx {
  store: Store;
  screenshots: ScreenshotService;
}

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
/** Absolute cap on an upload request body (base64 of the largest allowed image + JSON). */
const MAX_UPLOAD_BODY = 28 * 1024 * 1024;

function mapError(err: unknown): never {
  if (err instanceof ScreenshotError) throw new HttpError(err.status, err.code);
  throw err;
}

export async function routeScreenshots(ctx: ScreenshotRouteCtx, method: string, path: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<number | undefined> {
  const { screenshots, store } = ctx;

  if (path === "/v1/screenshots/settings") {
    if (method === "GET") {
      send(res, 200, { settings: screenshots.settings, usage: screenshots.usage(), error: screenshots.settingsError });
      return 200;
    }
    if (method === "PUT") {
      try {
        const settings = screenshots.updateSettings(await readBody(req));
        send(res, 200, { settings, usage: screenshots.usage() });
        return 200;
      } catch (err) {
        if (err instanceof ScreenshotError && err.code === "invalid_settings") {
          send(res, 400, { error: err.code, errors: err.message.split("; ") });
          return 400;
        }
        mapError(err);
      }
    }
  }

  if (method === "POST" && path === "/v1/screenshots/retention") {
    send(res, 200, screenshots.applyRetention());
    return 200;
  }

  if (method === "POST" && path === "/v1/screenshots") {
    if (!screenshots.settings.enabled) throw new HttpError(409, "screenshots_disabled"); // before reading the body
    const limit = Math.min(MAX_UPLOAD_BODY, Math.ceil((screenshots.settings.maxImageBytes * 4) / 3) + 4096);
    const body = (await readBody(req, limit)) as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") throw new HttpError(400, "invalid_body");
    const { sessionId, eventId, sha256, dataBase64 } = body;
    if (typeof sessionId !== "string" || !ID_RE.test(sessionId)) throw new HttpError(400, "invalid_session");
    if (typeof eventId !== "string" || !ID_RE.test(eventId)) throw new HttpError(400, "invalid_event");
    if (typeof sha256 !== "string") throw new HttpError(400, "invalid_sha256");
    if (typeof dataBase64 !== "string" || dataBase64.length === 0 || !B64_RE.test(dataBase64)) throw new HttpError(400, "invalid_data");
    try {
      const rec = screenshots.storeExtension({ sessionId, eventId, sha256: sha256.toLowerCase(), data: Buffer.from(dataBase64, "base64") });
      send(res, 201, { screenshot: rec });
      return 201;
    } catch (err) {
      mapError(err);
    }
  }

  if (method === "GET" && path === "/v1/screenshots") {
    send(
      res,
      200,
      store.listScreenshots({ sessionId: idParam(url, "session"), runId: idParam(url, "run"), from: intParam(url, "from"), to: intParam(url, "to"), limit: intParam(url, "limit"), offset: intParam(url, "offset") }),
    );
    return 200;
  }

  const sessMatch = /^\/v1\/sessions\/([^/]+)\/screenshots$/.exec(path);
  if (method === "DELETE" && sessMatch) {
    const id = decodeURIComponent(sessMatch[1] as string);
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid_id");
    send(res, 200, { deleted: screenshots.deleteSession(id) });
    return 200;
  }

  const m = /^\/v1\/screenshots\/([^/]+)(\/image)?$/.exec(path);
  if (m) {
    const id = decodeURIComponent(m[1] as string);
    if (!ID_RE.test(id)) throw new HttpError(400, "invalid_id");
    if (method === "GET" && m[2]) {
      const img = screenshots.image(id);
      if (!img) {
        send(res, 404, { error: "not_found" });
        return 404;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(img.data.length),
        "content-disposition": `inline; filename="${img.record.sha256.slice(0, 16)}.png"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-screenshot-sha256": img.record.sha256,
      });
      res.end(img.data);
      return 200;
    }
    if (method === "GET") {
      const rec = store.getScreenshot(id);
      if (!rec) {
        send(res, 404, { error: "not_found" });
        return 404;
      }
      send(res, 200, { screenshot: rec });
      return 200;
    }
    if (method === "DELETE") {
      const ok = screenshots.delete(id);
      send(res, ok ? 200 : 404, ok ? { deleted: true } : { error: "not_found" });
      return ok ? 200 : 404;
    }
  }
  return undefined;
}
