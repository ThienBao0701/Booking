/**
 * Supervisor hardening (Phase 15) with real processes: crash recovery of the
 * real service, a hung service detected by health monitoring, no orphaned
 * service when the supervisor dies, graceful stop, port-in-use and
 * configuration-error exits, and the state file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readSupervisorState, startWatchdog } from "../src/watchdog.ts";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const WATCHDOG = fileURLToPath(new URL("../src/watchdog.ts", import.meta.url));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).status === 200;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
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

test("crash recovery: a killed service is restarted on the same port with the same data", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-sup-"));
  const port = await freePort();
  const events: string[] = [];
  const wd = startWatchdog({ dataDir: dir, entry: ENTRY, env: { LAB_SERVICE_PORT: String(port), LAB_LOG_LEVEL: "error" }, minBackoffMs: 100, maxBackoffMs: 400, handleSignals: false, onEvent: (e) => events.push(e.type) });
  try {
    await until(() => healthy(port), "service up");
    await until(() => readSupervisorState(dir)?.state === "running", "state running");
    const first = readSupervisorState(dir)?.childPid;
    assert.ok(alive(first));
    process.kill(first as number, "SIGKILL");
    await until(async () => (readSupervisorState(dir)?.childPid ?? first) !== first && (await healthy(port)), "restarted and healthy");
    const st = readSupervisorState(dir);
    assert.equal(st?.restarts, 1);
    assert.equal(st?.lastExit?.reason, "crashed");
    assert.ok(events.includes("ready"));
  } finally {
    wd.stop();
    await wd.stopped;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health monitoring: a service that stops answering is killed and restarted", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-sup-"));
  const port = await freePort();
  // A "service" that accepts connections but never answers (hung event loop stand-in).
  const entry = join(dir, "hung.mjs");
  writeFileSync(entry, `import net from "node:net"; net.createServer(() => {}).listen(${port}, "127.0.0.1");\n`);
  const events: string[] = [];
  const wd = startWatchdog({ dataDir: dir, entry, minBackoffMs: 100, maxBackoffMs: 200, handleSignals: false, health: { url: `http://127.0.0.1:${port}/healthz`, intervalMs: 200, failures: 2, startupGraceMs: 300, timeoutMs: 300 }, onEvent: (e) => events.push(e.type) });
  try {
    await until(() => events.includes("unhealthy") && events.filter((e) => e === "spawn").length >= 2, "hung service detected and replaced");
    assert.equal(readSupervisorState(dir)?.lastExit?.reason, "unhealthy");
  } finally {
    wd.stop();
    await wd.stopped;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graceful stop: the service is asked to shut down (database closed), then the supervisor stops", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-sup-"));
  const port = await freePort();
  const wd = startWatchdog({ dataDir: dir, entry: ENTRY, env: { LAB_SERVICE_PORT: String(port), LAB_LOG_LEVEL: "info" }, handleSignals: false });
  try {
    await until(() => healthy(port), "service up");
    const pid = readSupervisorState(dir)?.childPid;
    wd.stop();
    await wd.stopped;
    assert.equal(alive(pid), false);
    assert.equal(readSupervisorState(dir)?.state, "stopped");
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(dir, "logs", "service.log"), "utf8");
    assert.match(log, /"msg":"service_shutdown","reason":"supervisor request"/);
    assert.match(log, /"msg":"service_stopped"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no orphans: when the supervisor process is killed, the service exits too", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-sup-"));
  const port = await freePort();
  writeFileSync(join(dir, "config.json"), JSON.stringify({ port, logLevel: "error" }));
  const sup = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", WATCHDOG, "--data-dir", dir], { stdio: "ignore" });
  try {
    await until(() => healthy(port), "service up under the supervisor process");
    const child = readSupervisorState(dir)?.childPid;
    assert.ok(alive(child));
    sup.kill("SIGKILL"); // like Task Scheduler's "End" or a crash of the supervisor
    await until(() => !alive(child), "service exited after losing its supervisor", 10_000);
    await until(async () => !(await healthy(port)), "port released");
  } finally {
    if (sup.exitCode === null) sup.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("port in use: reported, retried with backoff, and the service starts once the port is free", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-sup-"));
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as { port: number }).port;
  const events: Array<{ type: string; detail?: unknown }> = [];
  const wd = startWatchdog({ dataDir: dir, entry: ENTRY, env: { LAB_SERVICE_PORT: String(port), LAB_LOG_LEVEL: "error" }, minBackoffMs: 100, maxBackoffMs: 500, handleSignals: false, onEvent: (e) => events.push(e) });
  try {
    await until(() => events.some((e) => e.type === "port_in_use"), "port_in_use reported");
    const sched = events.find((e) => e.type === "restart_scheduled")?.detail as { backoff: number };
    assert.ok(sched.backoff >= 500, `long backoff for port in use (${sched.backoff} ms)`);
    await new Promise<void>((r) => blocker.close(() => r()));
    await until(() => healthy(port), "service up after the port was freed");
  } finally {
    wd.stop();
    await wd.stopped;
    if (blocker.listening) blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a configuration error (exit 78) is reported as such", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-sup-"));
  const events: Array<{ type: string; detail?: unknown }> = [];
  await new Promise<void>((resolve) => {
    startWatchdog({ dataDir: dir, entry: ENTRY, env: { LAB_SAFETY_MODE: "NOT_A_MODE", LAB_LOG_LEVEL: "error" }, maxRestarts: 0, minBackoffMs: 50, handleSignals: false, onEvent: (e) => {
      events.push(e);
      if (e.type === "stopped") resolve();
    } });
  });
  try {
    assert.ok(events.some((e) => e.type === "config_error"));
    assert.equal(readSupervisorState(dir)?.lastExit?.reason, "config_error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
