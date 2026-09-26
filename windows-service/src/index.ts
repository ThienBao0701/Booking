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
import { createApiServer } from "./server.ts";
import { isMainModule } from "./main-module.ts";

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

  const server = createApiServer({ config, store, bus, logger, limiter });
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
