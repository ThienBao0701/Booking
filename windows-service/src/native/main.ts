/**
 * Native host entry point, started by Chrome through the installed launcher:
 *
 *   <launcher> --config <native-host.json> chrome-extension://<id>/ [--parent-window=N]
 *
 * stdout is the protocol channel: nothing else may write to it. Logs go to
 * `<logDir>/native-host.log` (rolled); unexpected failures to stderr, which
 * Chrome keeps in its own log.
 */

import { join } from "node:path";

import { Logger } from "../logger.ts";
import { isMainModule } from "../main-module.ts";
import { loadNativeHostConfig } from "./config.ts";
import { type HostLogger, NativeHost } from "./host.ts";

export function parseHostArgs(argv: readonly string[]): { configPath: string | undefined; callerOrigin: string | undefined } {
  let configPath: string | undefined;
  let callerOrigin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--config") configPath = argv[++i];
    else if (a.startsWith("--config=")) configPath = a.slice(9);
    else if (a.startsWith("chrome-extension://") && callerOrigin === undefined) callerOrigin = a;
    // --parent-window=<hwnd> (Windows) and anything else is ignored.
  }
  return { configPath: configPath ?? process.env.LAB_NATIVE_HOST_CONFIG, callerOrigin };
}

export async function runNativeHost(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { configPath, callerOrigin } = parseHostArgs(argv);
  const config = configPath ? loadNativeHostConfig(configPath) : { ok: false as const, errors: ["no --config given"] };
  let logger: HostLogger | undefined;
  if (config.ok && config.value.logDir) {
    try {
      logger = new Logger({ dir: config.value.logDir, level: "info", fileName: "native-host.log", stdout: false, maxBytes: 2 * 1024 * 1024, maxFiles: 3 });
    } catch {
      logger = undefined;
    }
  }
  const host = new NativeHost({
    input: process.stdin,
    output: process.stdout,
    callerOrigin,
    config: config.ok ? config.value : { errors: config.errors },
    ...(logger ? { logger } : {}),
  });
  return await host.run();
}

if (isMainModule(import.meta.url)) {
  process.on("uncaughtException", (err) => {
    process.stderr.write(`lab native host: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
  void runNativeHost().then((code) => process.exit(code));
}

export const NATIVE_HOST_LOG = (logDir: string) => join(logDir, "native-host.log");
