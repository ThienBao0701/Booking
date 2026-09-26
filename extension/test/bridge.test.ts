import { test } from "node:test";
import assert from "node:assert/strict";

import { BridgeClient, type BridgeState, type Transport, type TransportRequest } from "../src/bridge/client.ts";
import type { LabEvent, RecordedEvent } from "../src/shared.ts";
import { FakeTimers, settle } from "./fakes.ts";

const TOKEN = "bridge-test-token-0123456789";
const URL_ = "http://127.0.0.1:4577";

/** In-memory model of the lab service API, with fault injection. */
class FakeService {
  sessions = new Set<string>();
  events = new Map<string, LabEvent>();
  ends = new Map<string, number>();
  requests: TransportRequest[] = [];
  mode: "normal" | "down" | "hang" = "normal";
  forceStatus: { path: string; status: number; times: number } | undefined;
  maxBatch = 500;
  contractVersion = 1;
  service = "lab-service";
  /** Fail this many upcoming requests at the network level (e.g. a stale keep-alive socket). */
  failNext = 0;

  transport: Transport = async (req) => {
    this.requests.push(req);
    if (this.mode === "down") throw new TypeError("fetch failed: ECONNREFUSED");
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new TypeError("fetch failed: other side closed");
    }
    if (this.mode === "hang") {
      return await new Promise((_, reject) =>
        req.signal.addEventListener("abort", () => reject(new Error("AbortError"))),
      );
    }
    const path = req.url.replace(URL_, "");
    const reply = (status: number, body: unknown = {}) => ({ status, json: async () => body });
    if (this.forceStatus && path.startsWith(this.forceStatus.path) && this.forceStatus.times > 0) {
      this.forceStatus.times -= 1;
      return reply(this.forceStatus.status, { error: "forced" });
    }
    if (path === "/healthz") return reply(200, { status: "ok", safetyMode: "OBSERVE" });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });

    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    if (path === "/v1/bridge/handshake") {
      return reply(200, { service: this.service, contractVersion: this.contractVersion, labVersion: "0.1.0", safetyMode: "OBSERVE", maxBatchEvents: this.maxBatch });
    }
    if (path === "/v1/sessions" && req.method === "POST") {
      const id = String(body.sessionId);
      const created = !this.sessions.has(id);
      this.sessions.add(id);
      return reply(created ? 201 : 200, { sessionId: id, created });
    }
    const end = /^\/v1\/sessions\/([^/]+)\/end$/.exec(path);
    if (end) {
      const id = decodeURIComponent(end[1] as string);
      if (!this.sessions.has(id)) return reply(404, { error: "not_found" });
      this.ends.set(id, Number(body.endedAt));
      return reply(200, { ended: true });
    }
    if (path === "/v1/events") {
      const evs = body.events as LabEvent[];
      if (evs.length > this.maxBatch) return reply(413, { error: "batch_too_large" });
      const invalidDetail: Array<Record<string, unknown>> = [];
      let stored = 0;
      let duplicates = 0;
      evs.forEach((e, index) => {
        if (!this.sessions.has(e.sessionId)) invalidDetail.push({ index, id: e.id, code: "UNKNOWN_SESSION", errors: ["unknown"] });
        else if (e.redacted !== true || e.data.page === "/poison") invalidDetail.push({ index, id: e.id, code: "INVALID_EVENT", errors: ["bad"] });
        else if (this.events.has(e.id)) duplicates += 1;
        else {
          this.events.set(e.id, e);
          stored += 1;
        }
      });
      return reply(202, { stored, duplicates, invalid: invalidDetail.length, invalidDetail });
    }
    return reply(404, { error: "not_found" });
  };
}

function rec(id: string, overrides: Partial<RecordedEvent> = {}): RecordedEvent {
  return {
    event_id: id,
    session_id: "session_A",
    seq: 0,
    timestamp: 1_750_000_000_000,
    page: "/",
    workflow: "LOGIN",
    action: "click",
    metadata: {},
    ...overrides,
  };
}

function client(svc: FakeService, extra: Partial<ConstructorParameters<typeof BridgeClient>[0]> = {}) {
  const timers = new FakeTimers();
  const states: BridgeState[] = [];
  let reconnects = 0;
  const bridge = new BridgeClient({
    serviceUrl: URL_,
    token: TOKEN,
    transport: svc.transport,
    timers,
    timeoutMs: 1000,
    random: () => 1,
    reconnect: { baseMs: 500, maxMs: 4000, auto: true },
    onStateChange: (s) => states.push(s),
    onReconnect: () => (reconnects += 1),
    ...extra,
  });
  bridge.declareSession({ sessionId: "session_A", mode: "OBSERVE", target: { kind: "mock", host: "127.0.0.1" }, startedAt: 1 });
  return { bridge, timers, states, reconnects: () => reconnects };
}

test("refuses a non-loopback service URL (origin validation, client side)", () => {
  for (const u of ["https://collector.example.com", "http://127.0.0.1@evil.example:4577"]) {
    assert.throws(() => new BridgeClient({ serviceUrl: u, token: TOKEN }), /non-loopback/);
  }
});

test("unpaired bridge never sends and reports unpaired (non-retryable)", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc, { token: "" });
  const r = await bridge.deliver([rec("e1")]);
  assert.deepEqual(r, { ok: false, reason: "unpaired", retryable: false, error: "not paired: set the service token in Options" });
  assert.equal(svc.requests.length, 0);
  assert.equal(bridge.state, "unpaired");
});

test("deliver: handshake, one session registration, authenticated batch, all acked", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc);
  const r1 = await bridge.deliver([rec("e1"), rec("e2", { seq: 1 })]);
  const r2 = await bridge.deliver([rec("e3", { seq: 2 })]);
  assert.ok(r1.ok && r2.ok);
  if (r1.ok) assert.deepEqual(r1.ackIds, ["e1", "e2"]);
  assert.equal(svc.events.size, 3);
  const paths = svc.requests.map((r) => r.url.replace(URL_, ""));
  assert.deepEqual(paths, ["/v1/bridge/handshake", "/v1/sessions", "/v1/events", "/v1/events"]);
  for (const r of svc.requests) assert.equal(r.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(bridge.state, "connected");
});

test("events are redacted + validated client-side; invalid ones are never sent", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc);
  const r = await bridge.deliver([
    rec("ok1", { metadata: { password: "hunter2", note: "a@b.com" } }),
    rec("bad1", { action: "hack" as never }),
  ]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.ackIds, ["ok1"]);
  assert.equal(r.rejected[0]?.id, "bad1");
  assert.equal(r.rejected[0]?.code, "LOCAL_INVALID");
  const sent = JSON.stringify(svc.events.get("ok1"));
  assert.ok(!sent.includes("hunter2") && !sent.includes("a@b.com"));
  assert.equal(svc.events.has("bad1"), false);
});

test("service-side invalid events are terminal rejections; the rest are acked", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc);
  const r = await bridge.deliver([rec("g1"), rec("p1", { page: "/poison" })]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.ackIds, ["g1"]);
  assert.deepEqual(r.rejected.map((x) => [x.id, x.code]), [["p1", "INVALID_EVENT"]]);
});

test("UNKNOWN_SESSION (service DB reset) → re-register and resend once", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc);
  await bridge.deliver([rec("a1")]);
  svc.sessions.clear(); // simulate the service losing its database
  const r = await bridge.deliver([rec("a2", { seq: 1 })]);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.ackIds, ["a2"]);
  assert.ok(svc.events.has("a2"));
  assert.ok(svc.sessions.has("session_A"));
});

test("retrying an already-delivered batch is safe (idempotent ingestion)", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc);
  await bridge.deliver([rec("d1")]);
  const again = await bridge.deliver([rec("d1")]);
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.ackIds, ["d1"]);
  assert.equal(svc.events.size, 1);
});

test("413 → adaptive chunk halving until the batch fits", async () => {
  const svc = new FakeService();
  svc.maxBatch = 2; // service advertises 2 but we pretend the handshake said more
  const { bridge } = client(svc);
  await bridge.handshake();
  svc.maxBatch = 1; // service tightened its limit after the handshake
  const r = await bridge.deliver([rec("c1"), rec("c2", { seq: 1 }), rec("c3", { seq: 2 })]);
  assert.ok(r.ok);
  assert.equal(svc.events.size, 3);
});

test("timeout → offline + retryable, reconnect with backoff, onReconnect on recovery", async () => {
  const svc = new FakeService();
  svc.mode = "hang";
  const { bridge, timers, states, reconnects } = client(svc);
  const pending = bridge.deliver([rec("t1")]);
  await timers.advance(1000); // request timeout
  const r = await pending;
  assert.deepEqual([r.ok, !r.ok && r.reason, !r.ok && r.retryable], [false, "timeout", true]);
  assert.equal(bridge.state, "offline");
  assert.deepEqual(timers.scheduledDelays(), [500], "first reconnect after base backoff");

  svc.mode = "normal";
  await timers.advance(500); // reconnect → handshake succeeds
  await settle();
  assert.equal(bridge.state, "connected");
  assert.equal(reconnects(), 1);
  assert.ok(states.includes("offline") && states.at(-1) === "connected");
});

test("reconnect backoff grows exponentially and is capped", async () => {
  const svc = new FakeService();
  svc.mode = "down";
  const { bridge, timers } = client(svc);
  await bridge.connect();
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    delays.push(timers.scheduledDelays()[0] as number);
    await timers.advance(delays.at(-1) as number);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 4000]);
  bridge.close();
  assert.equal(timers.pending, 0, "close() cancels reconnects");
});

test("401 → auth_failed (non-retryable), 403 → forbidden, 429/5xx → retryable", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc, { token: "wrong-token-0123456789" });
  const r = await bridge.deliver([rec("x")]);
  assert.deepEqual([r.ok, !r.ok && r.reason, !r.ok && r.retryable], [false, "auth", false]);
  assert.equal(bridge.state, "auth_failed");

  for (const [status, reason, retryable] of [
    [403, "forbidden", false],
    [429, "rate_limited", true],
    [503, "server", true],
  ] as const) {
    const s2 = new FakeService();
    s2.forceStatus = { path: "/v1/bridge/handshake", status, times: 1 };
    const { bridge: b2 } = client(s2);
    const res = await b2.deliver([rec("y")]);
    assert.equal(!res.ok && res.reason, reason, `status ${status}`);
    assert.equal(!res.ok && res.retryable, retryable, `status ${status}`);
  }
});

test("handshake rejects a non-lab endpoint or an incompatible contract", async () => {
  const other = new FakeService();
  other.service = "some-other-app";
  const { bridge: b1 } = client(other);
  const r1 = await b1.deliver([rec("z")]);
  assert.equal(!r1.ok && r1.reason, "incompatible");
  assert.equal(b1.state, "incompatible");

  const future = new FakeService();
  future.contractVersion = 2;
  const { bridge: b2 } = client(future);
  assert.equal((await b2.connect()), "incompatible");
});

test("session end is queued while offline and delivered with the client end time", async () => {
  const svc = new FakeService();
  const { bridge, timers } = client(svc);
  await bridge.deliver([rec("s1")]);
  svc.mode = "down";
  assert.equal(await bridge.endSession("session_A", 1_750_000_123_000), false);
  assert.deepEqual(bridge.pendingEnds, [{ sessionId: "session_A", endedAt: 1_750_000_123_000 }]);
  svc.mode = "normal";
  await timers.advance(500); // auto-reconnect flushes pending ends
  assert.equal(svc.ends.get("session_A"), 1_750_000_123_000);
  assert.deepEqual(bridge.pendingEnds, []);
});

test("a single network failure (stale socket after a service restart) is retried immediately", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc);
  await bridge.deliver([rec("r1")]);
  svc.failNext = 1;
  const r = await bridge.deliver([rec("r2", { seq: 1 })]);
  assert.ok(r.ok, "recovered within the same call");
  assert.equal(bridge.state, "connected");
  assert.ok(svc.events.has("r2"));

  svc.failNext = 2; // two consecutive failures are a real outage → offline, retryable
  const r3 = await bridge.deliver([rec("r3", { seq: 2 })]);
  assert.deepEqual([r3.ok, !r3.ok && r3.reason], [false, "transport"]);
  assert.equal(bridge.state, "offline");
});

test("health probe is unauthenticated and never throws", async () => {
  const svc = new FakeService();
  const { bridge } = client(svc, { token: "" });
  assert.deepEqual(await bridge.health(), { reachable: true, ok: true, status: 200, safetyMode: "OBSERVE" });
  svc.mode = "down";
  const h = await bridge.health();
  assert.equal(h.reachable, false);
  assert.match(h.error ?? "", /unreachable/);
});
