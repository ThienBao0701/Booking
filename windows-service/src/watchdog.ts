/**
 * Process watchdog / supervisor (Component 2/15). Spawns the service and
 * restarts it on crash with exponential backoff. Enforces a single instance via
 * a lock file so two supervisors do not fight over the same database.
 *
 * Crash recovery of the *data* is provided by SQLite WAL; this supervisor
 * provides crash recovery of the *process*. Windows-service installation
 * (auto-start on boot) is layered on top in Phase 15.
 *
 * Run: node --experimental-strip-types --experimental-sqlite src/watchdog.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** If the child survives this long, the backoff resets. */
const HEALTHY_UPTIME_MS = 10_000;

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
  onEvent?: (e: { type: string; detail?: unknown }) => void;
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

export function startWatchdog(opts: WatchdogOptions): { stop: () => void } {
  const emit = opts.onEvent ?? (() => {});
  const minBackoff = opts.minBackoffMs ?? MIN_BACKOFF_MS;
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
  const healthyUptime = opts.healthyUptimeMs ?? HEALTHY_UPTIME_MS;
  const lock = acquireLock(opts.dataDir);

  let child: ChildProcess | undefined;
  let backoff = minBackoff;
  let restarts = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    try {
      rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  };

  const launch = () => {
    if (stopped) return;
    const startedAt = Date.now();
    emit({ type: "spawn", detail: { restarts } });
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--experimental-sqlite", opts.entry],
      { stdio: "inherit", env: process.env },
    );

    child.on("exit", (code, signal) => {
      if (stopped) return;
      const uptime = Date.now() - startedAt;
      emit({ type: "exit", detail: { code, signal, uptime } });
      if (uptime >= healthyUptime) backoff = minBackoff;

      restarts += 1;
      if (opts.maxRestarts !== undefined && restarts > opts.maxRestarts) {
        emit({ type: "give_up", detail: { restarts } });
        stop();
        return;
      }
      emit({ type: "restart_scheduled", detail: { backoff } });
      // Intentionally NOT unref'd: the supervisor must stay alive across the
      // backoff window so it can relaunch the service.
      timer = setTimeout(launch, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    });
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    cleanup();
    emit({ type: "stopped" });
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stop();
      process.exit(0);
    });
  }

  launch();
  return { stop };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  startWatchdog({
    dataDir: process.env.LAB_DATA_DIR ?? "./.lab-runtime",
    entry: join(here, "index.ts"),
  });
}
