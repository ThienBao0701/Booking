/**
 * Native Messaging transport (Phase 14): handshake, schema validation of host
 * messages, request/response mapping, header allowlist, abort/timeout,
 * disconnect → reconnect, host-refused connections, the HTTP fallback, the
 * BridgeClient running over it, and the manifest policy's narrow allowance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BridgeClient, type Transport } from "../src/bridge/client.ts";
import { NativeChannel, NativeRequestError, NativeUnavailableError, type PortLike, autoTransport } from "../src/bridge/native-transport.ts";
import { checkManifestPolicy } from "../src/common/manifest-policy.ts";
import { DEFAULT_CONFIG, validateConfig } from "../src/common/config.ts";
import { CONTRACT_VERSION, NATIVE_HOST_NAME } from "../src/shared.ts";
import { FakeTimers, settle } from "./fakes.ts";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as Record<string, unknown> & { permissions: string[] };

const TOKEN = "native-test-token-0123456789";

type Handler = (m: Record<string, unknown>, reply: (x: unknown) => void, port: FakePort) => void;

/** A chrome.runtime.Port double wired to a scripted host. */
class FakePort implements PortLike {
  sent: Array<Record<string, unknown>> = [];
  #onMessage: Array<(m: unknown) => void> = [];
  #onDisconnect: Array<() => void> = [];
  connected = true;
  handler: Handler;
  constructor(handler: Handler) {
    this.handler = handler;
  }
  postMessage(msg: unknown): void {
    if (!this.connected) throw new Error("Attempting to use a disconnected port object");
    this.sent.push(msg as Record<string, unknown>);
    queueMicrotask(() => this.handler(msg as Record<string, unknown>, (x) => this.emit(x), this));
  }
  disconnect(): void {
    this.connected = false;
  }
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.#onMessage.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.#onDisconnect.push(fn) };
  emit(m: unknown): void {
    if (this.connected) for (const f of this.#onMessage) f(m);
  }
  /** The host went away (crash, or Chrome closed the port). */
  hostGone(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const f of this.#onDisconnect) f();
  }
}

const welcome = { type: "welcome", protocol: 1, hostVersion: "0.1.0", contractVersion: CONTRACT_VERSION, service: { url: "http://127.0.0.1:4577", reachable: true, safetyMode: "OBSERVE" } };

/** Host that speaks the protocol and answers requests like the lab service would. */
function serviceHost(opts: { onRequest?: (m: Record<string, unknown>) => { status: number; body?: unknown } | "error" | "silent" } = {}): Handler {
  return (m, reply) => {
    if (m.type === "hello") return reply(welcome);
    if (m.type === "request") {
      const r = opts.onRequest?.(m) ?? defaultReply(m);
      if (r === "silent") return;
      if (r === "error") return reply({ type: "error", id: m.id, code: "service_unreachable", message: "down", retryable: true, fatal: false });
      return reply({ type: "response", id: m.id, status: r.status, ...(r.body !== undefined ? { body: r.body } : {}) });
    }
  };
}

function defaultReply(m: Record<string, unknown>): { status: number; body?: unknown } {
  const auth = (m.headers as Record<string, string>).authorization === `Bearer ${TOKEN}`;
  if (m.path === "/healthz") return { status: 200, body: { status: "ok", safetyMode: "OBSERVE" } };
  if (!auth) return { status: 401, body: { error: "unauthorized" } };
  if (m.path === "/v1/bridge/handshake") return { status: 200, body: { service: "lab-service", contractVersion: CONTRACT_VERSION, labVersion: "0.1.0", safetyMode: "OBSERVE", maxBatchEvents: 500 } };
  if (m.path === "/v1/sessions") return { status: 201, body: { ok: true } };
  if (m.path === "/v1/events") {
    const events = (JSON.parse(m.body as string) as { events: unknown[] }).events;
    return { status: 200, body: { accepted: events.length, invalidDetail: [] } };
  }
  return { status: 404, body: { error: "not_found" } };
}

function channel(handler: Handler, extra: { lastError?: string; timers?: FakeTimers } = {}) {
  const ports: FakePort[] = [];
  const names: string[] = [];
  const ch = new NativeChannel({
    connect: (name) => {
      names.push(name);
      const p = new FakePort(handler);
      ports.push(p);
      return p;
    },
    lastError: () => extra.lastError,
    extensionVersion: "0.1.0",
    handshakeTimeoutMs: 1000,
    ...(extra.timers ? { timers: extra.timers } : {}),
  });
  return { ch, ports, names };
}

const req = (path: string, init: { method?: "GET" | "POST"; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) => ({
  method: init.method ?? "GET",
  url: `http://127.0.0.1:4577${path}`,
  headers: init.headers ?? { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
  signal: init.signal ?? new AbortController().signal,
  ...(init.body !== undefined ? { body: init.body } : {}),
});

test("connects to the lab host only, handshakes once, then relays requests", async () => {
  const { ch, ports, names } = channel(serviceHost());
  const r = await ch.transport(req("/v1/bridge/handshake"));
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { service: string }).service, "lab-service");
  await ch.transport(req("/healthz"));
  assert.deepEqual(names, [NATIVE_HOST_NAME]);
  assert.equal(ports.length, 1, "one connection reused");
  const [hello, first] = ports[0]?.sent ?? [];
  assert.deepEqual(hello, { type: "hello", protocol: { min: 1, max: 1 }, extensionVersion: "0.1.0", contractVersion: CONTRACT_VERSION });
  assert.deepEqual(first, { type: "request", id: "r1", method: "GET", path: "/v1/bridge/handshake", headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" } });
  assert.equal(ch.status.state, "ready");
  assert.equal(ch.status.welcome?.service.url, "http://127.0.0.1:4577");
});

test("only relayable headers leave the extension; query strings are refused", async () => {
  const { ch, ports } = channel(serviceHost());
  await ch.transport(req("/v1/events", { method: "POST", body: "{\"events\":[]}", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Cookie: "x=1", "X-Other": "y" } }));
  assert.deepEqual(ports[0]?.sent[1]?.headers, { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
  await assert.rejects(ch.transport(req("/v1/events?x=1", { method: "POST", body: "{}" })), /query strings/);
});

test("host errors are typed; invalid host messages drop the connection", async () => {
  const { ch } = channel(serviceHost({ onRequest: () => "error" }));
  await assert.rejects(ch.transport(req("/v1/bridge/handshake")), (e: unknown) => e instanceof NativeRequestError && e.code === "service_unreachable" && e.retryable);

  const bad = channel((m, reply) => {
    if (m.type === "hello") reply(welcome);
    else reply({ type: "response", id: m.id, status: 200, injected: "<script>" });
  });
  await assert.rejects(bad.ch.transport(req("/healthz")), /invalid message from the native host/);
  assert.equal(bad.ports[0]?.connected, false);
});

test("a refused or missing host is 'unavailable' (never relayed); the next request tries again", async () => {
  const refused = channel((m, reply) => {
    if (m.type === "hello") reply({ type: "error", code: "origin_not_allowed", message: "not allowed", retryable: false, fatal: true });
  });
  await assert.rejects(refused.ch.transport(req("/healthz")), (e: unknown) => e instanceof NativeUnavailableError && e.code === "origin_not_allowed");
  assert.equal(refused.ch.status.state, "unavailable");

  const missing = channel((_m, _reply, port) => queueMicrotask(() => port.hostGone()), { lastError: "Specified native messaging host not found." });
  await assert.rejects(missing.ch.transport(req("/healthz")), (e: unknown) => e instanceof NativeUnavailableError && /not found/.test(e.message));
  await assert.rejects(missing.ch.transport(req("/healthz")), NativeUnavailableError);
  assert.equal(missing.ports.length, 2, "a failed handshake is not cached");
});

test("handshake timeout", async () => {
  const timers = new FakeTimers();
  const { ch } = channel(() => undefined, { timers });
  const p = assert.rejects(ch.transport(req("/healthz")), (e: unknown) => e instanceof NativeUnavailableError && e.code === "handshake_timeout");
  await settle();
  await timers.advance(1000);
  await p;
});

test("abort cancels the wait and a late answer is ignored; host loss fails in-flight requests and the next request reconnects", async () => {
  let answer: (() => void) | undefined;
  const { ch, ports } = channel((m, reply) => {
    if (m.type === "hello") return reply(welcome);
    if (m.path === "/v1/events") {
      answer = () => reply({ type: "response", id: m.id, status: 200, body: {} });
      return;
    }
    reply({ type: "response", id: m.id, status: 200, body: { status: "ok" } });
  });
  const ctrl = new AbortController();
  const p = ch.transport(req("/v1/events", { method: "POST", body: "{}", signal: ctrl.signal }));
  await settle();
  ctrl.abort();
  await assert.rejects(p, /aborted/);
  answer?.();
  assert.equal((await ch.transport(req("/healthz"))).status, 200, "connection still usable");

  const inflight = ch.transport(req("/v1/events", { method: "POST", body: "{}" }));
  await settle();
  ports[0]?.hostGone();
  await assert.rejects(inflight, /native host disconnected/);
  assert.equal(ch.status.state, "disconnected");
  assert.equal((await ch.transport(req("/healthz"))).status, 200);
  assert.equal(ports.length, 2, "reconnected with a new handshake");
  assert.equal(ports[1]?.sent[0]?.type, "hello");
});

test("auto transport: native when installed, HTTP loopback fallback when not, native retried later", async () => {
  const httpCalls: string[] = [];
  const http: Transport = async (r) => {
    httpCalls.push(r.url);
    return { status: 200, json: async () => ({ via: "http" }) };
  };
  let now = 0;
  let installed = false;
  const kinds: string[] = [];
  const { ch } = channel((m, reply, port) => {
    if (!installed) return queueMicrotask(() => port.hostGone());
    serviceHost()(m, reply, port);
  }, { lastError: "Specified native messaging host not found." });
  const auto = autoTransport({ native: ch, http, retryNativeAfterMs: 60_000, now: () => now, onKind: (k) => kinds.push(k) });

  assert.deepEqual(await (await auto.transport(req("/healthz"))).json(), { via: "http" });
  assert.equal(auto.kind(), "http");
  assert.match(auto.fallbackReason() ?? "", /not found/);
  installed = true;
  now = 30_000;
  await auto.transport(req("/healthz"));
  assert.equal(httpCalls.length, 2, "native is not retried before the back-off");
  now = 61_000;
  const r = await auto.transport(req("/healthz"));
  assert.deepEqual(await r.json(), { status: "ok", safetyMode: "OBSERVE" });
  assert.equal(auto.kind(), "native");
  assert.equal(httpCalls.length, 2);
  assert.deepEqual(kinds, ["http", "native"]);

  // Errors on an established native connection are not silently re-sent over HTTP.
  const flaky = channel(serviceHost({ onRequest: (m) => (m.path === "/v1/events" ? "error" : defaultReply(m)) }));
  const auto2 = autoTransport({ native: flaky.ch, http });
  await auto2.transport(req("/healthz"));
  await assert.rejects(auto2.transport(req("/v1/events", { method: "POST", body: "{}" })), NativeRequestError);
  assert.equal(httpCalls.length, 2);
});

test("BridgeClient works unchanged over the native transport (handshake, token, delivery)", async () => {
  const { ch, ports } = channel(serviceHost());
  const bridge = new BridgeClient({ serviceUrl: "http://127.0.0.1:4577", token: TOKEN, transport: ch.transport, reconnect: { baseMs: 10, maxMs: 10, auto: false } });
  assert.equal(await bridge.connect(), "connected");
  const health = await bridge.health();
  assert.equal(health.ok, true);
  const wrong = new BridgeClient({ serviceUrl: "http://127.0.0.1:4577", token: "wrong-token-wrong-token", transport: ch.transport, reconnect: { baseMs: 10, maxMs: 10, auto: false } });
  assert.equal(await wrong.connect(), "auth_failed", "the service still authenticates every relayed request");
  const relayed = (ports[0]?.sent ?? []).filter((m) => m.type === "request" && m.path !== "/healthz");
  assert.ok(relayed.length >= 2 && relayed.every((m) => typeof (m.headers as Record<string, string>).authorization === "string"), "every API call carries the bearer token (only /healthz is unauthenticated)");
});

test("config: transport defaults to auto and is validated", () => {
  assert.equal(DEFAULT_CONFIG.transport, "auto");
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, transport: "native" }).ok, true);
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, transport: "http" }).ok, true);
  assert.equal(validateConfig({ ...DEFAULT_CONFIG, transport: "websocket" as never }).ok, false);
});

test("manifest policy: nativeMessaging is the only widening, and nothing else was relaxed", () => {
  assert.deepEqual(checkManifestPolicy(manifest), []);
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  const widen = (patch: Record<string, unknown>) => checkManifestPolicy({ ...manifest, ...patch });
  for (const p of ["proxy", "debugger", "webRequest", "webRequestBlocking", "declarativeNetRequest", "cookies", "privacy", "management", "tabs", "history", "webNavigation", "contentSettings"]) {
    assert.ok(widen({ permissions: [...manifest.permissions, p] }).some((v) => v.includes(p)), p);
  }
  assert.ok(widen({ optional_permissions: ["nativeMessaging"] }).length > 0);
  assert.ok(widen({ externally_connectable: { ids: ["*"] } }).length > 0, "web pages / other extensions still cannot message the extension");
});
