/**
 * Native host configuration (written by the installer next to the launcher).
 * Loaded fail-closed: a missing or invalid file means the host refuses every
 * connection with `host_misconfigured`.
 *
 *   {
 *     "serviceUrl": "http://127.0.0.1:4577",          // loopback only
 *     "allowedOrigins": ["chrome-extension://<id>/"],  // exact extension origins
 *     "timeoutMs": 10000,                              // per relayed request
 *     "logDir": "C:\\...\\logs"                        // host log (never stdout)
 *   }
 */

import { readFileSync } from "node:fs";

import { EXTENSION_ORIGIN_RE, isLoopbackUrl } from "../shared.ts";

export interface NativeHostConfig {
  serviceUrl: string;
  /** Normalised "chrome-extension://<id>/" origins. */
  allowedOrigins: string[];
  timeoutMs: number;
  logDir?: string | undefined;
}

export function normalizeExtensionOrigin(v: string): string | undefined {
  const m = EXTENSION_ORIGIN_RE.exec(v.trim());
  return m ? `chrome-extension://${m[1]}/` : undefined;
}

export function validateNativeHostConfig(input: unknown): { ok: true; value: NativeHostConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["config must be an object"] };
  const c = input as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!["serviceUrl", "allowedOrigins", "timeoutMs", "logDir"].includes(k)) errors.push(`unknown field: ${k}`);
  if (typeof c.serviceUrl !== "string" || !isLoopbackUrl(c.serviceUrl) || !/^http:\/\//.test(c.serviceUrl)) errors.push("serviceUrl must be an http loopback URL");
  const origins: string[] = [];
  if (!Array.isArray(c.allowedOrigins) || c.allowedOrigins.length === 0 || c.allowedOrigins.length > 10) errors.push("allowedOrigins must list 1–10 extension origins");
  else {
    for (const o of c.allowedOrigins) {
      const n = typeof o === "string" ? normalizeExtensionOrigin(o) : undefined;
      if (!n) errors.push(`allowedOrigins: not an extension origin: ${String(o).slice(0, 80)}`);
      else if (!origins.includes(n)) origins.push(n);
    }
  }
  const timeoutMs = c.timeoutMs ?? 10_000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000) errors.push("timeoutMs must be 500..120000");
  if (c.logDir !== undefined && (typeof c.logDir !== "string" || c.logDir.length === 0)) errors.push("logDir must be a path");
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { serviceUrl: (c.serviceUrl as string).replace(/\/+$/, ""), allowedOrigins: origins, timeoutMs: timeoutMs as number, logDir: c.logDir as string | undefined } };
}

export function loadNativeHostConfig(file: string): { ok: true; value: NativeHostConfig } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, errors: [`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return validateNativeHostConfig(raw);
}
