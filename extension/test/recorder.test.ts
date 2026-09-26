import { test } from "node:test";
import assert from "node:assert/strict";

import { Recorder, type RecorderOptions } from "../src/recorder/recorder.ts";
import { MemoryQueue } from "../src/recorder/queue.ts";
import { toValidLabEvent } from "../src/shared.ts";
import { FakeSink, FakeTimers, deterministicIdEnv, settle } from "./fakes.ts";

function setup(overrides: Partial<RecorderOptions> = {}) {
  const timers = new FakeTimers();
  const queue = new MemoryQueue();
  const sink = new FakeSink();
  const recorder = new Recorder({
    queue,
    sink,
    timers,
    idEnv: deterministicIdEnv(timers),
    batchSize: 10,
    flushIntervalMs: 1000,
    random: () => 1, // no jitter → exact backoff delays
    ...overrides,
  });
  return { timers, queue, sink, recorder };
}

const start = (r: Recorder) => r.startSession({ mode: "OBSERVE", target: { kind: "mock", host: "127.0.0.1" } });

test("nothing is recorded without an active session", () => {
  const { recorder } = setup();
  assert.equal(recorder.record({ action: "click", page: "/" }), undefined);
  assert.equal(recorder.stats.recorded, 0);
});

test("events follow the standardized schema and convert to valid wire events", async () => {
  const { recorder, timers } = setup();
  const s = start(recorder);
  const ev = recorder.record({
    action: "click",
    page: "http://127.0.0.1:4599/?token=abc#frag",
    tabId: 3,
    view: "rooms",
    target: { tag: "button", selector: "#room-submit", label: "Add room" },
    metadata: { view: "rooms" },
  });
  assert.ok(ev);
  assert.equal(ev.session_id, s.sessionId);
  assert.equal(ev.timestamp, timers.now());
  assert.equal(ev.tab_id, 3);
  assert.equal(ev.page, "/", "query string and fragment must be stripped");
  assert.equal(ev.workflow, "ROOM_SETUP");
  assert.equal(ev.action, "click");
  assert.equal(ev.target?.selector, "#room-submit");
  assert.ok(toValidLabEvent(ev).ok);
});

test("sensitive metadata is redacted and raw values are stripped before queueing", async () => {
  const { recorder, queue } = setup();
  start(recorder);
  recorder.record({
    action: "change",
    page: "/login",
    metadata: { password: "hunter2", value: "typed text", nested: { innerText: "x", ok: 1 }, note: "me@x.com" },
  });
  await recorder.settled();
  const queued = await queue.peek(10);
  const json = JSON.stringify(queued);
  assert.ok(!json.includes("hunter2"));
  assert.ok(!json.includes("typed text"));
  assert.ok(!json.includes("me@x.com"));
  const change = queued.find((e) => e.action === "change");
  assert.deepEqual(change?.metadata.nested, { ok: 1 });
  assert.equal(change?.metadata.value, undefined);
});

test("workflow transitions are emitted when the workflow changes (per tab)", () => {
  const { recorder } = setup();
  start(recorder);
  recorder.record({ action: "page_state", page: "/", view: "login", tabId: 1 });
  recorder.record({ action: "click", page: "/", view: "login", tabId: 1, target: { selector: "#login-submit" } });
  recorder.record({ action: "page_state", page: "/", view: "reservations", tabId: 1 });
  recorder.record({ action: "click", page: "/", view: "reservations", tabId: 1, target: { selector: "button[data-cancel]" } });
  const s = recorder.stats;
  // session_start + (transition LOGIN + page_state) + click + (transition RESERVATION + page_state)
  // + (transition CANCELLATION + click)
  assert.equal(s.recorded, 8);
});

test("double-fired identical events are deduplicated and seq stays gap-free", async () => {
  const { recorder, queue } = setup();
  start(recorder);
  const a = recorder.record({ action: "click", page: "/", target: { selector: "#x" } });
  const b = recorder.record({ action: "click", page: "/", target: { selector: "#x" } }); // same ms → duplicate
  assert.ok(a);
  assert.equal(b, undefined);
  assert.equal(recorder.stats.deduplicated, 1);
  const c = recorder.record({ action: "click", page: "/", target: { selector: "#y" } });
  await recorder.settled();
  const seqs = (await queue.peek(10)).map((e) => e.seq);
  assert.deepEqual(seqs, [0, 1, 2], `seq must be contiguous, got ${seqs.join(",")}`);
  assert.equal(c?.seq, 2);
});

test("debounced flush delivers after the quiet interval", async () => {
  const { recorder, sink, timers } = setup();
  start(recorder);
  recorder.record({ action: "click", page: "/", target: { selector: "#a" } });
  await settle();
  assert.equal(sink.calls.length, 0, "no delivery before the debounce interval");
  await timers.advance(1000);
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.delivered.length, 2); // session_start + click
  assert.equal(recorder.stats.delivered, 2);
  assert.equal(recorder.stats.queueSize, 0);
});

test("batch size triggers an immediate flush and batches respect the size", async () => {
  const { recorder, sink } = setup({ batchSize: 5 });
  start(recorder);
  for (let i = 0; i < 9; i++) recorder.record({ action: "click", page: "/", target: { selector: `#b${i}` } });
  await settle(10);
  assert.ok(sink.calls.length >= 1);
  for (const c of sink.calls) assert.ok(c.length <= 5);
  assert.equal(sink.delivered.length, 10);
});

test("transport failure retries with exponential backoff, then delivers without loss", async () => {
  const { recorder, sink, timers } = setup({ retry: { baseMs: 1000, maxMs: 8000 } });
  sink.script.push(
    { ok: false, reason: "transport", retryable: true, error: "ECONNREFUSED" },
    { ok: false, reason: "timeout", retryable: true, error: "timeout" },
  );
  start(recorder);
  recorder.record({ action: "click", page: "/", target: { selector: "#a" } });
  await recorder.flush();
  assert.deepEqual(timers.scheduledDelays(), [1000]);
  await timers.advance(1000); // retry #2 fails → backoff doubles
  assert.deepEqual(timers.scheduledDelays(), [2000]);
  await timers.advance(2000); // retry #3 succeeds
  assert.equal(recorder.stats.retries, 2);
  assert.equal(sink.delivered.length, 2);
  assert.equal(recorder.stats.queueSize, 0);
  assert.equal(recorder.stats.lastDeliveryAt !== null, true);
});

test("auth failure blocks delivery without dropping data; manual flush resumes", async () => {
  const { recorder, sink, queue } = setup();
  sink.script.push({ ok: false, reason: "auth", retryable: false, error: "401" });
  start(recorder);
  recorder.record({ action: "click", page: "/", target: { selector: "#a" } });
  await recorder.flush();
  assert.equal(recorder.stats.blocked, "auth");
  assert.equal(await queue.size(), 2, "data is kept while blocked");
  assert.equal((await recorder.flush()).status, "blocked", "automatic flushes skip while blocked");
  const r = await recorder.flush({ manual: true });
  assert.equal(r.status, "ok");
  assert.equal(recorder.stats.blocked, null);
  assert.equal(await queue.size(), 0);
});

test("a poison batch (rejected_batch) is dropped and counted so the queue keeps moving", async () => {
  const { recorder, sink, queue } = setup();
  sink.script.push({ ok: false, reason: "rejected_batch", retryable: false, error: "413" });
  start(recorder);
  recorder.record({ action: "click", page: "/", target: { selector: "#a" } });
  await recorder.flush();
  assert.equal(recorder.stats.dropped, 2);
  assert.equal(await queue.size(), 0);
});

test("service-rejected events are terminal and counted, not retried", async () => {
  const { recorder, sink } = setup();
  start(recorder);
  recorder.record({ action: "click", page: "/", target: { selector: "#a" } });
  await recorder.settled();
  const queued = [...sink.calls];
  assert.equal(queued.length, 0);
  sink.script.push({ ok: true, ackIds: [], rejected: [{ id: "x", code: "INVALID_EVENT", errors: ["bad"] }] });
  await recorder.flush();
  assert.equal(recorder.stats.rejected, 1);
  assert.equal(recorder.stats.queueSize, 0);
  assert.match(recorder.stats.lastError ?? "", /INVALID_EVENT/);
});

test("queue cap drops oldest and counts them", async () => {
  const { recorder } = setup({ maxQueue: 3, batchSize: 100 });
  start(recorder);
  for (let i = 0; i < 5; i++) recorder.record({ action: "click", page: "/", target: { selector: `#q${i}` } });
  await recorder.settled();
  assert.equal(recorder.stats.dropped, 3); // 6 recorded (incl. session_start), cap 3
});

test("endSession records session_end and flushes; restoreSession continues seq", async () => {
  const { recorder, sink } = setup();
  const s = start(recorder);
  recorder.record({ action: "click", page: "/", target: { selector: "#a" } });
  const ended = await recorder.endSession();
  assert.equal(ended?.sessionId, s.sessionId);
  assert.equal(recorder.session, undefined);
  assert.deepEqual(
    sink.delivered.map((e) => e.action),
    ["session_start", "click", "session_end"],
  );

  // A service-worker restart resumes the same session from a persisted seq.
  const fresh = setup();
  fresh.recorder.restoreSession(s, 1000);
  const ev = fresh.recorder.record({ action: "click", page: "/", target: { selector: "#z" } });
  assert.equal(ev?.seq, 1000);
  assert.equal(ev?.session_id, s.sessionId);
});

test("starting a second session while one is active is refused", () => {
  const { recorder } = setup();
  start(recorder);
  assert.throws(() => start(recorder), /already active/);
});
