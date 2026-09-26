/**
 * Cross-package E2E harness.
 *
 *  - `ensureMock()` targets the existing mock Extranet at MOCK_EXTRANET_URL
 *    (default http://127.0.0.1:4599). If a mock is already running there it is
 *    REUSED and left running (never stopped or restarted by the tests); otherwise
 *    one is started in-process on that address and stopped afterwards. The URL
 *    must be loopback — E2E tests can never be pointed at a real system.
 *  - `startLabService()` runs the real service (server + SQLite store) on a
 *    loopback port, optionally on a fixed port / db file to simulate restarts.
 *
 * Run with --test-concurrency=1 (the mock is a shared, stateful process).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { type SafetyMode, isLoopbackUrl } from "../../shared/src/index.ts";
import { createMockServer } from "../../mock-extranet/src/api.ts";
import { createApiServer } from "../../windows-service/src/server.ts";
import { Store } from "../../windows-service/src/db/store.ts";
import { EventBus } from "../../windows-service/src/eventbus.ts";
import { Logger } from "../../windows-service/src/logger.ts";
import { RateLimiter } from "../../windows-service/src/security.ts";
import type { ServiceConfig } from "../../windows-service/src/config.ts";

export const MOCK_URL = (process.env.MOCK_EXTRANET_URL ?? "http://127.0.0.1:4599").replace(/\/+$/, "");
if (!isLoopbackUrl(MOCK_URL)) {
  throw new Error(`MOCK_EXTRANET_URL must be a loopback URL; refusing to run E2E against ${MOCK_URL}`);
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { status?: string };
    return res.status === 200 && body.status === "ok";
  } catch {
    return false;
  }
}

export interface MockHandle {
  url: string;
  startedHere: boolean;
  close: () => Promise<void>;
}

export async function ensureMock(): Promise<MockHandle> {
  if (await probe(MOCK_URL)) return { url: MOCK_URL, startedHere: false, close: async () => {} };
  const m = /^http:\/\/([^/:]+|\[[^\]]+\]):(\d+)$/.exec(MOCK_URL);
  if (!m) throw new Error(`cannot start a mock for ${MOCK_URL} (expected http://host:port)`);
  const host = (m[1] as string).replace(/^\[|\]$/g, "");
  const port = Number(m[2]);
  const { server } = createMockServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  } catch (err) {
    // Lost a race with another starter: reuse it if it is a healthy mock.
    if (await probe(MOCK_URL)) return { url: MOCK_URL, startedHere: false, close: async () => {} };
    throw new Error(`mock-extranet not reachable at ${MOCK_URL} and port is unavailable: ${String(err)}`);
  }
  return {
    url: MOCK_URL,
    startedHere: true,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export interface LabServiceHandle {
  url: string;
  port: number;
  token: string;
  store: Store;
  dbPath: string;
  close: () => Promise<void>;
}

export const E2E_TOKEN = "e2e-token-abcdefghijklmnopqrstuv";

export async function startLabService(opts: { port?: number; dbPath?: string; safetyMode?: SafetyMode } = {}): Promise<LabServiceHandle> {
  const dir = mkdtempSync(join(tmpdir(), "lab-e2e-"));
  const dbPath = opts.dbPath ?? join(dir, "lab.sqlite");
  const store = new Store(dbPath);
  const config: ServiceConfig = {
    host: "127.0.0.1",
    port: opts.port ?? 0,
    dataDir: dir,
    authToken: E2E_TOKEN,
    safetyMode: opts.safetyMode ?? "OBSERVE",
    allowedOrigins: [],
    rateLimit: { windowMs: 1000, max: 1000 },
    logLevel: "error",
  };
  const server: Server = createApiServer({
    config,
    store,
    bus: new EventBus(),
    logger: new Logger({ dir: join(dir, "logs"), level: "error", stdout: false }),
    limiter: new RateLimiter(1000, 1000),
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  config.port = port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token: E2E_TOKEN,
    store,
    dbPath,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => {
          store.close();
          if (!opts.dbPath) rmSync(dir, { recursive: true, force: true });
          r();
        });
      }),
  };
}

export async function authedGet<T>(svc: LabServiceHandle, path: string): Promise<T> {
  const res = await fetch(svc.url + path, { headers: { authorization: `Bearer ${svc.token}` } });
  return (await res.json()) as T;
}
