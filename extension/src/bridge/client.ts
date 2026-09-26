/**
 * Extension ↔ local service bridge (Phase 4). Transport: loopback HTTP to the
 * lab service API, or the Native Messaging host (Phase 14,
 * `native-transport.ts`) behind the same `Transport` signature.
 *
 * Guarantees:
 *  - origin: the service URL must be loopback — enforced at construction, so
 *    recorded data can never be sent off-box; redirects are refused so the
 *    bearer token cannot be forwarded elsewhere;
 *  - authentication: bearer token on every API call; handshake verifies the
 *    endpoint is a lab service with a compatible contract before first send;
 *  - request validation: every event is converted + validated against the wire
 *    contract client-side; invalid events are rejected locally, never sent;
 *  - timeout: every request is aborted after `timeoutMs`;
 *  - reconnect: transport failures move to `offline` and schedule reconnects
 *    with exponential backoff + jitter; `onReconnect` fires on recovery;
 *  - health: unauthenticated `/healthz` probe for status displays.
 *
 * Delivery is idempotent end-to-end (the service de-duplicates by event id), so
 * any failure can be retried safely by the recorder.
 */

import { type LabEvent, type RecordedEvent, CONTRACT_VERSION, isLoopbackUrl, toValidLabEvent } from "../shared.ts";
import type { DeliveryFailureReason, DeliveryResult, EventSink, SessionDescriptor } from "../recorder/recorder.ts";
import { realTimers, type TimerApi } from "../recorder/debounce.ts";

// ---- transport ----

export interface TransportRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  json(): Promise<unknown>;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** fetch-based transport: no cookies, no cache, and redirects are errors (token never leaves loopback). */
export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

// ---- types ----

export type BridgeState =
  | "idle"
  | "connecting"
  | "connected"
  | "offline"
  | "unpaired"
  | "auth_failed"
  | "forbidden"
  | "incompatible";

export interface HealthResult {
  reachable: boolean;
  ok: boolean;
  status?: number;
  safetyMode?: string;
  error?: string;
}

export interface HandshakeInfo {
  labVersion: string;
  contractVersion: number;
  safetyMode: string;
  maxBatchEvents: number;
  /** Phase 12: whether the service stores screenshot images (off unless enabled there). */
  screenshots: { enabled: boolean; maxImageBytes: number };
}

export interface BridgeOptions {
  serviceUrl: string;
  token: string;
  transport?: Transport;
  timers?: TimerApi;
  /** Per-request timeout (default 8000 ms). */
  timeoutMs?: number;
  reconnect?: { baseMs: number; maxMs: number; auto: boolean };
  random?: () => number;
  onStateChange?: (state: BridgeState, detail: string | undefined) => void;
  /** Called when the service becomes reachable again after being offline. */
  onReconnect?: () => void;
}

export class BridgeError extends Error {
  readonly reason: DeliveryFailureReason;
  readonly retryable: boolean;
  readonly status: number | undefined;
  constructor(reason: DeliveryFailureReason, retryable: boolean, message: string, status?: number) {
    super(message);
    this.name = "BridgeError";
    this.reason = reason;
    this.retryable = retryable;
    this.status = status;
  }
}

function asBridgeError(e: unknown): BridgeError {
  return e instanceof BridgeError ? e : new BridgeError("transport", true, String(e));
}

const STATE_FOR_REASON: Partial<Record<DeliveryFailureReason, BridgeState>> = {
  transport: "offline",
  timeout: "offline",
  auth: "auth_failed",
  forbidden: "forbidden",
  incompatible: "incompatible",
  unpaired: "unpaired",
};

interface InvalidDetail {
  index: number;
  id?: string;
  code?: string;
  errors?: string[];
}

// ---- client ----

export class BridgeClient implements EventSink {
  #base: string;
  #token: string;
  #transport: Transport;
  #timers: TimerApi;
  #timeoutMs: number;
  #reconnect: { baseMs: number; maxMs: number; auto: boolean };
  #random: () => number;
  #onStateChange: BridgeOptions["onStateChange"];
  #onReconnect: BridgeOptions["onReconnect"];

  #state: BridgeState = "idle";
  #handshaken = false;
  #maxBatch = 500;
  #registered = new Set<string>();
  #sessions = new Map<string, SessionDescriptor>();
  #pendingEnds = new Map<string, number>();
  #reconnectHandle: unknown = undefined;
  #reconnectAttempts = 0;
  /** True from the first transport failure until the next success (independent of the displayed state). */
  #wasOffline = false;
  #closed = false;

  constructor(opts: BridgeOptions) {
    if (!isLoopbackUrl(opts.serviceUrl)) {
      throw new BridgeError("forbidden", false, `bridge refuses non-loopback service URL: ${opts.serviceUrl}`);
    }
    this.#base = opts.serviceUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#transport = opts.transport ?? fetchTransport;
    this.#timers = opts.timers ?? realTimers;
    this.#timeoutMs = opts.timeoutMs ?? 8000;
    this.#reconnect = opts.reconnect ?? { baseMs: 1000, maxMs: 60_000, auto: true };
    this.#random = opts.random ?? Math.random;
    this.#onStateChange = opts.onStateChange;
    this.#onReconnect = opts.onReconnect;
    if (!opts.token) this.#state = "unpaired";
  }

  get state(): BridgeState {
    return this.#state;
  }

  get maxBatchEvents(): number {
    return this.#maxBatch;
  }

  /** Session ends not yet acknowledged by the service (persist across restarts). */
  get pendingEnds(): Array<{ sessionId: string; endedAt: number }> {
    return [...this.#pendingEnds].map(([sessionId, endedAt]) => ({ sessionId, endedAt }));
  }

  restorePendingEnds(items: ReadonlyArray<{ sessionId: string; endedAt: number }>): void {
    for (const i of items) this.#pendingEnds.set(i.sessionId, i.endedAt);
  }

  /** Make session metadata available for (re-)registration on the service. */
  declareSession(desc: SessionDescriptor): void {
    this.#sessions.set(desc.sessionId, desc);
  }

  // ---- low-level request with timeout ----

  /**
   * One request, retried once immediately on a network-level failure. Every
   * bridge call is idempotent on the service (session registration, event
   * ingestion by id, session end), so this is safe; it absorbs stale keep-alive
   * sockets after a service restart. Timeouts and HTTP statuses are not retried here.
   */
  async #request(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<{ status: number; body: unknown }> {
    try {
      return await this.#requestOnce(method, path, body, auth);
    } catch (e) {
      if (e instanceof BridgeError && e.reason === "transport") return await this.#requestOnce(method, path, body, auth);
      throw e;
    }
  }

  async #requestOnce(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<{ status: number; body: unknown }> {
    const ctrl = new AbortController();
    const handle = this.#timers.setTimeout(() => ctrl.abort(), this.#timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (auth) headers.authorization = `Bearer ${this.#token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.#transport({
        method,
        url: this.#base + path,
        headers,
        signal: ctrl.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      if (ctrl.signal.aborted) throw new BridgeError("timeout", true, `${method} ${path} timed out after ${this.#timeoutMs}ms`);
      throw new BridgeError("transport", true, `service unreachable (${method} ${path}): ${String(err)}`);
    } finally {
      this.#timers.clearTimeout(handle);
    }
  }

  #classify(status: number, context: string): BridgeError | undefined {
    if (status >= 200 && status < 300) return undefined;
    if (status === 401) return new BridgeError("auth", false, `${context}: 401 unauthorized — re-pair the token`, status);
    if (status === 403) return new BridgeError("forbidden", false, `${context}: 403 — service rejected origin/host`, status);
    if (status === 429) return new BridgeError("rate_limited", true, `${context}: 429 rate limited`, status);
    if (status >= 500) return new BridgeError("server", true, `${context}: ${status} server error`, status);
    return new BridgeError("rejected_batch", false, `${context}: unexpected status ${status}`, status);
  }

  // ---- state machine ----

  #setState(s: BridgeState, detail?: string): void {
    if (s === this.#state) return;
    this.#state = s;
    this.#onStateChange?.(s, detail);
  }

  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      const recovered = this.#wasOffline;
      this.#wasOffline = false;
      this.#setState("connected");
      this.#reconnectAttempts = 0;
      this.#clearReconnect();
      if (recovered) this.#onReconnect?.();
      return out;
    } catch (e) {
      const be = asBridgeError(e);
      const next = STATE_FOR_REASON[be.reason];
      if (next) this.#setState(next, be.message);
      if (next === "offline") {
        this.#wasOffline = true;
        this.#scheduleReconnect();
      }
      throw be;
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || !this.#reconnect.auto || this.#reconnectHandle !== undefined) return;
    const exp = Math.min(this.#reconnect.maxMs, this.#reconnect.baseMs * 2 ** this.#reconnectAttempts);
    this.#reconnectAttempts += 1;
    const delay = Math.round(exp * (0.5 + this.#random() * 0.5));
    this.#reconnectHandle = this.#timers.setTimeout(() => {
      this.#reconnectHandle = undefined;
      void this.connect();
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#reconnectHandle !== undefined) this.#timers.clearTimeout(this.#reconnectHandle);
    this.#reconnectHandle = undefined;
  }

  // ---- public operations ----

  /** Unauthenticated liveness probe. Never throws. */
  async health(): Promise<HealthResult> {
    try {
      const res = await this.#request("GET", "/healthz", undefined, false);
      const b = (res.body ?? {}) as Record<string, unknown>;
      return {
        reachable: true,
        ok: res.status === 200 && b.status === "ok",
        status: res.status,
        ...(typeof b.safetyMode === "string" ? { safetyMode: b.safetyMode } : {}),
      };
    } catch (e) {
      return { reachable: false, ok: false, error: asBridgeError(e).message };
    }
  }

  /** Authenticated contract check; must succeed before events are sent. */
  async handshake(): Promise<HandshakeInfo> {
    if (!this.#token) throw new BridgeError("unpaired", false, "not paired: set the service token in Options");
    const res = await this.#request("GET", "/v1/bridge/handshake");
    const err = this.#classify(res.status, "handshake");
    if (err) throw err;
    const b = (res.body ?? {}) as Record<string, unknown>;
    if (b.service !== "lab-service") throw new BridgeError("incompatible", false, "endpoint is not a lab service");
    if (b.contractVersion !== CONTRACT_VERSION) {
      throw new BridgeError("incompatible", false, `contract v${String(b.contractVersion)} ≠ extension v${CONTRACT_VERSION}`);
    }
    if (typeof b.maxBatchEvents === "number" && b.maxBatchEvents > 0) this.#maxBatch = Math.min(500, b.maxBatchEvents);
    this.#handshaken = true;
    return {
      labVersion: String(b.labVersion ?? ""),
      contractVersion: b.contractVersion,
      safetyMode: String(b.safetyMode ?? ""),
      maxBatchEvents: this.#maxBatch,
      screenshots: (() => {
        const s = (b.screenshots ?? {}) as Record<string, unknown>;
        return { enabled: s.enabled === true, maxImageBytes: typeof s.maxImageBytes === "number" ? s.maxImageBytes : 0 };
      })(),
    };
  }

  /**
   * Upload the PNG of a recorded screenshot event (Phase 12). Only when the
   * service has storage enabled; the service binds the image to the event by
   * its recorded sha256. Never throws: returns why an image was not stored.
   */
  async uploadScreenshot(u: { sessionId: string; eventId: string; sha256: string; dataBase64: string }): Promise<{ stored: boolean; reason?: string }> {
    if (!this.#token) return { stored: false, reason: "unpaired" };
    try {
      const res = await this.#request("POST", "/v1/screenshots", u);
      if (res.status === 201) return { stored: true };
      const code = ((res.body ?? {}) as { error?: string }).error ?? `status ${res.status}`;
      return { stored: false, reason: code };
    } catch (e) {
      return { stored: false, reason: asBridgeError(e).message };
    }
  }

  /** (Re)connect: handshake + deliver any pending session ends. Never throws. */
  async connect(): Promise<BridgeState> {
    if (!this.#token) {
      this.#setState("unpaired");
      return this.#state;
    }
    if (this.#state !== "connected") this.#setState("connecting");
    try {
      await this.#guard(async () => {
        await this.handshake();
        await this.#flushPendingEnds();
      });
    } catch {
      /* state already updated by #guard */
    }
    return this.#state;
  }

  async #ensureRegistered(sessionId: string): Promise<void> {
    if (this.#registered.has(sessionId)) return;
    const d = this.#sessions.get(sessionId);
    const body = d
      ? { sessionId, mode: d.mode, target: d.target, startedAt: d.startedAt }
      : { sessionId };
    const res = await this.#request("POST", "/v1/sessions", body);
    const err = this.#classify(res.status, "register session");
    if (err) throw err;
    this.#registered.add(sessionId);
  }

  async #flushPendingEnds(): Promise<void> {
    for (const [sessionId, endedAt] of [...this.#pendingEnds]) {
      const res = await this.#request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/end`, { endedAt });
      if (res.status !== 404) {
        const err = this.#classify(res.status, "end session");
        if (err) throw err;
      }
      this.#pendingEnds.delete(sessionId);
      this.#sessions.delete(sessionId);
    }
  }

  /** End a session on the service; queued and retried if the service is unreachable. */
  async endSession(sessionId: string, endedAt: number): Promise<boolean> {
    this.#pendingEnds.set(sessionId, endedAt);
    if (!this.#token) return false;
    try {
      await this.#guard(() => this.#flushPendingEnds());
      return true;
    } catch {
      return false;
    }
  }

  /** EventSink: deliver a batch; `ok: true` means every event is terminal. */
  async deliver(batch: RecordedEvent[]): Promise<DeliveryResult> {
    if (!this.#token) {
      this.#setState("unpaired");
      return { ok: false, reason: "unpaired", retryable: false, error: "not paired: set the service token in Options" };
    }
    try {
      return await this.#guard(async () => {
        if (!this.#handshaken) await this.handshake();

        const rejected: Array<{ id: string; code: string; errors: string[] }> = [];
        const wire: LabEvent[] = [];
        for (const r of batch) {
          const v = toValidLabEvent(r);
          if (v.ok) wire.push(v.value);
          else rejected.push({ id: r.event_id, code: "LOCAL_INVALID", errors: v.errors });
        }
        for (const sid of new Set(wire.map((e) => e.sessionId))) await this.#ensureRegistered(sid);

        const ackIds: string[] = [];
        await this.#sendChunks(wire, ackIds, rejected, true);
        await this.#flushPendingEnds();
        return { ok: true as const, ackIds, rejected };
      });
    } catch (e) {
      const be = asBridgeError(e);
      return { ok: false, reason: be.reason, retryable: be.retryable, error: be.message };
    }
  }

  async #sendChunks(
    events: LabEvent[],
    ackIds: string[],
    rejected: Array<{ id: string; code: string; errors: string[] }>,
    allowResend: boolean,
  ): Promise<void> {
    let size = this.#maxBatch;
    let i = 0;
    while (i < events.length) {
      const chunk = events.slice(i, i + size);
      const res = await this.#request("POST", "/v1/events", { events: chunk });

      if (res.status === 413) {
        if (chunk.length > 1) {
          size = Math.max(1, Math.floor(chunk.length / 2)); // adaptive: retry smaller
          continue;
        }
        const only = chunk[0] as LabEvent;
        rejected.push({ id: only.id, code: "TOO_LARGE", errors: ["event exceeds the service body limit"] });
        i += 1;
        continue;
      }
      const err = this.#classify(res.status, "send events");
      if (err) throw err;

      const detail = ((res.body ?? {}) as { invalidDetail?: InvalidDetail[] }).invalidDetail ?? [];
      const bad = new Set<string>();
      const resend: LabEvent[] = [];
      for (const d of detail) {
        const id = d.id ?? chunk[d.index]?.id;
        if (!id) continue;
        bad.add(id);
        const ev = chunk.find((e) => e.id === id);
        if (d.code === "UNKNOWN_SESSION" && allowResend && ev) resend.push(ev);
        else rejected.push({ id, code: d.code ?? "INVALID_EVENT", errors: d.errors ?? [] });
      }
      for (const e of chunk) if (!bad.has(e.id)) ackIds.push(e.id);

      if (resend.length > 0) {
        // The service no longer knows the session (e.g. its database was reset):
        // re-register and resend those events exactly once.
        for (const sid of new Set(resend.map((e) => e.sessionId))) {
          this.#registered.delete(sid);
          await this.#ensureRegistered(sid);
        }
        await this.#sendChunks(resend, ackIds, rejected, false);
      }
      i += chunk.length;
    }
  }

  close(): void {
    this.#closed = true;
    this.#clearReconnect();
  }
}
