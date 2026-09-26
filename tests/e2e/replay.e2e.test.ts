/**
 * E2E: ReplayEngine + MockExtranetController against the REAL mock Extranet on
 * 127.0.0.1:4599, plus the full OBSERVE → RECORD → REPRODUCE loop:
 *   extension capture rules (on the mock's real HTML) → Recorder → Bridge →
 *   service → recording-to-workflow draft → replay on the mock.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ReplayEngine } from "../../windows-service/src/automation/engine.ts";
import { MockExtranetController } from "../../windows-service/src/automation/mock-controller.ts";
import { ReplayNotAuthorizedError, type WorkflowFile } from "../../shared/src/index.ts";
import { Recorder } from "../../extension/src/recorder/recorder.ts";
import { MemoryQueue } from "../../extension/src/recorder/queue.ts";
import { BridgeClient } from "../../extension/src/bridge/client.ts";
import { type ElementLike, describeElement, describeField, findInteractive } from "../../extension/src/content/capture.ts";
import { authedGet, ensureMock, startLabService, type LabServiceHandle, type MockHandle } from "./harness.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLE = `${root}examples/workflows/mock-full-flow.json`;
const EXAMPLE_PARAMS = `${root}examples/workflows/mock-full-flow.params.json`;
const example = (): WorkflowFile => JSON.parse(readFileSync(EXAMPLE, "utf8")) as WorkflowFile;

let mock: MockHandle;
before(async () => {
  mock = await ensureMock();
});
after(async () => {
  await mock.close();
});

async function eventTotal(): Promise<number> {
  return ((await (await fetch(`${mock.url}/api/events?since=1000000000`)).json()) as { total: number }).total;
}
async function labelsFor(actor: string, since: number): Promise<string[]> {
  const body = (await (await fetch(`${mock.url}/api/events?since=${since}`)).json()) as {
    events: Array<{ workflow: string; actor: string | null }>;
  };
  return body.events.filter((e) => e.actor === actor).map((e) => e.workflow);
}

test("example workflow replays every module on the mock and persists the run", async () => {
  const svc = await startLabService();
  const username = `replay-${Date.now()}`;
  const since = await eventTotal();
  try {
    const engine = new ReplayEngine(example(), {
      mode: "SIMULATE",
      controller: new MockExtranetController({ pollMs: 20 }),
      params: { username, propertyName: "Replay Villa" },
      persist: (r) => svc.store.saveRun(r),
    });
    const run = await engine.start();
    assert.equal(run.status, "completed", JSON.stringify(run.steps.find((s) => s.status === "failed")));
    assert.ok(run.steps.every((s) => s.status === "ok"));
    assert.deepEqual(run.checkpoints, ["start", "logged-in", "create-property", "create-reservation"]);
    assert.deepEqual(await labelsFor(username, since), [
      "LOGIN",
      "PROPERTY_SETUP",
      "ROOM_SETUP",
      "RATE_SETUP",
      "RESERVATION",
      "CANCELLATION",
      "MESSAGING",
      "REVIEW",
      "PHOTO",
      "REPORTING",
    ]);
    const finalState = engine.artifacts.at(-1)?.data;
    assert.equal(finalState?.view, "reports");
    const persisted = await authedGet<{ run: { status: string; steps: unknown[] } }>(svc, `/v1/runs/${run.runId}`);
    assert.equal(persisted.run.status, "completed");
    assert.equal(persisted.run.steps.length, example().steps.length);
    assert.ok(!JSON.stringify(persisted).includes(username), "param values are never persisted");
  } finally {
    await svc.close();
  }
});

test("dry run and denied runs cause ZERO side effects on the mock", async () => {
  const before = await eventTotal();
  const dry = await new ReplayEngine(example(), { mode: "OBSERVE", controller: new MockExtranetController(), params: {} }).dryRun();
  assert.equal(dry.authorization.allowed, false);
  assert.equal(dry.wouldExecute, false);
  assert.deepEqual(dry.missingParams, ["propertyName", "username"]);

  const retargeted: WorkflowFile = {
    ...example(),
    target: { kind: "authorized", baseUrl: mock.url, authorization: { owner: "me", system: "mock", grantedBy: "self", acknowledgedAt: Date.now() } },
  };
  await assert.rejects(
    new ReplayEngine(retargeted, { mode: "SIMULATE", controller: new MockExtranetController(), params: { username: "x", propertyName: "y" } }).start(),
    ReplayNotAuthorizedError,
  );
  await assert.rejects(
    new ReplayEngine(example(), { mode: "OBSERVE", controller: new MockExtranetController(), params: { username: "x", propertyName: "y" } }).start(),
    ReplayNotAuthorizedError,
  );
  assert.equal(await eventTotal(), before, "the mock received no workflow actions");
});

test("step / checkpoint / rollback against the real mock", async () => {
  const controller = new MockExtranetController({ pollMs: 20 });
  const engine = new ReplayEngine(example(), { mode: "SIMULATE", controller, params: { username: `rb-${Date.now()}`, propertyName: "RB" } });
  while (engine.record.checkpoints.at(-1) !== "create-property") await engine.step();
  const stateAtCheckpoint = await controller.captureState();
  await engine.step(); // nav-rooms
  await engine.step(); // room-property
  assert.equal((await controller.getPageMetadata()).view, "rooms");
  const cp = await engine.rollback();
  assert.equal(cp.id, "create-property");
  const restored = await controller.captureState();
  assert.equal(restored.view, stateAtCheckpoint.view, "page model back at the checkpoint");
  assert.deepEqual(restored.entities, stateAtCheckpoint.entities);
  const run = await engine.resume();
  assert.equal(run.status, "completed");
});

/**
 * Run the CLI as a real child process. Must be async: when the harness hosts the
 * mock in THIS process, a synchronous spawn would block the event loop serving it.
 */
function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const cli = ["--experimental-strip-types", "--experimental-sqlite", `${root}windows-service/src/automation/cli.ts`];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...cli, ...args], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("CLI: runs the example (exit 0), dry-run and denial exit 2", async () => {
  const run = await runCli([EXAMPLE, "--params-file", EXAMPLE_PARAMS, "--param", `username=cli-${Date.now()}`, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal((JSON.parse(run.stdout) as { status: string }).status, "completed");

  const dry = await runCli([EXAMPLE, "--dry-run", "--mode", "OBSERVE"]);
  assert.equal(dry.status, 2);
  assert.equal((JSON.parse(dry.stdout) as { wouldExecute: boolean }).wouldExecute, false);

  const denied = await runCli([EXAMPLE, "--mode", "OBSERVE", "--params-file", EXAMPLE_PARAMS]);
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /denied: .*MODE_FORBIDS_SIDE_EFFECTS/);
});

// ---- OBSERVE → RECORD → REPRODUCE ----

/** Build an ElementLike from the mock's served HTML (opening tag attributes + text). */
function element(html: string, attr: string, value: string): ElementLike {
  const m = new RegExp(`<(\\w+)([^>]*\\b${attr}="${value}"[^>]*)>([^<]*)`).exec(html);
  assert.ok(m, `mock HTML has no element with ${attr}="${value}"`);
  const attrs = Object.fromEntries([...(m[2] as string).matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  return {
    tagName: (m[1] as string).toUpperCase(),
    id: attrs.id ?? "",
    getAttribute: (n: string) => (attrs[n] as string | undefined) ?? null,
    parentElement: null,
    textContent: m[3] ?? "",
  };
}

test("OBSERVE → RECORD → REPRODUCE: a recorded session replays on the mock", async () => {
  const svc: LabServiceHandle = await startLabService();
  const html = await (await fetch(`${mock.url}/`)).text();
  const bridge = new BridgeClient({ serviceUrl: svc.url, token: svc.token });
  const recorder = new Recorder({ queue: new MemoryQueue(), sink: bridge, flushIntervalMs: 60_000 });
  try {
    // 1. OBSERVE + RECORD — exactly what the content script sends for these interactions.
    const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "mock", host: "127.0.0.1" } });
    bridge.declareSession(s);
    let view = "login";
    const rec = (action: "click" | "change" | "page_state", target?: ElementLike, metadata: Record<string, unknown> = {}) => {
      if (action === "click" && target) {
        recorder.record({ action, page: "/", tabId: 7, view, target: describeElement(findInteractive(target) as ElementLike), metadata });
      } else if (action === "change" && target) {
        const f = describeField(target, true);
        recorder.record({ action, page: "/", tabId: 7, view, target: f.target, metadata: f.metadata });
      } else {
        recorder.record({ action: "page_state", page: "/", tabId: 7, view, metadata: { readyState: "complete", view } });
      }
    };
    const nav = (v: string) => {
      rec("click", element(html, "data-view", v));
      view = v;
      rec("page_state");
    };
    const byId = (id: string) => element(html, "id", id);

    rec("page_state");
    rec("change", byId("login-username"));
    rec("click", byId("login-submit"));
    nav("property");
    rec("change", byId("prop-name"));
    rec("change", byId("prop-address"));
    rec("click", byId("prop-submit"));
    nav("rooms");
    rec("change", byId("room-property"));
    rec("change", byId("room-name"));
    rec("change", byId("room-type"));
    rec("click", byId("room-submit"));
    nav("reservations");
    for (const id of ["res-property", "res-room", "res-guest", "res-in", "res-out"]) rec("change", byId(id));
    rec("click", byId("res-submit"));
    rec("click", { tagName: "BUTTON", id: "", getAttribute: (n) => (n === "data-cancel" ? "01RESERVATIONIDXXXXXXXXXXX" : null), parentElement: null, textContent: "cancel" });
    nav("reports");
    rec("change", byId("report-property"));
    rec("click", byId("report-submit"));
    await recorder.endSession();
    assert.equal(recorder.stats.queueSize, 0);

    const stored = await authedGet<{ events: Array<{ kind: string; workflow: string | null }> }>(svc, `/v1/sessions/${s.sessionId}/events`);
    const timeline = stored.events.filter((e) => e.kind === "WORKFLOW_TRANSITION").map((e) => e.workflow);
    assert.equal(timeline[0], "LOGIN");
    assert.ok(timeline.includes("CANCELLATION"));
    assert.equal(timeline.at(-1), "REPORTING");

    // 2. Recording → replayable draft (service API).
    const draft = await authedGet<{ file: WorkflowFile; params: string[]; notes: string[] }>(
      svc,
      `/v1/sessions/${s.sessionId}/workflow?name=reproduced&baseUrl=${encodeURIComponent(mock.url)}`,
    );
    assert.deepEqual(draft.params.sort(), ["login-username", "prop-address", "prop-name", "res-guest", "res-in", "res-out", "room-name", "room-type"]);
    assert.ok(draft.file.steps.some((st) => st.target === 'button[data-cancel="$last.reservation"]'));

    // 3. REPRODUCE on the mock with fresh test data.
    const actor = `reproduced-${Date.now()}`;
    const since = await eventTotal();
    const run = await new ReplayEngine(draft.file, {
      mode: "SIMULATE",
      mockOnly: true,
      controller: new MockExtranetController({ pollMs: 20 }),
      sourceSessionId: s.sessionId,
      persist: (r) => svc.store.saveRun(r),
      params: {
        "login-username": actor,
        "prop-name": "Reproduced Villa",
        "prop-address": "2 Replay St",
        "room-name": "Suite",
        "room-type": "double",
        "res-guest": "TEST_GUEST",
        "res-in": "2026-11-01",
        "res-out": "2026-11-04",
      },
    }).start();
    assert.equal(run.status, "completed", JSON.stringify(run.steps.find((st) => st.status === "failed")));
    assert.equal(run.sourceSessionId, s.sessionId, "run is traceable to the recording");
    assert.deepEqual(await labelsFor(actor, since), ["LOGIN", "PROPERTY_SETUP", "ROOM_SETUP", "RESERVATION", "CANCELLATION", "REPORTING"]);
  } finally {
    recorder.dispose();
    await svc.close();
  }
});
