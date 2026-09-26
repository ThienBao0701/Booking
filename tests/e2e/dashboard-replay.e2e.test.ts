/**
 * E2E (Phase 13): the dashboard replay API drives the bundled example workflow
 * against the REAL mock Extranet — library → dry-run plan → explicit start
 * (confirmation token + acknowledgement) → live status/logs → completed run
 * persisted — and a plan the service mode does not allow causes zero side
 * effects on the mock.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import type { ReplayLibraryEntry, ReplayPrepareResult, ReplayRunStatus } from "../../shared/src/index.ts";
import { ensureMock, startLabService, type LabServiceHandle, type MockHandle } from "./harness.ts";

let mock: MockHandle;
before(async () => {
  mock = await ensureMock();
});
after(async () => {
  await mock.close();
});

async function call(svc: LabServiceHandle, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(svc.url + path, {
    method,
    headers: { authorization: `Bearer ${svc.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

/** Number of workflow events the mock has recorded (its `since` is an offset). */
async function mockTotal(): Promise<number> {
  return ((await (await fetch(`${mock.url}/api/events?since=1000000000`)).json()) as { total: number }).total;
}
async function mockLabels(actor: string, since: number): Promise<string[]> {
  const body = (await (await fetch(`${mock.url}/api/events?since=${since}`)).json()) as { events: Array<{ workflow: string; actor: string | null }> };
  return body.events.filter((e) => e.actor === actor).map((e) => e.workflow);
}

test("dashboard replay: library → plan → acknowledged start → completed run on the real mock", async () => {
  const svc = await startLabService({ safetyMode: "SIMULATE" });
  const username = `dash-${Date.now()}`;
  const propertyName = `Dash Villa ${Date.now()}`;
  try {
    const lib = await call(svc, "GET", "/v1/replay/workflows");
    assert.equal(lib.status, 200);
    assert.equal(lib.json.serviceMode, "SIMULATE");
    const entry = (lib.json.workflows as ReplayLibraryEntry[]).find((w) => w.id === "examples:mock-full-flow");
    assert.ok(entry?.valid && entry.hasExampleParams, "bundled example is listed and valid");
    const detail = await call(svc, "GET", `/v1/replay/workflows/${encodeURIComponent("examples:mock-full-flow")}`);
    assert.deepEqual(Object.keys(detail.json.exampleParams).sort(), ["propertyName", "username"]);

    const before = await mockTotal();
    const prep = await call(svc, "POST", "/v1/replay/prepare", { workflowId: "examples:mock-full-flow", mode: "SIMULATE", controller: "mock", params: { username, propertyName } });
    assert.equal(prep.status, 201);
    const { plan, confirmToken } = prep.json as ReplayPrepareResult;
    assert.equal(plan.target.kind, "mock");
    assert.equal(plan.target.baseUrl, "http://127.0.0.1:4599");
    assert.equal(plan.authorization.allowed, true);
    assert.equal(plan.stepCount, entry.steps);
    assert.ok(plan.riskNotice.length >= 2);
    assert.equal(plan.wouldExecute, true);
    assert.ok(typeof confirmToken === "string" && confirmToken.length >= 24);
    assert.equal(await mockTotal(), before, "planning is a dry run: nothing reached the mock");

    // Explicit operator action is required.
    assert.equal((await call(svc, "POST", `/v1/replay/runs/${plan.runId}/start`, { confirmToken })).status, 400);
    assert.equal((await call(svc, "POST", `/v1/replay/runs/${plan.runId}/start`, { confirmToken: "x".repeat(confirmToken?.length ?? 32), acknowledge: true })).status, 403);
    assert.equal(await mockTotal(), before);
    const started = await call(svc, "POST", `/v1/replay/runs/${plan.runId}/start`, { confirmToken, acknowledge: true });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    assert.equal((await call(svc, "POST", `/v1/replay/runs/${plan.runId}/start`, { confirmToken, acknowledge: true })).status, 409, "single use");

    let status: ReplayRunStatus = started.json;
    const logs = [...status.logs];
    const deadline = Date.now() + 60_000;
    while (!["completed", "stopped", "failed"].includes(status.state) || status.busy) {
      assert.ok(Date.now() < deadline, "run finished in time");
      await new Promise((r) => setTimeout(r, 150));
      const since = logs.at(-1)?.seq ?? 0;
      status = (await call(svc, "GET", `/v1/replay/runs/${plan.runId}?since=${since}`)).json;
      assert.ok(status.logs.every((l) => l.seq > since), "incremental logs");
      logs.push(...status.logs);
    }
    assert.equal(status.state, "completed", JSON.stringify(status.record.steps.find((s) => s.status === "failed")));
    assert.deepEqual(status.progress, { done: entry.steps, total: entry.steps });
    assert.ok(logs.some((l) => l.type === "run.completed"));
    assert.ok(!JSON.stringify(logs).includes(username) && !JSON.stringify(logs).includes(propertyName), "parameter values never appear in logs");

    const labels = await mockLabels(username, before);
    assert.deepEqual(labels, ["LOGIN", "PROPERTY_SETUP", "ROOM_SETUP", "RATE_SETUP", "RESERVATION", "CANCELLATION", "MESSAGING", "REVIEW", "PHOTO", "REPORTING"]);

    const stored = await call(svc, "GET", `/v1/runs/${plan.runId}`);
    assert.equal(stored.status, 200);
    assert.equal(stored.json.run.status, "completed");
    assert.ok(!JSON.stringify(stored.json).includes(username), "parameter values are never persisted");
    const listed = await call(svc, "GET", "/v1/replay/runs");
    assert.equal(listed.json.runs[0].runId, plan.runId);
  } finally {
    await svc.close();
  }
});

test("dashboard replay in an OBSERVE service: plan only, no confirmation, zero side effects", async () => {
  const svc = await startLabService();
  try {
    const before = await mockTotal();
    const prep = await call(svc, "POST", "/v1/replay/prepare", { workflowId: "examples:mock-full-flow", mode: "SIMULATE", controller: "mock", params: { username: "observe-only", propertyName: "x" } });
    assert.equal(prep.status, 201);
    assert.equal(prep.json.confirmToken, null);
    assert.equal(prep.json.plan.wouldExecute, false);
    assert.match(prep.json.plan.blockers.join(" "), /OBSERVE/);
    const start = await call(svc, "POST", `/v1/replay/runs/${prep.json.plan.runId}/start`, { confirmToken: "anything-anything-anything", acknowledge: true });
    assert.equal(start.status, 403);
    assert.equal(await mockTotal(), before, "the mock received no workflow actions");
    assert.equal((await call(svc, "DELETE", `/v1/replay/runs/${prep.json.plan.runId}`)).status, 200);
  } finally {
    await svc.close();
  }
});
