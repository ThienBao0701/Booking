import { test } from "node:test";
import assert from "node:assert/strict";

import { ReplayEngine, ReplayValidationError, type ReplayEvent, type ReplayOptions } from "../src/automation/engine.ts";
import {
  type ActionOptions,
  type BrowserController,
  type ControllerSnapshot,
  type PageMetadata,
  type PageState,
  ControllerError,
} from "../src/automation/controller.ts";
import { Store } from "../src/db/store.ts";
import { ReplayNotAuthorizedError, type RunRecord, type WorkflowFile } from "../src/shared.ts";

type Behavior = { failTimes?: number; error?: () => Error; hang?: boolean; delayMs?: number };

/** Scriptable controller: records every call; per-target fault injection. */
class FakeController implements BrowserController {
  readonly name = "fake";
  calls: string[] = [];
  behaviors = new Map<string, Behavior>();
  page = "about:blank";
  typed: Record<string, string> = {};
  restored: ControllerSnapshot[] = [];

  async #act(label: string, key: string, opts?: ActionOptions): Promise<void> {
    this.calls.push(label);
    const b = this.behaviors.get(key);
    if (!b) return;
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    if (b.hang) {
      await new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new ControllerError("ABORTED", "aborted"))));
    }
    if ((b.failTimes ?? 0) > 0) {
      b.failTimes = (b.failTimes as number) - 1;
      throw b.error?.() ?? new ControllerError("ELEMENT_NOT_FOUND", `flaky ${key}`);
    }
  }
  async launch(o: { baseUrl: string }) {
    this.calls.push(`launch ${o.baseUrl}`);
  }
  async openTab() {
    return "t1";
  }
  async closeTab() {}
  async navigate(url: string, o?: ActionOptions) {
    await this.#act(`navigate ${url}`, url, o);
    this.page = url;
  }
  async reload(o?: ActionOptions) {
    await this.#act("reload", "reload", o);
  }
  async back(o?: ActionOptions) {
    await this.#act("back", "back", o);
  }
  async forward(o?: ActionOptions) {
    await this.#act("forward", "forward", o);
  }
  async click(s: string, o?: ActionOptions) {
    await this.#act(`click ${s}`, s, o);
  }
  async type(s: string, v: string, o?: ActionOptions) {
    await this.#act(`type ${s}`, s, o);
    this.typed[s] = v;
  }
  async select(s: string, v: string, o?: ActionOptions) {
    await this.#act(`select ${s}=${v}`, s, o);
  }
  async waitFor(s: string, o?: ActionOptions) {
    await this.#act(`waitFor ${s}`, s, o);
  }
  async captureState(): Promise<PageState> {
    this.calls.push("captureState");
    return { url: this.page, tabId: "t1", fields: {}, entities: {}, server: {}, capturedAt: 0 };
  }
  async captureScreenshot() {
    this.calls.push("captureScreenshot");
    return { supported: false, reason: "fake" };
  }
  getCurrentUrl() {
    return this.page;
  }
  async getPageMetadata(): Promise<PageMetadata> {
    return { url: this.page, title: "", tabId: "t1" };
  }
  async snapshot(): Promise<ControllerSnapshot> {
    return { page: this.page, typed: { ...this.typed } };
  }
  async restore(s: ControllerSnapshot) {
    this.restored.push(s);
    this.page = s.page as string;
    this.typed = { ...(s.typed as Record<string, string>) };
  }
  async close() {
    this.calls.push("close");
  }
}

const MOCK = { kind: "mock" as const, baseUrl: "http://127.0.0.1:4599" };

function wf(steps: WorkflowFile["steps"], extra: Partial<WorkflowFile> = {}): WorkflowFile {
  return { workflow: "unit-flow", version: 1, target: MOCK, defaults: { timeoutMs: 500, retries: 0 }, steps, ...extra };
}

const basic = wf([
  { id: "s1", action: "navigate", target: "/" },
  { id: "s2", action: "type", target: "#login-username", value: "{{user}}" },
  { id: "s3", action: "click", target: "#login-submit", checkpoint: true },
  { id: "s4", action: "waitFor", target: "#actor" },
]);

function engine(file: unknown, extra: Partial<ReplayOptions> = {}) {
  const controller = new FakeController();
  const events: ReplayEvent[] = [];
  const persisted: RunRecord[] = [];
  const e = new ReplayEngine(file, {
    mode: "SIMULATE",
    controller,
    params: { user: "tester" },
    retryDelayMs: 1,
    onEvent: (ev) => events.push(ev),
    persist: (r) => void persisted.push(r),
    ...extra,
  });
  return { e, controller, events, persisted };
}

// ---- validation ----

test("structurally or semantically invalid workflows are rejected up front", () => {
  assert.throws(() => engine({ workflow: "x", version: 1, target: MOCK, steps: [] }), ReplayValidationError);
  assert.throws(() => engine(wf([{ id: "a", action: "click" }])), /click requires a target/);
  assert.throws(() => engine(wf([{ id: "a", action: "type", target: "#x" }])), /type requires a value/);
  assert.throws(() => engine(wf([{ id: "a", action: "click", target: "#x", retries: 99 }])), /retries must be 0..10/);
});

// ---- authorization before execution ----

for (const [name, mode, target, extra, code] of [
  ["OBSERVE mode", "OBSERVE", MOCK, {}, "MODE_FORBIDS_SIDE_EFFECTS"],
  ["authorized target in SIMULATE", "SIMULATE", { kind: "authorized", baseUrl: "https://staging.example", authorization: { owner: "me", system: "s", grantedBy: "self", acknowledgedAt: 1 } }, {}, "MODE_FORBIDS_AUTHORIZED_TARGET"],
  ["authorized target without a valid record", "AUTHORIZED_AUTOMATION", { kind: "authorized", baseUrl: "https://staging.example", authorization: { owner: "", system: "", grantedBy: "", acknowledgedAt: 1 } }, {}, "MISSING_AUTHORIZATION"],
  ["real site labelled mock", "SIMULATE", { kind: "mock", baseUrl: "https://real-extranet.example" }, {}, "MOCK_TARGET_NOT_LOCAL"],
  ["mock mode vs authorized target", "AUTHORIZED_AUTOMATION", { kind: "authorized", baseUrl: "https://staging.example", authorization: { owner: "me", system: "s", grantedBy: "self", acknowledgedAt: 1 } }, { mockOnly: true }, "MODE_FORBIDS_AUTHORIZED_TARGET"],
] as const) {
  test(`denied before any controller call: ${name}`, async () => {
    const { e, controller, events, persisted } = engine(wf(basic.steps, { target: target as WorkflowFile["target"] }), {
      mode,
      ...extra,
    });
    await assert.rejects(e.start(), (err: unknown) => err instanceof ReplayNotAuthorizedError && err.decision.code === code);
    assert.deepEqual(controller.calls, [], "controller must never be touched");
    assert.equal(e.state, "failed");
    assert.equal(events[0]?.type, "run.denied");
    assert.equal(persisted.at(-1)?.status, "failed");
  });
}

test("missing parameters fail before launch", async () => {
  const { e, controller } = engine(basic, { params: {} });
  await assert.rejects(e.start(), /missing parameter: user/);
  assert.deepEqual(controller.calls, []);
});

// ---- happy path ----

test("start runs every step in order, then completes and closes the controller", async () => {
  const { e, controller, events } = engine(basic);
  const run = await e.start();
  assert.equal(run.status, "completed");
  assert.equal(e.state, "completed");
  assert.deepEqual(controller.calls, [
    "launch http://127.0.0.1:4599",
    "navigate /",
    "type #login-username",
    "click #login-submit",
    "waitFor #actor",
    "close",
  ]);
  assert.equal(controller.typed["#login-username"], "tester", "{{user}} substituted");
  assert.deepEqual(run.steps.map((s) => [s.id, s.status, s.attempts]), [
    ["s1", "ok", 1],
    ["s2", "ok", 1],
    ["s3", "ok", 1],
    ["s4", "ok", 1],
  ]);
  assert.deepEqual(run.checkpoints, ["start", "s3"]);
  assert.equal(events[0]?.type, "checkpoint");
  assert.ok(events.some((x) => x.type === "run.started"));
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("parameter VALUES never reach the persisted run record", async () => {
  const { e, persisted } = engine(basic, { params: { user: "SuperSecretTestUser" } });
  await e.start();
  assert.ok(!JSON.stringify(persisted).includes("SuperSecretTestUser"));
});

// ---- dry run ----

test("dryRun plans without side effects and reports authorization + params", async () => {
  const { e, controller } = engine(basic, { mode: "OBSERVE", params: {} });
  const plan = await e.dryRun();
  assert.deepEqual(controller.calls, []);
  assert.equal(plan.authorization.allowed, false);
  assert.equal(plan.wouldExecute, false);
  assert.deepEqual(plan.requiredParams, ["user"]);
  assert.deepEqual(plan.missingParams, ["user"]);
  assert.deepEqual(plan.steps.map((s) => [s.id, s.timeoutMs, s.retries, s.checkpoint]), [
    ["s1", 500, 0, false],
    ["s2", 500, 0, false],
    ["s3", 500, 0, true],
    ["s4", 500, 0, false],
  ]);
  const ok = await engine(basic).e.dryRun();
  assert.equal(ok.wouldExecute, true);
});

// ---- step / pause / resume / stop ----

test("step() executes exactly one step, then pauses; resume() finishes", async () => {
  const { e, controller } = engine(basic);
  assert.equal((await e.step())?.id, "s1");
  assert.equal(e.state, "paused");
  assert.equal(e.cursor, 1);
  assert.equal((await e.step())?.status, "ok");
  assert.equal(e.cursor, 2);
  assert.equal((await e.resume()).status, "completed");
  assert.equal(controller.calls.filter((c) => c.startsWith("launch")).length, 1, "launched once");
});

test("pause() halts before the next step; resume() continues where it stopped", async () => {
  const { e, controller } = engine(basic);
  controller.behaviors.set("#login-username", { delayMs: 30 });
  const running = e.start();
  await new Promise((r) => setTimeout(r, 10)); // s2 in flight
  e.pause();
  const paused = await running;
  assert.equal(paused.status, "paused");
  assert.equal(e.cursor, 2, "the in-flight step completed; nothing after it ran");
  assert.ok(!controller.calls.includes("click #login-submit"));
  assert.equal((await e.resume()).status, "completed");
});

test("stop() aborts the in-flight step immediately and skips the rest", async () => {
  const { e, controller } = engine(basic);
  controller.behaviors.set("#login-submit", { hang: true });
  const running = e.start();
  await new Promise((r) => setTimeout(r, 20));
  const stopped = await e.stop();
  await running;
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.steps.map((s) => s.status), ["ok", "ok", "failed", "skipped"]);
  assert.equal(stopped.steps[2]?.error, "stopped by operator");
  assert.equal(controller.calls.at(-1), "close");
});

test("stop() before start ends the run without touching the controller", async () => {
  const { e, controller } = engine(basic);
  assert.equal((await e.stop()).status, "stopped");
  assert.deepEqual(controller.calls, []);
});

// ---- retry / timeout ----

test("transient failures are retried up to `retries` with retry events", async () => {
  const file = wf(basic.steps.map((s) => (s.id === "s3" ? { ...s, retries: 2 } : s)));
  const { e, controller, events } = engine(file);
  controller.behaviors.set("#login-submit", { failTimes: 2 });
  const run = await e.start();
  assert.equal(run.status, "completed");
  assert.equal(run.steps[2]?.attempts, 3);
  assert.equal(events.filter((x) => x.type === "step.retrying").length, 2);
});

test("deterministic failures are not retried (4xx target error, blocked navigation)", async () => {
  const file = wf(basic.steps.map((s) => ({ ...s, retries: 3 })));
  const { e, controller } = engine(file);
  controller.behaviors.set("#login-submit", { failTimes: 1, error: () => new ControllerError("TARGET_ERROR", "rejected: 400", false) });
  const run = await e.start();
  assert.equal(run.status, "failed");
  assert.equal(run.steps[2]?.attempts, 1, "no retry on a business-rule rejection");
  assert.match(run.steps[2]?.error ?? "", /rejected: 400/);
});

test("a hanging step times out; retry() re-runs it after the cause is fixed", async () => {
  const file = wf(basic.steps.map((s) => (s.id === "s4" ? { ...s, timeoutMs: 40 } : s)));
  const { e, controller } = engine(file);
  controller.behaviors.set("#actor", { hang: true });
  const failed = await e.start();
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[3]?.error, "timed out after 40ms");
  assert.equal(e.cursor, 3);
  controller.behaviors.delete("#actor");
  const done = await e.retry();
  assert.equal(done.status, "completed");
  assert.equal(done.steps[3]?.attempts, 2);
});

// ---- checkpoint / rollback ----

test("rollback restores the controller snapshot and position of the last checkpoint", async () => {
  const file = wf([...basic.steps, { id: "s5", action: "click", target: "#explode" }]);
  const { e, controller } = engine(file);
  controller.behaviors.set("#explode", { failTimes: 1, error: () => new ControllerError("NAVIGATION_BLOCKED", "nope") });
  const failed = await e.start();
  assert.equal(failed.status, "failed");
  const cp = await e.rollback();
  assert.equal(cp.id, "s3");
  assert.equal(e.cursor, 3, "resume after the checkpointed step");
  assert.deepEqual(controller.restored.at(-1), { page: "/", typed: { "#login-username": "tester" } });
  assert.equal(e.record.status, "rolledBack");
  assert.deepEqual(e.record.steps.slice(3).map((s) => s.status), ["pending", "pending"]);
  const done = await e.resume();
  assert.equal(done.status, "completed");
  assert.deepEqual(done.checkpoints, ["start", "s3"], "resumes AFTER the checkpointed step; s3 is not re-run");
});

test("manual checkpoint while paused; rollback defaults to the latest, or to a named one", async () => {
  const { e, controller } = engine(basic);
  await e.step();
  await e.step();
  const cp = await e.checkpoint("before-login");
  assert.equal(cp.cursor, 2);
  await e.step(); // s3 has checkpoint:true → automatic checkpoint at cursor 3
  assert.equal((await e.rollback()).id, "s3", "default: most recent checkpoint");
  assert.equal(e.cursor, 3);
  assert.equal((await e.rollback("before-login")).cursor, 2);
  assert.equal(e.cursor, 2);
  assert.equal(controller.restored.length, 2);
  assert.equal((await e.rollback()).id, "before-login", "later checkpoints were discarded");
  await assert.rejects(e.rollback("nope"), /no checkpoint named "nope"/);
  assert.equal((await e.resume()).status, "completed");
  await assert.rejects(new ReplayEngine(basic, { mode: "SIMULATE", controller: new FakeController() }).rollback(), /no checkpoint/);
});

// ---- artifacts / skipped ----

test("captureState stores an artifact; unsupported screenshots are skipped, not failures", async () => {
  const file = wf([
    { id: "a", action: "navigate", target: "/" },
    { id: "b", action: "captureState" },
    { id: "c", action: "captureScreenshot" },
  ]);
  const { e } = engine(file);
  const run = await e.start();
  assert.equal(run.status, "completed");
  assert.deepEqual(run.steps.map((s) => s.status), ["ok", "ok", "skipped"]);
  assert.equal(e.artifacts[0]?.stepId, "b");
});

// ---- state guards + persistence ----

test("illegal transitions are refused", async () => {
  const { e } = engine(basic);
  await assert.rejects(e.resume(), /cannot resume from state idle/);
  await assert.rejects(e.retry(), /cannot retry from state idle/);
  await e.start();
  await assert.rejects(e.start(), /cannot start from state completed/);
  await assert.rejects(e.rollback(), /cannot roll back a completed run/);
});

test("runs persist to the service store (saveRun/getRun)", async () => {
  const store = new Store(":memory:");
  const { e } = engine(basic, { persist: (r) => store.saveRun(r) });
  const run = await e.start();
  const back = store.getRun(run.runId);
  assert.equal(back?.status, "completed");
  assert.deepEqual(back?.checkpoints, ["start", "s3"]);
  assert.deepEqual(back?.steps.map((s) => s.status), ["ok", "ok", "ok", "ok"]);
  store.close();
});
