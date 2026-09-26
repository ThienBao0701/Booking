/**
 * Mock Extranet HTTP server (Component 11): JSON API for each module + a
 * workflow-event feed, plus the server-rendered UI. Loopback by default. This is
 * a safe local target; it holds no real credentials and reaches no real system.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

import { MockExtranet, MockError } from "./state.ts";
import { renderApp } from "./ui.ts";

const MAX_BODY = 1 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new MockError(413, "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(new MockError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const int = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function createMockServer(mock: MockExtranet = new MockExtranet()): { server: Server; mock: MockExtranet } {
  const server = createServer((req, res) => {
    void handle(mock, req, res).catch((err: unknown) => {
      if (err instanceof MockError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: "internal_error" });
    });
  });
  return { server, mock };
}

async function handle(mock: MockExtranet, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;

  // UI
  if (method === "GET" && (p === "/" || p === "/index.html")) return sendHtml(res, renderApp());
  if (method === "GET" && p === "/healthz") return sendJson(res, 200, { status: "ok", events: mock.events.length });

  // ---- API ----
  if (p.startsWith("/api/")) {
    // GET feeds
    if (method === "GET" && p === "/api/events") {
      const since = int(Number(url.searchParams.get("since")), 0);
      return sendJson(res, 200, { events: mock.eventsSince(since), total: mock.events.length });
    }
    if (method === "GET" && p === "/api/timeline") return sendJson(res, 200, { timeline: mock.timeline() });
    if (method === "GET" && p === "/api/properties") return sendJson(res, 200, { properties: [...mock.properties.values()] });
    if (method === "GET" && p === "/api/rooms") return sendJson(res, 200, { rooms: [...mock.rooms.values()] });
    if (method === "GET" && p === "/api/reservations") return sendJson(res, 200, { reservations: [...mock.reservations.values()] });

    // POST actions
    if (method === "POST") {
      const body = await readJson(req);

      if (p === "/api/login") return sendJson(res, 200, { event: mock.login(str(body.username)) });
      if (p === "/api/logout") return sendJson(res, 200, { event: mock.logout() });

      if (p === "/api/properties")
        return sendJson(res, 201, { property: mock.createProperty(str(body.name), str(body.address)) });
      const activate = /^\/api\/properties\/([^/]+)\/activate$/.exec(p);
      if (activate) return sendJson(res, 200, { property: mock.activateProperty(decodeURIComponent(activate[1] as string)) });

      if (p === "/api/rooms")
        return sendJson(res, 201, {
          room: mock.createRoom(str(body.propertyId), str(body.name), str(body.roomType), int(body.capacity, 2)),
        });

      if (p === "/api/rates")
        return sendJson(res, 201, {
          rate: mock.setRate(str(body.roomId), str(body.label), int(body.amount), str(body.currency, "USD")),
        });

      if (p === "/api/reservations")
        return sendJson(res, 201, {
          reservation: mock.createReservation(
            str(body.propertyId),
            str(body.roomId),
            str(body.guestName),
            str(body.checkIn),
            str(body.checkOut),
          ),
        });
      const cancel = /^\/api\/reservations\/([^/]+)\/cancel$/.exec(p);
      if (cancel) return sendJson(res, 200, { reservation: mock.cancelReservation(decodeURIComponent(cancel[1] as string)) });

      if (p === "/api/messages")
        return sendJson(res, 201, {
          message: mock.sendMessage(body.reservationId == null ? null : str(body.reservationId), str(body.text)),
        });

      if (p === "/api/reviews")
        return sendJson(res, 201, { review: mock.addReview(str(body.propertyId), int(body.rating), str(body.text)) });

      if (p === "/api/photos")
        return sendJson(res, 201, { photo: mock.uploadPhoto(str(body.propertyId), str(body.filename), int(body.sizeBytes)) });

      if (p === "/api/reports") return sendJson(res, 200, { report: mock.generateReport(str(body.propertyId)) });
    }

    return sendJson(res, 404, { error: "not_found" });
  }

  sendJson(res, 404, { error: "not_found" });
}
