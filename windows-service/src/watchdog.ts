/**
 * Process watchdog / supervisor (Component 2/15). Spawns the service and
 * restarts it on crash with exponential backoff. Enforces a single instance via
 * a lock file so two supervisors do not fight over the same database.
 *
 * Phase 15 (ADR-0010) hardening:
 *  - health monitoring: polls `/healthz`; a service that stops answering
 *    (hung) is killed and restarted;
 *  - no orphans: the service is spawned with an IPC channel and exits when
 *    the supervisor goes away (the portable stand-in for a Windows job object);
 *  - graceful stop: a `shutdown` message first, a hard kill after a timeout;
 *  - exit codes: port in use (3) and configuration errors (78) are reported
 *    and retried with a long backoff;
 *  - state: `<dataDir>/supervisor.json` (pids, restarts, last exit, health)
 *    for `lab status`; events go to the rolled `supervisor.log`.
 *
 * Crash recovery of the *data* is provided by SQLite WAL; this supervisor
 * provides crash recovery of the *process*.
 *
 * Run: node --experimental-strip-types --experimental-sqlite src/watchdog.ts [--data-dir <dir>]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { isMainModule } from "./main-module.ts";
import { Logger } from "./logger.ts";
import { configFileToEnv, loadServiceConfigFile, mergeConfigEnv } from "./config-file.ts";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** If the child survives this long, the backoff resets. */
const HEALTHY_UPTIME_MS = 10_000;
/** Exit codes of the service (index.ts). */
const EXIT_PORT_IN_USE = 3;
const EXIT_CONFIG = 78;

export interface HealthMonitorOptions {
  /** e.g. http://127.0.0.1:4577/healthz */
  url: string;
  intervalMs?: number;
  /** Consecutive failures before the service is considered hung (default 3). */
  failures?: number;
  /** No checks during start-up (default 15000 ms). */
  startupGraceMs?: number;
  timeoutMs?: number;
}

export interface WatchdogOptions {
  dataDir: string;
  entry: string;
  /** For tests: stop after N restarts. */
  maxRestarts?: number;
  /** Override the initial backoff (default 1000ms). */
  minBackoffMs?: number;
  /** Override the maximum backoff (default 30000ms). */
  maxBackoffMs?: number;
  /** Uptime after which the backoff resets (default 10000ms). */
  healthyUptimeMs?: number;
  /** Phase 15: poll the service's health endpoint. */
  health?: HealthMonitorOptions;
  /** Grace period for a clean shutdown before a hard kill (default 5000 ms). */
  stopTimeoutMs?: number;
  /** Extra environment for the service (LAB_DATA_DIR is always set). */
  env?: NodeJS.ProcessEnv;
  /** Handle SIGINT/SIGTERM for this process (default true). */
  handleSignals?: boolean;
  onEvent?: (e: { type: string; detail?: unknown }) => void;
}

export interface SupervisorState {
  pid: number;
  childPid: number | null;
  state: "starting" | "running" | "backoff" | "stopping" | "stopped";
  restarts: number;
  startedAt: number;
  lastExit: { code: number | null; signal: string | null; at: number; reason: string } | null;
  lastHealthyAt: number | null;
  healthFailures: number;
}

export function acquireLock(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, "watchdog.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    // If the recorded pid is not alive, the lock is stale; take it over.
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another watchdog is running (pid ${pid})`);
    rmSync(lock, { force: true });
  }
  writeFileSync(lock, String(process.pid));
  return lock;
}

export function readSupervisorState(dataDir: string): SupervisorState | undefined {
  try {
    return JSON.parse(readFileSync(join(dataDir, "supervisor.json"), "utf8")) as SupervisorState;
  } catch {
    return undefined;
  }
}

function probe(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const req = request(url, { method: "GET", timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolveProbe(res.statusCode === 200));
      res.on("error", () => resolveProbe(false));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolveProbe(false));
    req.end();
  });
}

export function startWatchdog(opts: WatchdogOptions): { stop: () => void; stopped: Promise<void> } {
  const emit = opts.onEvent ?? (() => {});
  const minBackoff = opts.minBackoffMs ?? MIN_BACKOFF_MS;
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
  const healthyUptime = opts.healthyUptimeMs ?? HEALTHY_UPTIME_MS;
  const lock = acquireLock(opts.dataDir);
  const stateFile = join(opts.dataDir, "supervisor.json");

  let child: ChildProcess | undefined;
  let backoff = minBackoff;
  let restarts = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;
  let resolveStopped: () => void = () => undefined;
  const stoppedPromise = new Promise<void>((r) => {
    resolveStopped = r;
  });
  const state: SupervisorState = { pid: process.pid, childPid: null, state: "starting", restarts: 0, startedAt: Date.now(), lastExit: null, lastHealthyAt: null, healthFailures: 0 };
  const save = () => {
    try {
      writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
    } catch {
      /* best effort */
    }
  };

  const cleanup = () => {
    try {
      rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  };

  const stopHealth = () => {
    if (healthTimer) clearTimeout(healthTimer);
    healthTimer = undefined;
  };

  const monitor = (c: ChildProcess) => {
    const h = opts.health;
    if (!h) return;
    const interval = h.intervalMs ?? 15_000;
    const threshold = h.failures ?? 3;
    const tick = async () => {
      if (stopped || child !== c || c.exitCode !== null) return;
      const ok = await probe(h.url, h.timeoutMs ?? 3000);
      if (stopped || child !== c || c.exitCode !== null) return;
      if (ok) {
        state.lastHealthyAt = Date.now();
        state.healthFailures = 0;
        if (state.state !== "running") emit({ type: "healthy" });
        state.state = "running";
      } else {
        state.healthFailures += 1;
        emit({ type: "health_failed", detail: { failures: state.healthFailures } });
        if (state.healthFailures >= threshold) {
          emit({ type: "unhealthy", detail: { failures: state.healthFailures } });
          state.lastExit = { code: null, signal: "SIGKILL", at: Date.now(), reason: "unhealthy" };
          save();
          c.kill("SIGKILL");
          return;
        }
      }
      save();
      healthTimer = setTimeout(() => void tick(), interval);
    };
    healthTimer = setTimeout(() => void tick(), h.startupGraceMs ?? 15_000);
  };

  const launch = () => {
    if (stopped) return;
    const startedAt = Date.now();
    emit({ type: "spawn", detail: { restarts } });
    const c = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", opts.entry], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env, ...(opts.env ?? {}), LAB_DATA_DIR: opts.dataDir },
      windowsHide: true,
    });
    child = c;
    state.childPid = c.pid ?? null;
    state.state = "starting";
    state.healthFailures = 0;
    save();
    c.on("message", (m: unknown) => {
      if ((m as { type?: unknown } | null)?.type === "ready") {
        emit({ type: "ready", detail: m });
        state.state = "running";
        state.lastHealthyAt = Date.now();
        save();
      }
    });
    c.on("error", (err) => emit({ type: "spawn_error", detail: String(err) }));
    monitor(c);

    c.on("exit", (code, signal) => {
      stopHealth();
      state.childPid = null;
      if (stopped) return;
      const uptime = Date.now() - startedAt;
      const reason = state.lastExit?.reason === "unhealthy" && state.lastExit.at >= startedAt ? "unhealthy" : code === EXIT_PORT_IN_USE ? "port_in_use" : code === EXIT_CONFIG ? "config_error" : code === 0 ? "exited" : "crashed";
      state.lastExit = { code, signal, at: Date.now(), reason };
      emit({ type: "exit", detail: { code, signal, uptime, reason } });
      if (reason === "port_in_use" || reason === "config_error") emit({ type: reason });
      if (uptime >= healthyUptime) backoff = minBackoff;
      // Port taken / bad config will not fix themselves quickly: wait longer.
      if (reason === "port_in_use" || reason === "config_error") backoff = Math.max(backoff, Math.min(maxBackoff, 5 * minBackoff));

      restarts += 1;
      state.restarts = restarts;
      if (opts.maxRestarts !== undefined && restarts > opts.maxRestarts) {
        emit({ type: "give_up", detail: { restarts } });
        stop();
        return;
      }
      state.state = "backoff";
      save();
      emit({ type: "restart_scheduled", detail: { backoff } });
      // Intentionally NOT unref'd: the supervisor must stay alive across the
      // backoff window so it can relaunch the service.
      timer = setTimeout(launch, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    });
  };

  const finish = () => {
    cleanup();
    state.state = "stopped";
    state.childPid = null;
    save();
    emit({ type: "stopped" });
    resolveStopped();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    state.state = "stopping";
    save();
    if (timer) clearTimeout(timer);
    stopHealth();
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) {
      finish();
      return;
    }
    // Graceful first (the service closes its database), then a hard kill.
    const hard = setTimeout(() => c.kill("SIGKILL"), opts.stopTimeoutMs ?? 5000);
    c.once("exit", () => {
      clearTimeout(hard);
      finish();
    });
    try {
      if (c.connected) c.send({ type: "shutdown" });
      else c.kill("SIGTERM");
    } catch {
      c.kill("SIGTERM");
    }
  };

  if (opts.handleSignals !== false) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        stop();
        void stoppedPromise.then(() => process.exit(0));
      });
    }
  }

  launch();
  return { stop, stopped: stoppedPromise };
}

export function parseWatchdogArgs(argv: readonly string[]): { dataDir: string | undefined } {
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir") dataDir = argv[++i];
    else if (argv[i]?.startsWith("--data-dir=")) dataDir = argv[i]?.slice(11);
  }
  return { dataDir };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(parseWatchdogArgs(process.argv.slice(2)).dataDir ?? process.env.LAB_DATA_DIR ?? "./.lab-runtime");
  mkdirSync(dataDir, { recursive: true });
  const file = loadServiceConfigFile(dataDir);
  const env = mergeConfigEnv(configFileToEnv(file.values), process.env as Record<string, string>);
  const host = env.LAB_SERVICE_HOST ?? "127.0.0.1";
  const port = env.LAB_SERVICE_PORT ?? "4577";
  const logger = new Logger({ dir: join(dataDir, "logs"), level: "info", fileName: "supervisor.log", stdout: false, ...(file.values.logMaxBytes ? { maxBytes: file.values.logMaxBytes } : {}), ...(file.values.logMaxFiles ? { maxFiles: file.values.logMaxFiles } : {}) });
  try {
    startWatchdog({
      dataDir,
      entry: join(here, "index.ts"),
      health: { url: `http://${host.includes(":") ? `[${host}]` : host}:${port}/healthz`, intervalMs: file.values.healthIntervalMs ?? 15_000, failures: file.values.healthFailures ?? 3 },
      onEvent: (e) => logger.log(e.type === "exit" || e.type.includes("fail") || e.type === "unhealthy" || e.type === "port_in_use" || e.type === "config_error" ? "warn" : "info", `supervisor_${e.type}`, e.detail === undefined ? {} : { detail: e.detail }),
    });
    logger.info("supervisor_started", { dataDir, pid: process.pid });
  } catch (err) {
    logger.error("supervisor_failed", { error: String(err) });
    process.stderr.write(`watchdog: ${String(err)}\n`);
    process.exit(1);
  }
}
