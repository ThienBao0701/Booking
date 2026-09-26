/**
 * E2E (Phase 15): the deployment lifecycle with REAL processes. Task
 * Scheduler is simulated by running exactly the registered action (command,
 * arguments, working directory from the task XML); `/End` terminates the
 * supervisor like Windows does, so the service must exit on its own.
 *
 *   clean install → extension delivers → reboot (power loss, then logon) →
 *   extension reconnects and delivers its queue → restart → broken upgrade is
 *   rolled back → uninstall (no process left, data kept).
 *
 * This proves the flows and the commands Task Scheduler would run; it does not
 * run on Windows itself (see docs/21-windows-deployment.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_ENTRIES, type DeployContext, type DeployEffects, install, layout, readCurrent, realDeployEffects, restartService, status, uninstall, upgrade } from "../../windows-service/src/deploy/installer.ts";
import { TASK_NAME, parseTaskAction, winSplit } from "../../windows-service/src/deploy/task.ts";
import { readSupervisorState } from "../../windows-service/src/watchdog.ts";
import { Recorder } from "../../extension/src/recorder/recorder.ts";
import { MemoryQueue } from "../../extension/src/recorder/queue.ts";
import { BridgeClient } from "../../extension/src/bridge/client.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A copy of this checkout with what a release needs (stub build output when not built). */
function sourceCopy(dir: string, patch?: (src: string) => void): string {
  const src = join(dir, `source-${Math.random().toString(36).slice(2, 8)}`);
  for (const e of APP_ENTRIES) {
    const from = join(REPO, e);
    if (existsSync(from)) cpSync(from, join(src, e), { recursive: true, filter: (p) => !/[\\/](node_modules|test)([\\/]|$)/.test(p.slice(from.length)) });
  }
  for (const [f, c] of [["dashboard/dist/index.html", "<!doctype html>"], ["extension/dist/manifest.json", "{}"]] as const) {
    if (!existsSync(join(src, f))) {
      mkdirSync(join(src, f, ".."), { recursive: true });
      writeFileSync(join(src, f), c);
    }
  }
  patch?.(src);
  return src;
}

/** schtasks, simulated: stores the XML; /Run starts exactly the registered action. */
class TaskScheduler {
  xml: string | undefined;
  proc: ChildProcess | undefined;
  exec: DeployEffects["exec"] = (cmd, args) => {
    if (cmd === "reg") return { status: 0, stdout: "" };
    const op = args[0];
    if (op === "/Create") {
      this.xml = readFileSync(args[args.indexOf("/XML") + 1] as string).subarray(2).toString("utf16le");
      return { status: 0, stdout: "" };
    }
    if (op === "/Query") return this.xml ? { status: 0, stdout: this.xml } : { status: 1, stdout: "" };
    if (op === "/Delete") {
      const had = !!this.xml;
      this.xml = undefined;
      return { status: had ? 0 : 1, stdout: "" };
    }
    if (op === "/End") {
      if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGKILL"); // TerminateProcess
      return { status: 0, stdout: "" };
    }
    if (op === "/Run") return this.run() ? { status: 0, stdout: "" } : { status: 1, stdout: "" };
    return { status: 1, stdout: "" };
  };

  /** What Task Scheduler does at logon (MultipleInstancesPolicy IgnoreNew). */
  run(): boolean {
    if (!this.xml) return false;
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) return true;
    const a = parseTaskAction(this.xml);
    if (!a) return false;
    this.proc = spawn(a.command, winSplit(a.arguments), { cwd: a.workingDirectory, stdio: "ignore" });
    return true;
  }
}

test("install → deliver → reboot → reconnect → restart → broken upgrade rolled back → uninstall", { timeout: 240_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-deploy-e2e-"));
  const ts = new TaskScheduler();
  const port = await freePort();
  const ctx: DeployContext = { root: join(tmp, "AutomationLab"), platform: "win32", userId: "LAB\\op", fx: { ...realDeployEffects, exec: ts.exec }, healthTimeoutMs: 30_000 };
  const L = layout(ctx.root);
  const url = `http://127.0.0.1:${port}`;
  let recorder: Recorder | undefined;
  try {
    // Clean install.
    const r1 = await install(ctx, { sourceDir: sourceCopy(tmp), nodePath: process.execPath, nodeVersion: process.version, config: { port, logLevel: "info" } });
    assert.equal(r1.ok, true, r1.message);
    const token = readFileSync(join(L.dataDir, "auth-token.txt"), "utf8").trim();
    const st1 = await status(ctx);
    assert.equal(st1.healthy, true);
    assert.equal(st1.task.pointsAtCurrent, true);
    assert.ok(st1.supervisor?.alive);

    // The extension pairs and delivers.
    const bridge = new BridgeClient({ serviceUrl: url, token, timeoutMs: 3000, reconnect: { baseMs: 100, maxMs: 500, auto: false } });
    recorder = new Recorder({ queue: new MemoryQueue(), sink: bridge, batchSize: 25, flushIntervalMs: 60_000 });
    const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "mock", host: "127.0.0.1" } });
    bridge.declareSession(s);
    recorder.record({ action: "page_state", page: "/", tabId: 1, view: "login", metadata: {} });
    assert.equal((await recorder.flush({ manual: true })).status, "ok");

    // Reboot: power loss kills everything; the extension keeps recording offline.
    const before = readSupervisorState(L.dataDir);
    const supervisorExit = ts.proc && ts.proc.exitCode === null && ts.proc.signalCode === null ? new Promise((r) => ts.proc?.once("exit", r)) : Promise.resolve();
    process.kill(before?.pid as number, "SIGKILL");
    if (alive(before?.childPid)) process.kill(before?.childPid as number, "SIGKILL");
    await supervisorExit;
    await until(async () => !(await realDeployEffects.health(`${url}/healthz`, 500)), "service down");
    recorder.record({ action: "click", page: "/", tabId: 1, view: "login", target: { selector: "#login-submit" }, metadata: {} });
    assert.notEqual((await recorder.flush({ manual: true })).status, "ok");
    assert.ok(recorder.stats.queueSize > 0, "queued while the service is down");
    // Logon: Task Scheduler runs the registered action again.
    assert.equal(ts.run(), true);
    await until(() => realDeployEffects.health(`${url}/healthz`, 1000), "service back after logon");
    assert.equal(readFileSync(join(L.dataDir, "auth-token.txt"), "utf8").trim(), token, "same token after reboot: no re-pairing");
    await bridge.connect();
    assert.ok(["ok", "empty"].includes((await recorder.flush({ manual: true })).status));
    assert.equal(recorder.stats.queueSize, 0, "extension reconnected and delivered its queue");
    const events = (await (await fetch(`${url}/v1/sessions/${s.sessionId}/events`, { headers: { authorization: `Bearer ${token}` } })).json()) as { events: Array<{ id: string }> };
    assert.equal(events.events.length, recorder.stats.recorded);

    // Restart (e.g. after `lab config set`): new supervisor, healthy again.
    const pidBefore = readSupervisorState(L.dataDir)?.pid;
    const rr = await restartService(ctx);
    assert.equal(rr.ok, true, rr.message);
    await until(() => readSupervisorState(L.dataDir)?.pid !== pidBefore && readSupervisorState(L.dataDir)?.state === "running", "new supervisor running");
    assert.equal(alive(pidBefore), false);

    // A broken release is rolled back; the data is untouched.
    const good = readCurrent(ctx);
    const broken = sourceCopy(tmp, (src) => writeFileSync(join(src, "windows-service", "src", "index.ts"), "process.exit(1);\n"));
    const up = await upgrade({ ...ctx, healthTimeoutMs: 6000 }, { sourceDir: broken, nodePath: process.execPath, nodeVersion: process.version });
    assert.equal(up.ok, false);
    assert.equal(up.rolledBack, true, up.message);
    assert.equal(up.healthy, true, up.message);
    assert.equal(readCurrent(ctx)?.appDir, good?.appDir);
    assert.equal(parseTaskAction(ts.xml as string)?.workingDirectory, good?.appDir);
    const again = (await (await fetch(`${url}/v1/sessions/${s.sessionId}/events`, { headers: { authorization: `Bearer ${token}` } })).json()) as { events: unknown[] };
    assert.equal(again.events.length, recorder.stats.recorded);

    // Uninstall: nothing keeps running; data stays unless purged.
    const sup = readSupervisorState(L.dataDir);
    const un = await uninstall(ctx);
    assert.equal(un.ok, true);
    await until(() => !alive(sup?.pid) && !alive(sup?.childPid), "no lab process left");
    assert.equal(await realDeployEffects.health(`${url}/healthz`, 500), false);
    assert.equal(ts.xml, undefined, "task removed");
    assert.equal(existsSync(L.appsDir), false);
    assert.ok(existsSync(join(L.dataDir, "lab.sqlite")), "data kept");
    assert.equal(TASK_NAME, "AutomationLab");
  } finally {
    recorder?.dispose();
    const st = readSupervisorState(layout(ctx.root).dataDir);
    for (const pid of [st?.pid, st?.childPid]) if (alive(pid)) process.kill(pid as number, "SIGKILL");
    if (ts.proc && ts.proc.exitCode === null) ts.proc.kill("SIGKILL");
    rmSync(tmp, { recursive: true, force: true });
  }
});
