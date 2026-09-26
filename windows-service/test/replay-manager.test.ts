/** Phase 13: ReplayManager (plan → explicit confirmation → controlled execution) and its HTTP API. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { AuthorizationRecord, RunRecord, SafetyMode, WorkflowFile } from "../src/shared.ts";
import { ReplayManager, ReplayManagerError, type RunStatusView } from "../src/automation/manager.ts";
import { WorkflowLibrary } from "../src/automation/library.ts";
import { createApiServer } from "../src/server.ts";
import { Store } from "../src/db/store.ts";
import { EventBus } from "../src/eventbus.ts";
import { Logger } from "../src/logger.ts";
import { RateLimiter } from "../src/security.ts";
import type { ServiceConfig } from "../src/config.ts";
import { ScriptedController } from "./fake-controller.ts";
import { SessionBuilder, mockFlow, persist } from "./analysis-fixtures.ts";

const MOCK = "http://127.0.0.1:4599";
const SECRET = "SECRET-TEST-VALUE-4711";
const AUTH: AuthorizationRecord = { owner: "qa-team", system: "staging-extranet", grantedBy: "lead", acknowledgedAt: 1 };

function wf(steps: WorkflowFile["steps"], target: WorkflowFile["target"] = { kind: "mock", baseUrl: MOCK }): WorkflowFile {
  return { workflow: "managed", version: 1, target, steps };
}
const FLOW = wf([
  { id: "open", action: "navigate", target: "/" },
  { id: "user", action: "type", target: "#login-username", value: "{{username}}" },
  { id: "login", action: "click", target: "#login-submit", checkpoint: true },
  { id: "a", action: "click", target: "#a" },
  { id: "b", action: "click", target: "#b" },
  { id: "done", action: "waitFor", target: "#done" },
]);

function manager(opts: { mode?: SafetyMode; now?: () => number } = {}) {
  let serviceMode: SafetyMode = opts.mode ?? "SIMULATE";
  const controllers: ScriptedController[] = [];
  const persisted: RunRecord[] = [];
  const m = new ReplayManager({
    serviceMode: () => serviceMode,
    controllerFactory: () => {
      const c = new ScriptedController();
      controllers.push(c);
      return c;
    },
    persist: (r) => persisted.push(structuredClone(r)),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { m, controllers, persisted, setMode: (x: SafetyMode) => (serviceMode = x) };
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function rejectsCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ReplayManagerError, String(e));
    assert.equal(e.code, code, e.message);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("prepare returns the full plan with a single-use confirmation; nothing is launched", async () => {
  const { m, controllers } = manager();
  const { plan, confirmToken } = await m.prepare({ workflow: FLOW, source: "test", mode: "SIMULATE", controller: "mock", params: { username: SECRET } });
  assert.equal(plan.workflow, "managed");
  assert.deepEqual(plan.target, { kind: "mock", baseUrl: MOCK });
  assert.equal(plan.authorization.allowed, true);
  assert.equal(plan.stepCount, 6);
  assert.deepEqual(plan.requiredParams, ["username"]);
  assert.deepEqual(plan.missingParams, []);
  assert.equal(plan.wouldExecute, true);
  assert.ok(plan.riskNotice.some((r) => /local mock Extranet only/.test(r)));
  assert.ok(plan.riskNotice.some((r) => /never stored or logged/.test(r)));
  assert.match(String(confirmToken), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(controllers[0]?.launched, 0, "no controller action before start");
  assert.equal(m.status(plan.runId).phase, "prepared");
});

test("blockers: service safety mode ceiling, missing params, invalid workflow, wrong controller for the target", async () => {
  const observe = manager({ mode: "OBSERVE" });
  const p1 = await observe.m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: "x" } });
  assert.equal(p1.plan.wouldExecute, false);
  assert.equal(p1.confirmToken, null);
  assert.ok(p1.plan.blockers.some((b) => /service runs in OBSERVE/.test(b)));
  const { m } = manager();
  const p2 = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock" });
  assert.deepEqual([p2.plan.wouldExecute, p2.plan.missingParams], [false, ["username"]]);
  await rejectsCode(() => m.prepare({ workflow: { workflow: "x" }, source: "t", mode: "SIMULATE", controller: "mock" }), "invalid_workflow");
  const authz = wf([{ id: "o", action: "navigate", target: "/" }], { kind: "authorized", baseUrl: "https://staging.example.test", authorization: AUTH });
  const p3 = await m.prepare({ workflow: authz, source: "t", mode: "SIMULATE", controller: "mock" });
  assert.equal(p3.plan.authorization.allowed, false, "mock controller never drives authorized targets");
  assert.equal(p3.confirmToken, null);
});

test("authorized targets: the plan shows the authorization record, browser allowlist and a real-action risk notice", async () => {
  const { m } = manager({ mode: "AUTHORIZED_AUTOMATION" });
  const authz = wf([{ id: "o", action: "navigate", target: "/" }], { kind: "authorized", baseUrl: "https://staging.example.test", authorization: AUTH });
  const noList = await m.prepare({ workflow: authz, source: "t", mode: "AUTHORIZED_AUTOMATION", controller: "browser" });
  assert.equal(noList.plan.authorization.browser?.code, "TARGET_NOT_ALLOWLISTED");
  assert.equal(noList.confirmToken, null);
  const ok = await m.prepare({ workflow: authz, source: "t", mode: "AUTHORIZED_AUTOMATION", controller: "browser", allowOrigins: ["https://staging.example.test"] });
  assert.equal(ok.plan.wouldExecute, true);
  assert.deepEqual(ok.plan.authorization.record, AUTH);
  assert.deepEqual(ok.plan.authorization.browser?.origins, ["https://staging.example.test"]);
  assert.ok(ok.plan.riskNotice.some((r) => /REAL actions on https:\/\/staging\.example\.test \(staging-extranet/.test(r)));
  assert.ok(ok.plan.riskNotice.some((r) => /real browser \(Chromium\)/.test(r)));
});

test("start requires acknowledgement and the exact, unexpired, single-use confirmation; the ceiling is rechecked", async () => {
  let now = 1_000_000;
  const { m, setMode } = manager({ now: () => now });
  const a = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: "x" } });
  await rejectsCode(() => m.start(a.plan.runId, { confirmToken: a.confirmToken }), "acknowledgement_required");
  await rejectsCode(() => m.start(a.plan.runId, { confirmToken: "nope", acknowledge: true }), "invalid_confirmation");
  const b = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: "x" } });
  await rejectsCode(() => m.start(a.plan.runId, { confirmToken: b.confirmToken, acknowledge: true }), "invalid_confirmation");
  now += 11 * 60_000;
  await rejectsCode(() => m.start(a.plan.runId, { confirmToken: a.confirmToken, acknowledge: true }), "confirmation_expired");
  const c = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: "x" } });
  setMode("OBSERVE");
  await rejectsCode(() => m.start(c.plan.runId, { confirmToken: c.confirmToken, acknowledge: true }), "mode_ceiling");
  setMode("SIMULATE");
  m.start(c.plan.runId, { confirmToken: c.confirmToken, acknowledge: true });
  await rejectsCode(() => m.start(c.plan.runId, { confirmToken: c.confirmToken, acknowledge: true }), "already_started");
  await until(() => m.status(c.plan.runId).state === "completed");
  await rejectsCode(() => m.status("run_missing"), "run_not_found");
});

test("controls: pause, step, checkpoint, rollback, resume; progress and logs; parameter values never logged or persisted", async () => {
  const { m, controllers, persisted } = manager();
  const { plan, confirmToken } = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: SECRET } });
  const c = controllers[0] as ScriptedController;
  let release!: () => void;
  c.behaviors.set("#a", { gate: new Promise<void>((r) => (release = r)) });
  m.start(plan.runId, { confirmToken, acknowledge: true });
  await until(() => c.calls.includes("click #a"));
  m.control(plan.runId, "pause");
  release();
  await until(() => m.status(plan.runId).state === "paused");
  let s = m.status(plan.runId);
  assert.deepEqual([s.cursor, s.progress], [4, { done: 4, total: 6 }]);
  await m.control(plan.runId, "checkpoint", { label: "mine" });
  m.control(plan.runId, "step");
  await until(() => m.status(plan.runId).cursor === 5 && !m.status(plan.runId).busy);
  await m.control(plan.runId, "rollback", { checkpointId: "mine" });
  assert.equal(m.status(plan.runId).cursor, 4);
  await rejectsCode(() => m.control(plan.runId, "retry"), "invalid_state");
  m.control(plan.runId, "resume");
  await until(() => m.status(plan.runId).state === "completed");
  s = m.status(plan.runId);
  assert.equal(s.phase, "completed");
  assert.deepEqual(s.progress, { done: 6, total: 6 });
  assert.equal(c.typed["#login-username"], SECRET, "the value reached the controller");
  const logText = JSON.stringify(s.logs);
  assert.ok(logText.includes("run.completed") && logText.includes("started by operator"));
  assert.ok(!logText.includes(SECRET), "param value never logged");
  assert.ok(persisted.length > 0 && !JSON.stringify(persisted).includes(SECRET), "param value never persisted");
  assert.ok(m.status(plan.runId, s.logs.at(-2)!.seq).logs.length === 1, "incremental log polling");
});

test("failure → retry; stop while a step hangs; only one run at a time; discard", async () => {
  const { m, controllers } = manager();
  const one = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: "x" } });
  const c1 = controllers[0] as ScriptedController;
  c1.behaviors.set("#b", { failTimes: 1 });
  m.start(one.plan.runId, { confirmToken: one.confirmToken, acknowledge: true });
  await until(() => m.status(one.plan.runId).state === "failed" && !m.status(one.plan.runId).busy);
  const two = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: "y" } });
  await rejectsCode(() => m.start(two.plan.runId, { confirmToken: two.confirmToken, acknowledge: true }), "another_run_active");
  m.control(one.plan.runId, "retry");
  await until(() => m.status(one.plan.runId).state === "completed");

  const c2 = controllers[1] as ScriptedController;
  c2.behaviors.set("#a", { gate: new Promise<void>(() => undefined) });
  m.start(two.plan.runId, { confirmToken: two.confirmToken, acknowledge: true });
  await until(() => c2.calls.includes("click #a"));
  const stopped = (await m.control(two.plan.runId, "stop")) as RunStatusView;
  assert.equal(stopped.state, "stopped");
  assert.equal(c2.closed, 1, "controller closed");
  await rejectsCode(() => m.control(two.plan.runId, "stop"), "invalid_state");

  const three = await m.prepare({ workflow: FLOW, source: "t", mode: "SIMULATE", controller: "mock", params: { username: "z" } });
  m.discard(three.plan.runId);
  await rejectsCode(() => m.status(three.plan.runId), "run_not_found");
  await rejectsCode(() => m.discard(one.plan.runId), "already_started");
  await rejectsCode(() => m.control(one.plan.runId, "pause"), "invalid_state");
});

// ------------------------------------------------------------------- HTTP

async function harness(mode: SafetyMode = "SIMULATE") {
  const dir = mkdtempSync(join(tmpdir(), "lab-replay-"));
  mkdirSync(join(dir, "workflows"));
  writeFileSync(join(dir, "workflows", "mine.json"), JSON.stringify(FLOW));
  writeFileSync(join(dir, "workflows", "broken.json"), "{");
  const store = new Store(":memory:");
  const config: ServiceConfig = { host: "127.0.0.1", port: 0, dataDir: dir, authToken: "replay-test-token-abcdefghij", safetyMode: mode, allowedOrigins: [], rateLimit: { windowMs: 1000, max: 1000 }, logLevel: "error" };
  const controllers: ScriptedController[] = [];
  const replay = new ReplayManager({ serviceMode: () => config.safetyMode, controllerFactory: () => { const c = new ScriptedController(); controllers.push(c); return c; }, persist: (r) => store.saveRun(r) });
  const server = createApiServer({ config, store, bus: new EventBus(), logger: new Logger({ dir: join(dir, "logs"), level: "error", stdout: false }), limiter: new RateLimiter(1000, 1000), replay, library: new WorkflowLibrary({ libraryDir: join(dir, "workflows") }) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${config.port}`;
  const call = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${config.authToken}`, "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as T };
  };
  return { store, base, call, controllers, config, close: () => new Promise<void>((r) => server.close(() => (store.close(), rmSync(dir, { recursive: true, force: true }), r()))) };
}

test("HTTP: library, plan, confirmed start, polling, controls and persistence", async () => {
  const h = await harness();
  try {
    const lib = await h.call<{ workflows: Array<{ id: string; valid: boolean; hasExampleParams: boolean; steps: number }>; serviceMode: string }>("GET", "/v1/replay/workflows");
    assert.equal(lib.json.serviceMode, "SIMULATE");
    const example = lib.json.workflows.find((w) => w.id === "examples:mock-full-flow");
    assert.ok(example?.valid && example.hasExampleParams && example.steps > 40);
    assert.ok(lib.json.workflows.find((w) => w.id === "library:mine")?.valid);
    assert.equal(lib.json.workflows.find((w) => w.id === "library:broken")?.valid, false);
    const one = await h.call<{ workflow: WorkflowFile; exampleParams: Record<string, string> }>("GET", "/v1/replay/workflows/examples:mock-full-flow");
    assert.ok(one.json.exampleParams.username);
    assert.equal((await h.call("GET", "/v1/replay/workflows/examples:..%2F..%2Fpackage")).status, 404);

    const prep = await h.call<{ plan: { runId: string; stepCount: number; wouldExecute: boolean }; confirmToken: string }>("POST", "/v1/replay/prepare", { workflowId: "library:mine", mode: "SIMULATE", controller: "mock", params: { username: SECRET } });
    assert.equal(prep.status, 201);
    const id = prep.json.plan.runId;
    assert.equal((await h.call("POST", `/v1/replay/runs/${id}/start`, { confirmToken: prep.json.confirmToken })).status, 400);
    assert.equal((await h.call("POST", `/v1/replay/runs/${id}/start`, { confirmToken: "x".repeat(32), acknowledge: true })).status, 403);
    assert.equal((await h.call("POST", `/v1/replay/runs/${id}/start`, { confirmToken: prep.json.confirmToken, acknowledge: true })).status, 200);
    let st: RunStatusView | undefined;
    await until(() => false, 0).catch(() => undefined);
    for (let i = 0; i < 100; i++) {
      st = (await h.call<RunStatusView>("GET", `/v1/replay/runs/${id}`)).json;
      if (st.state === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(st?.state, "completed");
    const persisted = await h.call<{ run: RunRecord }>("GET", `/v1/runs/${id}`);
    assert.equal(persisted.json.run.status, "completed");
    assert.ok(!JSON.stringify(persisted.json).includes(SECRET));
    assert.equal((await h.call("POST", `/v1/replay/runs/${id}/resume`, {})).status, 409);
    const list = await h.call<{ runs: Array<{ runId: string }> }>("GET", "/v1/replay/runs");
    assert.ok(list.json.runs.some((r) => r.runId === id));

    // Draft from a recording, and inline workflows.
    persist(h.store, mockFlow("rec-1"));
    const draft = await h.call<{ plan: { source: string; stepCount: number } }>("POST", "/v1/replay/prepare", { sessionId: "rec-1", mode: "SIMULATE", controller: "mock" });
    assert.equal(draft.status, 201);
    assert.equal(draft.json.plan.source, "recording:rec-1");
    assert.equal((await h.call("POST", "/v1/replay/prepare", { sessionId: "rec-1", baseUrl: "https://evil.example" })).status, 400);
    assert.equal((await h.call("POST", "/v1/replay/prepare", { workflow: FLOW, controller: "mock", params: { username: "a" } })).status, 201);
    const b = new SessionBuilder("rec-2");
    b.start();
    persist(h.store, b);
  } finally {
    await h.close();
  }
});

test("HTTP: validation, auth, origin and the OBSERVE ceiling", async () => {
  const h = await harness("OBSERVE");
  try {
    for (const bad of [{ workflowId: "library:mine", mode: "GOD" }, { workflowId: "library:mine", controller: "cdp" }, { workflowId: "library:mine", params: { username: 5 } }, { workflowId: "library:mine", allowOrigins: "x" }, {}]) {
      assert.equal((await h.call("POST", "/v1/replay/prepare", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await h.call("POST", "/v1/replay/prepare", { workflowId: "library:nope" })).status, 404);
    const prep = await h.call<{ plan: { runId: string; wouldExecute: boolean; blockers: string[] }; confirmToken: string | null }>("POST", "/v1/replay/prepare", { workflowId: "library:mine", params: { username: "x" } });
    assert.deepEqual([prep.json.plan.wouldExecute, prep.json.confirmToken], [false, null], "dry run only in OBSERVE");
    assert.equal((await h.call("POST", `/v1/replay/runs/${prep.json.plan.runId}/start`, { confirmToken: "", acknowledge: true })).status, 403);
    assert.equal(h.controllers[0]?.launched, 0);
    const noAuth = await fetch(`${h.base}/v1/replay/workflows`);
    assert.equal(noAuth.status, 401);
    assert.equal((await h.call("GET", "/v1/replay/workflows", undefined, { origin: "http://127.0.0.1:4599" })).status, 403);
    assert.equal((await h.call("GET", "/v1/replay/runs/run_nope")).status, 404);
  } finally {
    await h.close();
  }
});
