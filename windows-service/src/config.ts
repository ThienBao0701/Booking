/**
 * Service configuration + the loopback invariant (docs/05-security-model.md).
 * The service refuses to start on a non-loopback interface.
 */

import { isSafetyMode, DEFAULT_SAFETY_MODE, type SafetyMode } from "./shared.ts";

export interface ServiceConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Bearer token required by the API. */
  authToken: string;
  safetyMode: SafetyMode;
  /** Allowed request Origins (extension ids). Empty Origin is allowed (native). */
  allowedOrigins: string[];
  /** Rate limit: max requests per window per token. */
  rateLimit: { windowMs: number; max: number };
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

export class ConfigError extends Error {}

function parsePort(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`invalid port: ${v}`);
  }
  return n;
}

export interface ConfigEnv {
  LAB_SERVICE_HOST?: string;
  LAB_SERVICE_PORT?: string;
  LAB_DATA_DIR?: string;
  LAB_AUTH_TOKEN?: string;
  LAB_SAFETY_MODE?: string;
  LAB_ALLOWED_ORIGINS?: string;
  LAB_LOG_LEVEL?: string;
}

/**
 * Build config from an env-like object. `authToken` must be supplied (generated
 * at install / by the bootstrap in index.ts); this function does not invent one.
 */
export function loadConfig(env: ConfigEnv, authToken: string): ServiceConfig {
  const host = env.LAB_SERVICE_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new ConfigError(
      `refusing to bind non-loopback host "${host}"; the service is local-only (docs/05-security-model.md)`,
    );
  }
  if (!authToken || authToken.length < 16) {
    throw new ConfigError("authToken missing or too short (>=16 chars required)");
  }
  const safety = env.LAB_SAFETY_MODE ?? DEFAULT_SAFETY_MODE;
  if (!isSafetyMode(safety)) throw new ConfigError(`invalid LAB_SAFETY_MODE: ${safety}`);

  const level = env.LAB_LOG_LEVEL ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    throw new ConfigError(`invalid LAB_LOG_LEVEL: ${level}`);
  }

  return {
    host,
    port: parsePort(env.LAB_SERVICE_PORT, 4577),
    dataDir: env.LAB_DATA_DIR ?? "./.lab-runtime",
    authToken,
    safetyMode: safety,
    allowedOrigins: (env.LAB_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    rateLimit: { windowMs: 1000, max: 100 },
    logLevel: level as ServiceConfig["logLevel"],
  };
}
