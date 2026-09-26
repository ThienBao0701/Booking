import { test } from "node:test";
import assert from "node:assert/strict";

import { startServiceHarness, authHeaders, TEST_TOKEN } from "./helpers.ts";
import { MAX_BATCH_EVENTS } from "../src/server.ts";
import { Store } from "../src/db/store.ts";
import type { LabEvent, RunRecord } from "../src/shared.ts";

function ev(id: string, sessionId: string, seq = 0): LabEvent {
  return {
    id,
    sessionId,
    seq,
    ts: 1_750_000_000_000 + seq,
    kind: "CLICK",
    category: "interaction",
    severity: "info",
    redacted: true,
    data: { page: "/x" },
  };
}

const post = (base: string, path: string, body: unknown, headers = authHeaders()) =>
  fetch(base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("session registration is idempotent (bridge reconnect)", async () => {
  const h = await startServiceHarness();
  try {
    const a = await post(h.base, "/v1/sessions", { sessionId: "sess-1" });
    const b = await post(h.base, "/v1/sessions", { sessionId: "sess-1" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), { sessionId: "sess-1", created: false });
    assert.equal(h.store.listSessions().length, 1);
  } finally {
    await h.close();
  }
});

test("retrying a delivered batch is idempotent — duplicates, not a 500", async () => {
  const h = await startServiceHarness();
  const published: string[] = [];
  h.bus.subscribe((m) => {
    if (m.type === "event") published.push(m.payload.id);
  });
  try {
    await post(h.base, "/v1/sessions", { sessionId: "sess-1" });
    const batch = { events: [ev("E1", "sess-1", 0), ev("E2", "sess-1", 1)] };
    const first = (await (await post(h.base, "/v1/events", batch)).json()) as Record<string, number>;
    const retry = await post(h.base, "/v1/events", batch);
    assert.equal(retry.status, 202);
    const second = (await retry.json()) as Record<string, number>;
    assert.equal(first.stored, 2);
    assert.equal(second.stored, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(h.store.countEvents("sess-1"), 2);
    assert.deepEqual(published, ["E1", "E2"], "duplicates must not be re-published on the bus");
  } finally {
    await h.close();
  }
});

test("events for an unknown session are reported with UNKNOWN_SESSION, rest of batch stored", async () => {
  const h = await startServiceHarness();
  try {
    await post(h.base, "/v1/sessions", { sessionId: "known" });
    const res = await post(h.base, "/v1/events", { events: [ev("K1", "known"), ev("U1", "ghost")] });
    assert.equal(res.status, 202);
    const body = (await res.json()) as {
      stored: number;
      invalid: number;
      invalidDetail: Array<{ index: number; id: string; code: string }>;
    };
    assert.equal(body.stored, 1);
    assert.equal(body.invalid, 1);
    assert.deepEqual(body.invalidDetail[0], {
      index: 1,
      id: "U1",
      code: "UNKNOWN_SESSION",
      errors: ["unknown session ghost"],
    });
  } finally {
    await h.close();
  }
});

test("invalid events carry their id and INVALID_EVENT code", async () => {
  const h = await startServiceHarness();
  try {
    await post(h.base, "/v1/sessions", { sessionId: "s" });
    const res = await post(h.base, "/v1/events", { events: [{ ...ev("BAD", "s"), redacted: false }] });
    const body = (await res.json()) as { invalidDetail: Array<{ id: string; code: string }> };
    assert.equal(body.invalidDetail[0]?.id, "BAD");
    assert.equal(body.invalidDetail[0]?.code, "INVALID_EVENT");
  } finally {
    await h.close();
  }
});

test("request validation: oversized batch → 413, bad JSON → 400 (not 500)", async () => {
  const h = await startServiceHarness();
  try {
    const big = { events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, i) => ev(`B${i}`, "s", i)) };
    const tooBig = await post(h.base, "/v1/events", big);
    assert.equal(tooBig.status, 413);
    const badJson = await post(h.base, "/v1/events", "{not json");
    assert.equal(badJson.status, 400);
  } finally {
    await h.close();
  }
});

test("bridge handshake requires auth and returns the contract", async () => {
  const h = await startServiceHarness();
  try {
    const noAuth = await fetch(`${h.base}/v1/bridge/handshake`);
    assert.equal(noAuth.status, 401);
    const res = await fetch(`${h.base}/v1/bridge/handshake`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.service, "lab-service");
    assert.equal(body.contractVersion, 1);
    assert.equal(body.maxBatchEvents, MAX_BATCH_EVENTS);
    assert.equal(body.safetyMode, "OBSERVE");
  } finally {
    await h.close();
  }
});

test("store.transaction rolls back the whole batch on failure", () => {
  const store = new Store(":memory:");
  store.createSession({ id: "s", startedAt: 1, mode: "OBSERVE", targetKind: "observe" });
  assert.throws(() =>
    store.transaction(() => {
      store.insertEvent(ev("T1", "s"));
      throw new Error("boom");
    }),
  );
  assert.equal(store.countEvents("s"), 0);
  store.close();
});

test("replay runs persist and round-trip (saveRun/getRun, upsert)", () => {
  const store = new Store(":memory:");
  const run: RunRecord = {
    runId: "run_1",
    workflow: "wf",
    mode: "SIMULATE",
    startedAt: 10,
    status: "running",
    checkpoints: [],
    steps: [
      { id: "s1", status: "ok", startedAt: 11, endedAt: 12, attempts: 1 },
      { id: "s2", status: "pending", attempts: 0 },
    ],
  };
  store.saveRun(run);
  store.saveRun({
    ...run,
    status: "completed",
    endedAt: 20,
    checkpoints: ["s1"],
    steps: [run.steps[0]!, { id: "s2", status: "failed", startedAt: 13, endedAt: 14, attempts: 2, error: "x" }],
  });
  const back = store.getRun("run_1");
  assert.equal(back?.status, "completed");
  assert.equal(back?.endedAt, 20);
  assert.deepEqual(back?.checkpoints, ["s1"]);
  assert.equal(back?.steps.length, 2);
  assert.equal(back?.steps[1]?.status, "failed");
  assert.equal(back?.steps[1]?.error, "x");
  assert.equal(store.getRun("missing"), undefined);
  store.close();
});
