/** Shared harness for service tests: an in-memory service on an ephemeral loopback port. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createApiServer } from "../src/server.ts";
import { Store } from "../src/db/store.ts";
import { EventBus } from "../src/eventbus.ts";
import { Logger } from "../src/logger.ts";
import { RateLimiter } from "../src/security.ts";
import type { ServiceConfig } from "../src/config.ts";

export const TEST_TOKEN = "test-token-abcdefghijklmnop";

export interface ServiceHarness {
  base: string;
  port: number;
  store: Store;
  bus: EventBus;
  config: ServiceConfig;
  close: () => Promise<void>;
}

export async function startServiceHarness(rateMax = 1000): Promise<ServiceHarness> {
  const dir = mkdtempSync(join(tmpdir(), "lab-svc-"));
  const store = new Store(":memory:");
  const bus = new EventBus();
  const logger = new Logger({ dir: join(dir, "logs"), level: "error", stdout: false });
  const config: ServiceConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    authToken: TEST_TOKEN,
    safetyMode: "OBSERVE",
    allowedOrigins: [],
    rateLimit: { windowMs: 1000, max: rateMax },
    logLevel: "error",
  };
  const server = createApiServer({ config, store, bus, logger, limiter: new RateLimiter(1000, rateMax) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  config.port = port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    store,
    bus,
    config,
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          store.close();
          rmSync(dir, { recursive: true, force: true });
          r();
        }),
      ),
  };
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json", ...extra };
}
