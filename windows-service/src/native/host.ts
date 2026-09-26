/**
 * Native Messaging host (Phase 14, ADR-0009): a validated relay between the
 * Chrome extension (stdio, length-prefixed JSON) and the lab service
 * (loopback HTTP).
 *
 * Security properties:
 *  - Chrome starts the host only for extensions listed in its manifest's
 *    `allowed_origins`; the host checks the caller origin (argv) against its
 *    own config again and refuses anything else.
 *  - The host holds no secret: every relayed request carries the extension's
 *    bearer token and the verified extension origin, so the service applies
 *    its usual authentication and origin validation.
 *  - Only the bridge's routes are relayed (`isRelayableRoute`); only the
 *    authorization / content-type / accept headers pass.
 *  - Every message is schema-validated; framing errors are fatal (the stream
 *    cannot be resynchronised); requests time out; in-flight work is capped.
 *  - stdout carries protocol frames only; logs go to a file, without headers
 *    or bodies.
 */

import { request as httpRequest } from "node:http";

import {
  CONTRACT_VERSION,
  LAB_VERSION,
  NATIVE_MAX_TO_EXTENSION_BYTES,
  NATIVE_MAX_TO_HOST_BYTES,
  type HostToExtension,
  type NativeErrorCode,
  type NativeRequest,
  RETRYABLE_NATIVE_ERRORS,
  isRelayableRoute,
  negotiateProtocol,
  validateExtensionMessage,
} from "../shared.ts";
import { type NativeHostConfig, normalizeExtensionOrigin } from "./config.ts";
import { FrameDecoder, FrameError, encodeFrame } from "./framing.ts";

export interface RelayRequest {
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
export interface RelayResponse {
  status: number;
  body: unknown;
}
export type Relay = (r: RelayRequest) => Promise<RelayResponse>;

export class RelayError extends Error {
  readonly code: NativeErrorCode;
  constructor(code: NativeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Relay over loopback HTTP. No redirects are followed; the response is size-capped. */
export function httpRelay(serviceUrl: string, origin: string): Relay {
  const base = new URL(serviceUrl);
  const hostname = base.hostname.replace(/^\[|\]$/g, "");
  const port = Number(base.port || 80);
  const maxResponse = NATIVE_MAX_TO_EXTENSION_BYTES;
  return (r) =>
    new Promise<RelayResponse>((resolve, reject) => {
      const headers: Record<string, string | number> = { ...r.headers, origin, "x-lab-transport": "native" };
      if (r.body !== undefined) headers["content-length"] = Buffer.byteLength(r.body);
      const req = httpRequest({ hostname, port, path: r.path, method: r.method, headers, signal: r.signal, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxResponse) {
            res.destroy();
            reject(new RelayError("response_too_large", `service response exceeds ${maxResponse} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          let body: unknown;
          try {
            body = size > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
          } catch {
            body = undefined;
          }
          resolve({ status: res.statusCode ?? 502, body });
        });
        res.on("error", (err) => reject(err));
      });
      req.on("error", (err) => reject(err));
      if (r.body !== undefined) req.write(r.body);
      req.end();
    });
}

export interface HostLogger {
  log(level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void;
}

export interface NativeHostOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** argv origin Chrome passes to the host ("chrome-extension://<id>/"). */
  callerOrigin: string | undefined;
  /** Validated config, or why it could not be loaded (fail closed). */
  config: NativeHostConfig | { errors: string[] };
  relay?: Relay;
  logger?: HostLogger;
  /** Concurrent relayed requests (default 16). */
  maxInFlight?: number;
  /** /healthz probe timeout during the handshake (default 2000 ms). */
  probeTimeoutMs?: number;
}

const NOOP_LOGGER: HostLogger = { log: () => undefined };

export class NativeHost {
  #o: NativeHostOptions;
  #log: HostLogger;
  #decoder = new FrameDecoder(NATIVE_MAX_TO_HOST_BYTES);
  #closing = new AbortController();
  #inFlight = 0;
  #protocol: number | undefined;
  #closed = false;
  #done: (code: number) => void = () => undefined;
  #relay: Relay | undefined;
  #config: NativeHostConfig | undefined;
  #origin: string | undefined;

  constructor(opts: NativeHostOptions) {
    this.#o = opts;
    this.#log = opts.logger ?? NOOP_LOGGER;
  }

  /** Serve until the extension disconnects (0) or a fatal error (1). */
  run(): Promise<number> {
    const finished = new Promise<number>((resolve) => {
      this.#done = resolve;
    });
    const cfg = this.#o.config;
    if ("errors" in cfg) {
      this.#log.log("error", "native host misconfigured", { errors: cfg.errors });
      this.#fatal("host_misconfigured", "the native host configuration is missing or invalid; reinstall the native host");
      return finished;
    }
    this.#config = cfg;
    const origin = this.#o.callerOrigin ? normalizeExtensionOrigin(this.#o.callerOrigin) : undefined;
    if (!origin || !cfg.allowedOrigins.includes(origin)) {
      this.#log.log("warn", "caller origin refused", { origin: String(this.#o.callerOrigin ?? "").slice(0, 80) });
      this.#fatal("origin_not_allowed", "this extension is not allowed to use the native host");
      return finished;
    }
    this.#origin = origin;
    this.#relay = this.#o.relay ?? httpRelay(cfg.serviceUrl, origin);
    this.#log.log("info", "native host connected", { origin });

    this.#o.input.on("data", (chunk: Buffer) => this.#onData(chunk));
    this.#o.input.on("end", () => this.#close(0, "extension disconnected"));
    this.#o.input.on("error", () => this.#close(0, "stdin error"));
    return finished;
  }

  #send(msg: HostToExtension): boolean {
    if (this.#closed) return false;
    let frame: Buffer;
    try {
      frame = encodeFrame(msg, NATIVE_MAX_TO_EXTENSION_BYTES);
    } catch {
      const id = "id" in msg ? msg.id : undefined;
      frame = encodeFrame(this.#error("response_too_large", "the service response is larger than Chrome allows for a native message", id), NATIVE_MAX_TO_EXTENSION_BYTES);
    }
    this.#o.output.write(frame);
    return true;
  }

  #error(code: NativeErrorCode, message: string, id?: string, fatal = false): HostToExtension {
    return { type: "error", ...(id !== undefined ? { id } : {}), code, message: message.slice(0, 1000), retryable: RETRYABLE_NATIVE_ERRORS.has(code), fatal };
  }

  #fatal(code: NativeErrorCode, message: string): void {
    this.#send(this.#error(code, message, undefined, true));
    this.#close(1, code);
  }

  #close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing.abort();
    this.#log.log(code === 0 ? "info" : "warn", "native host closing", { reason });
    this.#o.output.end(() => this.#done(code));
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    let messages: unknown[];
    try {
      messages = this.#decoder.push(chunk);
    } catch (err) {
      const fe = err instanceof FrameError ? err : new FrameError("invalid_message", String(err));
      this.#fatal(fe.code, fe.message);
      return;
    }
    for (const m of messages) this.#handle(m);
  }

  #handle(raw: unknown): void {
    if (this.#closed) return;
    const v = validateExtensionMessage(raw);
    const rawId = typeof (raw as { id?: unknown })?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test((raw as { id: string }).id) ? (raw as { id: string }).id : undefined;
    if (!v.ok) {
      this.#send(this.#error("invalid_message", v.errors.slice(0, 5).join("; "), rawId));
      return;
    }
    const msg = v.value;
    switch (msg.type) {
      case "ping":
        this.#send({ type: "pong", id: msg.id });
        return;
      case "hello": {
        if (this.#protocol !== undefined) {
          this.#send(this.#error("already_handshaken", "hello was already accepted on this connection"));
          return;
        }
        const p = negotiateProtocol(msg.protocol);
        if (p === undefined) {
          this.#fatal("unsupported_protocol", `no common protocol version (host speaks 1..1, extension offered ${msg.protocol.min}..${msg.protocol.max})`);
          return;
        }
        this.#protocol = p;
        void this.#welcome(p, msg.extensionVersion);
        return;
      }
      case "request":
        if (this.#protocol === undefined) {
          this.#send(this.#error("handshake_required", "send hello first", msg.id));
          return;
        }
        void this.#relayRequest(msg);
        return;
    }
  }

  async #welcome(protocol: number, extensionVersion: string): Promise<void> {
    const cfg = this.#config as NativeHostConfig;
    let reachable = false;
    let safetyMode: string | undefined;
    try {
      const res = await (this.#relay as Relay)({ method: "GET", path: "/healthz", headers: { accept: "application/json" }, signal: AbortSignal.any([AbortSignal.timeout(this.#o.probeTimeoutMs ?? 2000), this.#closing.signal]) });
      reachable = res.status === 200;
      const sm = (res.body as { safetyMode?: unknown } | undefined)?.safetyMode;
      if (typeof sm === "string") safetyMode = sm.slice(0, 40);
    } catch {
      reachable = false;
    }
    this.#log.log("info", "handshake", { protocol, extensionVersion, serviceReachable: reachable });
    this.#send({ type: "welcome", protocol, hostVersion: LAB_VERSION, contractVersion: CONTRACT_VERSION, service: { url: cfg.serviceUrl, reachable, ...(safetyMode ? { safetyMode } : {}) } });
  }

  async #relayRequest(msg: NativeRequest): Promise<void> {
    if (!isRelayableRoute(msg.method, msg.path)) {
      this.#log.log("warn", "route refused", { method: msg.method, path: msg.path.slice(0, 120) });
      this.#send(this.#error("route_not_allowed", `${msg.method} ${msg.path.slice(0, 120)} is not a bridge route`, msg.id));
      return;
    }
    if (this.#inFlight >= (this.#o.maxInFlight ?? 16)) {
      this.#send(this.#error("busy", "too many requests in flight", msg.id));
      return;
    }
    this.#inFlight += 1;
    const started = Date.now();
    const timeout = AbortSignal.timeout((this.#config as NativeHostConfig).timeoutMs);
    try {
      const headers: Record<string, string> = {};
      for (const [k, h] of Object.entries(msg.headers)) if (typeof h === "string") headers[k] = h;
      const res = await (this.#relay as Relay)({
        method: msg.method,
        path: msg.path,
        headers,
        ...(msg.body !== undefined ? { body: msg.body } : {}),
        signal: AbortSignal.any([timeout, this.#closing.signal]),
      });
      this.#log.log("info", "relayed", { method: msg.method, path: msg.path, status: res.status, ms: Date.now() - started });
      this.#send({ type: "response", id: msg.id, status: res.status, ...(res.body !== undefined ? { body: res.body } : {}) });
    } catch (err) {
      if (this.#closed) return;
      const code: NativeErrorCode = err instanceof RelayError ? err.code : timeout.aborted ? "timeout" : "service_unreachable";
      this.#log.log("warn", "relay failed", { method: msg.method, path: msg.path, code, ms: Date.now() - started });
      this.#send(this.#error(code, code === "timeout" ? `the service did not answer within ${(this.#config as NativeHostConfig).timeoutMs} ms` : code === "service_unreachable" ? "the lab service is not reachable" : (err as Error).message, msg.id));
    } finally {
      this.#inFlight -= 1;
    }
  }

  /** The verified caller origin (after run()). */
  get origin(): string | undefined {
    return this.#origin;
  }
}
