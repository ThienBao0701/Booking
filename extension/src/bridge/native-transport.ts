/**
 * Native Messaging transport (Phase 14, ADR-0009): implements the bridge's
 * `Transport` over `chrome.runtime.connectNative` to the lab's native host,
 * which relays to the service. The HTTP loopback transport stays available:
 * `autoTransport` uses native when the host is installed and falls back to
 * HTTP when it is not (host missing, refused, or no common protocol).
 *
 *  - handshake: `hello` (protocol range, contract version) → `welcome`
 *    within `handshakeTimeoutMs`; every host message is schema-validated and
 *    a protocol violation drops the connection;
 *  - authentication: requests carry the same bearer token as over HTTP; the
 *    host forwards it and the verified extension origin, and the service
 *    authenticates as usual;
 *  - timeout: the bridge's per-request AbortSignal cancels the wait;
 *  - reconnect: a dropped port fails in-flight requests (the bridge retries
 *    with backoff) and the next request opens a new connection;
 *  - errors: host errors surface as typed `NativeRequestError`s.
 */

import {
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL,
  NATIVE_RELAY_HEADERS,
  type NativeErrorCode,
  type NativeWelcome,
  helloMessage,
  validateHostMessage,
} from "../shared.ts";
import { realTimers, type TimerApi } from "../recorder/debounce.ts";
import type { Transport, TransportRequest, TransportResponse } from "./client.ts";

/** The subset of chrome.runtime.Port used here (injectable for tests). */
export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export type TransportKind = "native" | "http";

export interface NativeStatus {
  state: "disconnected" | "connecting" | "ready" | "unavailable";
  detail?: string;
  welcome?: NativeWelcome;
}

/** The native path cannot be established (nothing was sent to the service). */
export class NativeUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeUnavailableError";
    this.code = code;
  }
}

/** The host answered a request with an error. */
export class NativeRequestError extends Error {
  readonly code: NativeErrorCode;
  readonly retryable: boolean;
  constructor(code: NativeErrorCode, message: string, retryable: boolean) {
    super(`native host: ${code}: ${message}`);
    this.name = "NativeRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface NativeChannelOptions {
  connect: (hostName: string) => PortLike;
  /** chrome.runtime.lastError?.message, read when the port disconnects. */
  lastError?: () => string | undefined;
  extensionVersion: string;
  handshakeTimeoutMs?: number;
  timers?: TimerApi;
  hostName?: string;
  onStatus?: (s: NativeStatus) => void;
}

interface Pending {
  resolve: (r: TransportResponse) => void;
  reject: (e: Error) => void;
}

export class NativeChannel {
  #o: NativeChannelOptions;
  #timers: TimerApi;
  #port: PortLike | undefined;
  #ready: Promise<NativeWelcome> | undefined;
  #pending = new Map<string, Pending>();
  #seq = 0;
  #status: NativeStatus = { state: "disconnected" };

  constructor(opts: NativeChannelOptions) {
    this.#o = opts;
    this.#timers = opts.timers ?? realTimers;
  }

  get status(): NativeStatus {
    return this.#status;
  }

  #setStatus(s: NativeStatus): void {
    this.#status = s;
    this.#o.onStatus?.(s);
  }

  #failAll(err: Error): void {
    const all = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of all) p.reject(err);
  }

  #drop(port: PortLike, err: Error, state: NativeStatus["state"]): void {
    if (this.#port !== port) return;
    this.#port = undefined;
    this.#ready = undefined;
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    this.#failAll(err);
    this.#setStatus({ state, detail: err.message });
  }

  /** Open a connection and complete the handshake. */
  #open(): Promise<NativeWelcome> {
    let port: PortLike;
    try {
      port = this.#o.connect(this.#o.hostName ?? NATIVE_HOST_NAME);
    } catch (err) {
      this.#setStatus({ state: "unavailable", detail: String(err) });
      return Promise.reject(new NativeUnavailableError("connect_failed", `native messaging unavailable: ${String(err)}`));
    }
    this.#port = port;
    this.#setStatus({ state: "connecting" });
    return new Promise<NativeWelcome>((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | undefined, welcome?: NativeWelcome) => {
        if (settled) return;
        settled = true;
        this.#timers.clearTimeout(timer);
        if (err) reject(err);
        else resolve(welcome as NativeWelcome);
      };
      const timer = this.#timers.setTimeout(() => {
        const e = new NativeUnavailableError("handshake_timeout", "the native host did not complete the handshake");
        this.#drop(port, e, "unavailable");
        finish(e);
      }, this.#o.handshakeTimeoutMs ?? 3000);

      port.onDisconnect.addListener(() => {
        const why = this.#o.lastError?.() ?? "native host disconnected";
        if (!settled) {
          const e = new NativeUnavailableError("disconnected", why);
          this.#drop(port, e, "unavailable");
          finish(e);
        } else this.#drop(port, new Error(`native host disconnected: ${why}`), "disconnected");
      });

      port.onMessage.addListener((raw) => {
        const v = validateHostMessage(raw);
        if (!v.ok) {
          const e = new NativeUnavailableError("protocol_violation", `invalid message from the native host: ${v.errors.slice(0, 3).join("; ")}`);
          this.#drop(port, e, settled ? "disconnected" : "unavailable");
          finish(e);
          return;
        }
        const m = v.value;
        switch (m.type) {
          case "welcome":
            if (m.protocol < NATIVE_PROTOCOL.min || m.protocol > NATIVE_PROTOCOL.max) {
              const e = new NativeUnavailableError("unsupported_protocol", `host chose protocol ${m.protocol}`);
              this.#drop(port, e, "unavailable");
              finish(e);
              return;
            }
            this.#setStatus({ state: "ready", welcome: m });
            finish(undefined, m);
            return;
          case "response": {
            const p = this.#pending.get(m.id);
            if (!p) return; // late answer to an aborted request
            this.#pending.delete(m.id);
            const body = m.body;
            p.resolve({ status: m.status, json: () => Promise.resolve(body) });
            return;
          }
          case "error": {
            if (m.id !== undefined) {
              const p = this.#pending.get(m.id);
              if (p) {
                this.#pending.delete(m.id);
                p.reject(new NativeRequestError(m.code, m.message, m.retryable));
              }
              return;
            }
            // Connection-level: refused origin, bad config, no common protocol…
            const e = settled ? new NativeRequestError(m.code, m.message, m.retryable) : new NativeUnavailableError(m.code, `native host refused the connection: ${m.code} — ${m.message}`);
            if (m.fatal || !settled) {
              this.#drop(port, e, settled ? "disconnected" : "unavailable");
              finish(e);
            }
            return;
          }
          case "pong":
            return;
        }
      });

      try {
        port.postMessage(helloMessage(this.#o.extensionVersion));
      } catch (err) {
        const e = new NativeUnavailableError("post_failed", String(err));
        this.#drop(port, e, "unavailable");
        finish(e);
      }
    });
  }

  #ensureReady(): Promise<NativeWelcome> {
    if (!this.#ready) {
      const p = this.#open();
      this.#ready = p;
      // A failed handshake must not be cached: the next request tries again.
      p.catch(() => {
        if (this.#ready === p) this.#ready = undefined;
      });
    }
    return this.#ready;
  }

  /** Complete the handshake now (e.g. to show the transport in the popup). */
  async connect(): Promise<NativeWelcome> {
    return await this.#ensureReady();
  }

  readonly transport: Transport = async (req: TransportRequest): Promise<TransportResponse> => {
    await this.#ensureReady();
    const port = this.#port;
    if (!port) throw new Error("native host disconnected");
    const url = new URL(req.url);
    if (url.search || url.hash) throw new Error("native transport: query strings are not relayed");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if ((NATIVE_RELAY_HEADERS as readonly string[]).includes(key)) headers[key] = v;
    }
    const id = `r${++this.#seq}`;
    return await new Promise<TransportResponse>((resolve, reject) => {
      if (req.signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      this.#pending.set(id, { resolve, reject });
      req.signal.addEventListener(
        "abort",
        () => {
          if (this.#pending.delete(id)) reject(new Error("aborted"));
        },
        { once: true },
      );
      try {
        port.postMessage({ type: "request", id, method: req.method, path: url.pathname, headers, ...(req.body !== undefined ? { body: req.body } : {}) });
      } catch (err) {
        this.#pending.delete(id);
        reject(new Error(`native host: send failed: ${String(err)}`));
      }
    });
  };

  close(): void {
    const port = this.#port;
    if (port) this.#drop(port, new Error("native channel closed"), "disconnected");
  }
}

export interface AutoTransport {
  transport: Transport;
  /** The path the last successful request used. */
  kind(): TransportKind;
  /** Why native is not in use (while falling back). */
  fallbackReason(): string | undefined;
}

/**
 * Native first, HTTP loopback as fallback. Falls back only when the native
 * path cannot be established (nothing was relayed), then retries native after
 * `retryNativeAfterMs`. Errors on an established native connection propagate
 * (the bridge retries; the next attempt reconnects or falls back).
 */
export function autoTransport(o: { native: NativeChannel; http: Transport; retryNativeAfterMs?: number; now?: () => number; onKind?: (k: TransportKind, reason: string | undefined) => void }): AutoTransport {
  const now = o.now ?? Date.now;
  let unavailableUntil = 0;
  let reason: string | undefined;
  let kind: TransportKind = "http";
  const set = (k: TransportKind, why: string | undefined) => {
    if (k !== kind || why !== reason) o.onKind?.(k, why);
    kind = k;
    reason = why;
  };
  return {
    kind: () => kind,
    fallbackReason: () => reason,
    transport: async (req) => {
      if (now() >= unavailableUntil) {
        try {
          const res = await o.native.transport(req);
          set("native", undefined);
          return res;
        } catch (err) {
          if (!(err instanceof NativeUnavailableError)) throw err;
          unavailableUntil = now() + (o.retryNativeAfterMs ?? 60_000);
          set("http", err.message);
        }
      }
      const res = await o.http(req);
      set("http", reason);
      return res;
    },
  };
}
