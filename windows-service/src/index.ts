/**
 * Service bootstrap. Ensures the data dir + auth token exist, opens the store,
 * starts the loopback API, and wires periodic maintenance + graceful shutdown.
 *
 * Run: node --experimental-strip-types --experimental-sqlite src/index.ts
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, type ConfigEnv } from "./config.ts";
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

export function startService(env: ConfigEnv = process.env as ConfigEnv): Promise<StartedService> {
  const dataDir = env.LAB_DATA_DIR ?? "./.lab-runtime";
  mkdirSync(dataDir, { recursive: true });

  const token = ensureToken(dataDir, env.LAB_AUTH_TOKEN);
  const config = loadConfig(env, token);

  const logger = new Logger({ dir: join(config.dataDir, "logs"), level: config.logLevel });
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

  const server = createApiServer({ config, store, bus, logger, limiter, analysis, screenshots, replay, library });
  // Bound slow/stalled clients so a hung bridge connection cannot pin the service.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve) => {
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

      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
          void close().then(() => process.exit(0));
        });
      }
      resolve({ close, port, token });
    });
  });
}

// Start when executed directly (not when imported by tests).
const isMain = isMainModule(import.meta.url);
if (isMain) {
  startService().catch((err: unknown) => {
    process.stderr.write(`fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
