/**
 * EgressProxy (Phase 11): the enforcement point for BrowserTargetPolicy.
 *
 * Playwright's request routing does not see every hop (redirects are followed
 * inside the browser, WebSockets and workers bypass it), so the session also
 * launches the browser with this loopback proxy as its only way out. Every
 * connection — each redirect hop, HTTPS tunnel (CONNECT), WebSocket upgrade —
 * is checked against the allowlisted origins before anything is forwarded;
 * denied connections get 403 and never reach the other host.
 *
 * It confines, it does not disguise: it binds 127.0.0.1 only, forwards directly
 * from this machine (same IP, same browser headers), has no upstream proxy and
 * no rotation. It is created per browser session and closed with it.
 *
 * Every socket and stream it owns has an error handler: a browser resetting a
 * connection (e.g. right after a 403) must never crash the hosting process.
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer, request as httpRequest } from "node:http";
import { type Socket, connect } from "node:net";
import type { AddressInfo } from "node:net";

export interface EgressDecision {
  allowed: boolean;
  reason: string;
}

export interface EgressProxyOptions {
  /** Decide on an absolute http(s) origin ("https://host:port" normalised by URL). */
  allowOrigin: (origin: string) => EgressDecision;
  onBlocked?: (info: { url: string; kind: "http" | "connect" | "upgrade"; reason: string }) => void;
  /** Idle timeout for proxied sockets (ms). */
  socketTimeoutMs?: number;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);

function forwardHeaders(h: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

function originFromConnect(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const m = /^(\[[^\]]+\]|[^:/\s]+):(\d{1,5})$/.exec(target);
  if (!m) return undefined;
  try {
    return new URL(`https://${m[1]}:${m[2]}`).origin;
  } catch {
    return undefined;
  }
}

export class EgressProxy {
  #server: Server;
  #o: EgressProxyOptions;
  #sockets = new Set<Socket>();
  #port = 0;
  #blocked = 0;
  #forwarded = 0;

  constructor(opts: EgressProxyOptions) {
    this.#o = opts;
    this.#server = createServer((req, res) => this.#onRequest(req, res));
    this.#server.on("connect", (req: IncomingMessage, socket: Socket, head: Buffer) => this.#onConnect(req, socket, head));
    this.#server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => this.#onUpgrade(req, socket, head));
    this.#server.on("connection", (s: Socket) => {
      this.#sockets.add(s);
      s.on("close", () => this.#sockets.delete(s));
      // CONNECT / upgrade sockets leave the HTTP server's error handling; keep one here for their whole life.
      s.on("error", () => s.destroy());
    });
    this.#server.on("clientError", (_err: Error, s: Socket) => s.destroy());
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => resolve());
    });
    this.#server.unref(); // never keeps the process alive on its own
    this.#port = (this.#server.address() as AddressInfo).port;
    return this.url;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }
  get stats(): { forwarded: number; blocked: number } {
    return { forwarded: this.#forwarded, blocked: this.#blocked };
  }

  #deny(kind: "http" | "connect" | "upgrade", url: string, reason: string): void {
    this.#blocked += 1;
    this.#o.onBlocked?.({ url, kind, reason });
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    req.on("error", () => res.destroy());
    res.on("error", () => req.destroy());
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("absolute-form request required");
      return;
    }
    if (target.protocol !== "http:") {
      this.#deny("http", target.toString(), "scheme");
      res.writeHead(403, { "content-type": "text/plain" }).end("blocked by the lab egress policy");
      return;
    }
    const d = this.#o.allowOrigin(target.origin);
    if (!d.allowed) {
      this.#deny("http", target.toString(), d.reason);
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" }).end("blocked by the lab egress policy");
      return;
    }
    this.#forwarded += 1;
    const upstream = httpRequest(
      { host: target.hostname.replace(/^\[|\]$/g, ""), port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers: { ...forwardHeaders(req.headers), host: target.host }, agent: false },
      (up) => {
        up.on("error", () => res.destroy());
        res.writeHead(up.statusCode ?? 502, forwardHeaders(up.headers));
        up.pipe(res);
      },
    );
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.setTimeout(this.#o.socketTimeoutMs ?? 60_000, () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end();
    });
    req.pipe(upstream);
  }

  #onConnect(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    const origin = originFromConnect(req.url);
    const d = origin ? this.#o.allowOrigin(origin) : { allowed: false, reason: "malformed CONNECT target" };
    if (!origin || !d.allowed) {
      this.#deny("connect", origin ?? String(req.url).slice(0, 200), d.reason);
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    const u = new URL(origin);
    this.#forwarded += 1;
    const upstream = connect({ host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port || 443) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const kill = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.setTimeout(this.#o.socketTimeoutMs ?? 60_000, kill);
    upstream.on("error", () => {
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      kill();
    });
    socket.on("error", kill);
  }

  #onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    let target: URL | undefined;
    try {
      target = new URL(req.url ?? "");
    } catch {
      target = undefined;
    }
    const d = target && target.protocol === "http:" ? this.#o.allowOrigin(target.origin) : { allowed: false, reason: "scheme" };
    if (!target || !d.allowed) {
      this.#deny("upgrade", target?.toString() ?? String(req.url).slice(0, 200), d.reason);
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    this.#forwarded += 1;
    const upstream = connect({ host: target.hostname.replace(/^\[|\]$/g, ""), port: Number(target.port || 80) }, () => {
      const headers = Object.entries({ ...req.headers, host: target.host })
        .filter(([k]) => !/^proxy-/i.test(k))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("\r\n");
      upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
}
