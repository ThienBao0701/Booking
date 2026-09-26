/**
 * Service bootstrap. Ensures the data dir + auth token exist, opens the store,
 * starts the loopback API, and wires periodic maintenance + graceful shutdown.
 *
 * Configuration: `<LAB_DATA_DIR>/config.json` (validated, last-known-good
 * recovery; Phase 15) with environment variables taking precedence.
 * Under the supervisor (IPC channel) the service exits cleanly when told to
 * shut down or when the supervisor disappears, so it is never orphaned.
 *
 * Exit codes: 0 stopped, 1 fatal, 3 port in use, 78 configuration error.
 *
 * Run: node --experimental-strip-types --experimental-sqlite src/index.ts
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { ConfigError, loadConfig, type ConfigEnv } from "./config.ts";
import { configFileToEnv, loadServiceConfigFile, mergeConfigEnv } from "./config-file.ts";
import { generateToken } from "./auth.ts";
import { Store } from "./db/store.ts";
import { EventBus } from "./eventbus.ts";
import { Logger } from "./logger.ts";
import { RateLimiter } from "./security.ts";
import { createApiServer, defaultControllerFactory } from "./server.ts";
import { isMainModule } from "./main-module.ts";
import { AnalysisService } from "./analysis/service.ts";
import { ScreenshotService } from "./screenshots/service.ts";
import { ReplayManager } from "./automation/manager.ts";
import { WorkflowLibrary } from "./automation/library.ts";

function ensureToken(dataDir: string, fromEnv: string | undefined): string {
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const tokenPath = join(dataDir, "auth-token.txt");
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const token = generateToken();
  writeFileSync(tokenPath, token, { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    /* best effort on platforms without POSIX perms */
  }
  return token;
}

/**
 * Analyse a session once it ends (findings persisted, replacing earlier ones).
 * Deferred off the request path and coalesced; failures are logged, never thrown.
 */
export function autoAnalyzeOnSessionEnd(bus: EventBus, analysis: AnalysisService, logger: Logger): () => void {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    const ids = [...pending];
    pending.clear();
    try {
      const summary = analysis.run(ids);
      logger.info("analysis_run", { trigger: "session.end", sessions: summary.sessions, findings: summary.findings, rules_version: summary.rules_version });
    } catch (err) {
      logger.error("analysis_failed", { sessions: ids, error: String(err) });
    }
  };
  const unsubscribe = bus.subscribe((msg) => {
    if (msg.type !== "session.end") return;
    pending.add(msg.payload.sessionId);
    // Late events of the final bridge batch may still be in flight; wait briefly.
    timer ??= setTimeout(flush, 1500);
    timer.unref?.();
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

export interface StartedService {
  close: () => Promise<void>;
  port: number;
  token: string;
}

export const EXIT_PORT_IN_USE = 3;
export const EXIT_CONFIG = 78;

/** The port is taken (another lab instance or another program). */
export class PortInUseError extends Error {
  readonly port: number;
  constructor(host: string, port: number) {
    super(`${host}:${port} is already in use`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

export function startService(env: ConfigEnv = process.env as ConfigEnv): Promise<StartedService> {
  const dataDir = env.LAB_DATA_DIR ?? "./.lab-runtime";
  mkdirSync(dataDir, { recursive: true });

  const fileConfig = loadServiceConfigFile(dataDir);
  const merged = mergeConfigEnv(configFileToEnv(fileConfig.values), env);
  const token = ensureToken(dataDir, merged.LAB_AUTH_TOKEN);
  const config = loadConfig({ ...merged, LAB_DATA_DIR: dataDir }, token);

  const logger = new Logger({ dir: join(config.dataDir, "logs"), level: config.logLevel, ...(config.logMaxBytes ? { maxBytes: config.logMaxBytes } : {}), ...(config.logMaxFiles ? { maxFiles: config.logMaxFiles } : {}) });
  if (fileConfig.problems.length) logger.error("config_invalid", { recoveredFrom: fileConfig.source, problems: fileConfig.problems });
  const store = new Store(join(config.dataDir, "lab.sqlite"));
  const bus = new EventBus();
  const limiter = new RateLimiter(config.rateLimit.windowMs, config.rateLimit.max);

  const sweep = setInterval(() => limiter.sweep(), 30_000);
  sweep.unref?.();

  const analysis = new AnalysisService({ store, dataDir: config.dataDir });
  if (analysis.rulesInfo().error) logger.warn("analysis_rules", { error: analysis.rulesInfo().error });
  const stopAutoAnalysis = autoAnalyzeOnSessionEnd(bus, analysis, logger);

  const screenshots = new ScreenshotService({ store, dataDir: config.dataDir });
  if (screenshots.settingsError) logger.warn("screenshot_settings", { error: screenshots.settingsError });
  // Retention: at start and hourly (deletes expired images and orphaned files).
  const retention = () => {
    try {
      const r = screenshots.applyRetention();
      if (r.deleted || r.orphans) logger.info("screenshot_retention", r);
    } catch (err) {
      logger.error("screenshot_retention_failed", { error: String(err) });
    }
  };
  retention();
  const retentionTimer = setInterval(retention, 3_600_000);
  retentionTimer.unref?.();

  const replay = new ReplayManager({
    serviceMode: () => config.safetyMode,
    controllerFactory: defaultControllerFactory,
    persist: (r) => store.saveRun(r),
    onScreenshot: (s) => void screenshots.storeReplay({ runId: s.runId, stepId: s.stepId, workflow: s.workflow, data: s.data }),
  });
  const library = new WorkflowLibrary({ libraryDir: config.workflowsDir ?? join(config.dataDir, "workflows") });

  const configStatus = fileConfig.source === "last-good" || fileConfig.source === "defaults" ? "recovered" : "ok";
  const server = createApiServer({ config, store, bus, logger, limiter, analysis, screenshots, replay, library, configStatus });
  // Bound slow/stalled clients so a hung bridge connection cannot pin the service.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      clearInterval(sweep);
      clearInterval(retentionTimer);
      stopAutoAnalysis();
      store.close();
      const e = err.code === "EADDRINUSE" ? new PortInUseError(config.host, config.port) : err;
      logger.error(err.code === "EADDRINUSE" ? "port_in_use" : "listen_failed", { host: config.host, port: config.port, error: String(err) });
      reject(e);
    });
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : config.port;
      logger.info("service_started", { host: config.host, port, safetyMode: config.safetyMode });

      const close = () =>
        new Promise<void>((done) => {
          clearInterval(sweep);
          clearInterval(retentionTimer);
          stopAutoAnalysis();
          void replay.shutdown();
          server.close(() => {
            store.close();
            logger.info("service_stopped", {});
            done();
          });
        });

      let closing: Promise<void> | undefined;
      const shutdown = (why: string) => {
        if (closing) return;
        logger.info("service_shutdown", { reason: why });
        closing = close().then(() => process.exit(0));
      };
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => shutdown(sig));
      // Supervised (IPC): stop on request, and never outlive the supervisor.
      if (typeof process.send === "function") {
        process.on("message", (m: unknown) => {
          if ((m as { type?: unknown } | null)?.type === "shutdown") shutdown("supervisor request");
        });
        process.on("disconnect", () => shutdown("supervisor gone"));
        process.send({ type: "ready", port });
      }
      resolve({ close, port, token });
    });
  });
}

// Start when executed directly (not when imported by tests).
const isMain = isMainModule(import.meta.url);
if (isMain) {
  // Promise.resolve().then: synchronous start-up errors (e.g. ConfigError) get the same exit codes.
  Promise.resolve()
    .then(() => startService())
    .catch((err: unknown) => {
      process.stderr.write(`fatal: ${String(err)}\n`);
      process.exit(err instanceof PortInUseError ? EXIT_PORT_IN_USE : err instanceof ConfigError ? EXIT_CONFIG : 1);
    });
}
