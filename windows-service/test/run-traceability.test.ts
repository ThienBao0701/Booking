import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Store } from "../src/db/store.ts";
import { ReplayEngine } from "../src/automation/engine.ts";
import type { BrowserController, PageState } from "../src/automation/controller.ts";
import type { WorkflowFile } from "../src/shared.ts";

const AUTH = { owner: "me", system: "staging-extranet", grantedBy: "team-lead", note: "own staging tenant", acknowledgedAt: 1_790_000_000_000 };

/** Minimal controller that accepts everything (target reachability is not under test here). */
function okController(): BrowserController {
  const noop = async () => {};
  return {
    name: "ok",
    launch: noop,
    openTab: async () => "t1",
    closeTab: noop,
    navigate: noop,
    reload: noop,
    back: noop,
    forward: noop,
    click: noop,
    type: noop,
    select: noop,
    waitFor: noop,
    captureState: async (): Promise<PageState> => ({ url: "", tabId: "t1", fields: {}, entities: {}, server: {}, capturedAt: 0 }),
    captureScreenshot: async () => ({ supported: false }),
    getCurrentUrl: () => "",
    getPageMetadata: async () => ({ url: "", title: "", tabId: "t1" }),
    close: noop,
  };
}

test("the run record carries the target and its authorization record, persisted", async () => {
  const store = new Store(":memory:");
  const file: WorkflowFile = {
    workflow: "authorized-flow",
    version: 1,
    target: { kind: "authorized", baseUrl: "https://staging.example.test", authorization: AUTH },
    steps: [{ id: "s1", action: "navigate", target: "/" }],
  };
  const run = await new ReplayEngine(file, {
    mode: "AUTHORIZED_AUTOMATION",
    controller: okController(),
    persist: (r) => store.saveRun(r),
  }).start();
  assert.equal(run.status, "completed");
  assert.deepEqual(run.target, file.target);
  assert.deepEqual(store.getRun(run.runId)?.target, file.target, "authorization basis is traceable per run");
  store.close();
});

test("databases created before the target column are migrated additively", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-migrate-"));
  const dbPath = join(dir, "lab.sqlite");
  try {
    // A database with the original runs table (no `target` column) and an existing run.
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, mode TEXT NOT NULL, started_at INTEGER NOT NULL,
      ended_at INTEGER, status TEXT NOT NULL, checkpoints TEXT NOT NULL DEFAULT '[]',
      source_session_id TEXT, dry_run INTEGER NOT NULL DEFAULT 0)`);
    old.prepare("INSERT INTO runs(run_id, workflow, mode, started_at, status) VALUES(?,?,?,?,?)").run("old_run", "w", "SIMULATE", 1, "completed");
    old.close();

    const store = new Store(dbPath);
    assert.equal(store.getRun("old_run")?.status, "completed", "existing data intact");
    assert.equal(store.getRun("old_run")?.target, undefined);
    store.saveRun({
      runId: "new_run",
      workflow: "w",
      mode: "SIMULATE",
      startedAt: 2,
      status: "completed",
      steps: [],
      checkpoints: [],
      target: { kind: "mock", baseUrl: "http://127.0.0.1:4599" },
    });
    assert.deepEqual(store.getRun("new_run")?.target, { kind: "mock", baseUrl: "http://127.0.0.1:4599" });
    assert.equal(store.getMeta("schema_version"), "1", "additive change: version unchanged");
    store.close();
    // Re-opening is idempotent (column already present).
    new Store(dbPath).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
