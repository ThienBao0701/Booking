/**
 * E2E: extension Recorder → BridgeClient (real fetch) → real lab service (HTTP + SQLite).
 * No fakes on the delivery path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Recorder } from "../../extension/src/recorder/recorder.ts";
import { MemoryQueue } from "../../extension/src/recorder/queue.ts";
import { BridgeClient } from "../../extension/src/bridge/client.ts";
import { authedGet, startLabService, type LabServiceHandle } from "./harness.ts";

interface StoredRow {
  id: string;
  seq: number;
  kind: string;
  workflow: string | null;
  data: string;
}

function pipeline(svc: { url: string; token: string }) {
  const bridge = new BridgeClient({
    serviceUrl: svc.url,
    token: svc.token,
    timeoutMs: 2000,
    reconnect: { baseMs: 50, maxMs: 200, auto: false },
  });
  const queue = new MemoryQueue();
  const recorder = new Recorder({ queue, sink: bridge, batchSize: 25, flushIntervalMs: 60_000 });
  return { bridge, queue, recorder };
}

async function events(svc: LabServiceHandle, sessionId: string): Promise<StoredRow[]> {
  return (await authedGet<{ events: StoredRow[] }>(svc, `/v1/sessions/${sessionId}/events`)).events;
}

test("recorded workflow lands in the service: ordered, labelled, redacted at rest", async () => {
  const svc = await startLabService();
  const { bridge, recorder } = pipeline(svc);
  try {
    const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "mock", host: "127.0.0.1" } });
    bridge.declareSession(s);
    recorder.record({ action: "page_state", page: "http://127.0.0.1:4599/?sid=abc", tabId: 1, view: "login", metadata: {} });
    recorder.record({ action: "change", page: "/", tabId: 1, view: "login", target: { selector: "#login-username" }, metadata: { filled: true } });
    recorder.record({ action: "change", page: "/", tabId: 1, view: "login", target: { selector: "#pw", name: "password" }, metadata: { sensitive: true, password: "hunter2" } });
    recorder.record({ action: "click", page: "/", tabId: 1, view: "login", target: { selector: "#login-submit", label: "Log in" }, metadata: {} });
    recorder.record({ action: "page_state", page: "/", tabId: 1, view: "reservations", metadata: { note: "guest a@b.com" } });
    recorder.record({ action: "click", page: "/", tabId: 1, view: "reservations", target: { selector: "button[data-cancel]" }, metadata: {} });

    const r = await recorder.flush({ manual: true });
    assert.equal(r.status, "ok");
    assert.equal(recorder.stats.queueSize, 0);
    assert.equal(bridge.state, "connected");

    const rows = await events(svc, s.sessionId);
    assert.equal(rows.length, recorder.stats.recorded, "every recorded event is stored");
    assert.deepEqual(rows.map((e) => e.seq), rows.map((_, i) => i), "seq order preserved, gap-free");
    const labels = rows.filter((e) => e.kind === "WORKFLOW_TRANSITION").map((e) => e.workflow);
    assert.deepEqual(labels, ["LOGIN", "RESERVATION", "CANCELLATION"]);
    const all = JSON.stringify(rows);
    assert.ok(!all.includes("hunter2"), "password never at rest");
    assert.ok(!all.includes("a@b.com"), "PII never at rest");
    assert.ok(!all.includes("sid=abc"), "query strings never at rest");

    await recorder.endSession();
    await bridge.endSession(s.sessionId, 1_750_000_999_000);
    const session = await authedGet<{ session: { endedAt: number } }>(svc, `/v1/sessions/${s.sessionId}`);
    assert.equal(session.session.endedAt, 1_750_000_999_000, "client end time recorded");
  } finally {
    recorder.dispose();
    await svc.close();
  }
});

test("offline → service restarts on the same port → queued events delivered, none lost or duplicated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-e2e-restart-"));
  const dbPath = join(dir, "lab.sqlite");
  let svc = await startLabService({ dbPath });
  const port = svc.port;
  const { bridge, recorder, queue } = pipeline(svc);
  const dispose = () => recorder.dispose();
  try {
    const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "observe" } });
    bridge.declareSession(s);
    recorder.record({ action: "click", page: "/", tabId: 1, target: { selector: "#a" }, metadata: {} });
    assert.equal((await recorder.flush({ manual: true })).status, "ok");

    await svc.close(); // service goes down (e.g. crash / Windows restart)
    for (let i = 0; i < 5; i++) recorder.record({ action: "click", page: "/", tabId: 1, target: { selector: `#off${i}` }, metadata: {} });
    const offline = await recorder.flush({ manual: true });
    assert.equal(offline.status, "retry_scheduled");
    assert.equal(bridge.state, "offline");
    assert.equal(await queue.size(), 5, "events retained while offline");

    svc = await startLabService({ port, dbPath }); // watchdog brings it back on the same port + DB
    const online = await recorder.flush({ manual: true });
    assert.equal(online.status, "ok");
    assert.equal(bridge.state, "connected");
    const rows = await events(svc, s.sessionId);
    assert.equal(rows.length, 7, "session_start + 1 + 5, no loss");
    assert.equal(new Set(rows.map((e) => e.id)).size, rows.length, "no duplicates");
  } finally {
    dispose();
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service database reset → bridge re-registers the session and resends", async () => {
  const svc1 = await startLabService();
  const { bridge, recorder } = pipeline(svc1);
  const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "observe" } });
  bridge.declareSession(s);
  recorder.record({ action: "click", page: "/", target: { selector: "#before" }, metadata: {} });
  await recorder.flush({ manual: true });
  const port = svc1.port;
  await svc1.close();

  const svc2 = await startLabService({ port }); // fresh, empty database on the same port
  try {
    recorder.record({ action: "click", page: "/", target: { selector: "#after" }, metadata: {} });
    const r = await recorder.flush({ manual: true });
    assert.equal(r.status, "ok");
    assert.equal(recorder.stats.rejected, 0, "nothing rejected: session was re-registered");
    const rows = await events(svc2, s.sessionId);
    assert.equal(rows.length, 1);
  } finally {
    recorder.dispose();
    await svc2.close();
  }
});

test("wrong token → delivery blocked (401) without data loss; re-pair recovers", async () => {
  const svc = await startLabService();
  const disposers: Array<() => void> = [];
  try {
    const bad = new BridgeClient({ serviceUrl: svc.url, token: "wrong-token-000000000000", reconnect: { baseMs: 50, maxMs: 50, auto: false } });
    const queue = new MemoryQueue();
    const recorder = new Recorder({ queue, sink: bad, flushIntervalMs: 60_000 });
    disposers.push(() => recorder.dispose());
    const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "observe" } });
    recorder.record({ action: "click", page: "/", target: { selector: "#x" }, metadata: {} });
    await recorder.flush({ manual: true });
    assert.equal(recorder.stats.blocked, "auth");
    assert.equal(bad.state, "auth_failed");
    assert.equal(await queue.size(), 2);

    const good = new BridgeClient({ serviceUrl: svc.url, token: svc.token });
    good.declareSession(s);
    recorder.setSink(good);
    assert.equal((await recorder.flush({ manual: true })).status, "ok");
    assert.equal((await events(svc, s.sessionId)).length, 2);
  } finally {
    disposers.forEach((d) => d());
    await svc.close();
  }
});
