/**
 * Extension configuration + validation. The bridge may only ever talk to a
 * loopback service URL, so recorded events never leave the machine
 * (docs/05-security-model.md). Target origins are exact origins the operator
 * grants at runtime — never wildcards (least privilege).
 */

import { type SafetyMode, DEFAULT_SAFETY_MODE, isLoopbackUrl, isSafetyMode } from "../shared.ts";

export interface ExtensionConfig {
  /** Loopback URL of the lab service, e.g. http://127.0.0.1:4577. */
  serviceUrl: string;
  /** Bearer token paired with the service ("" = not paired yet). */
  token: string;
  /** Safety mode recorded on new sessions. The extension itself only records. */
  safetyMode: SafetyMode;
  /** Exact origins (besides loopback) the operator granted for recording. */
  targetOrigins: string[];
  /** Events per delivery batch (<= service max of 500). */
  batchSize: number;
  /** Debounced flush delay after the last recorded event. */
  flushIntervalMs: number;
  /** Persistent queue cap; oldest events beyond this are dropped and counted. */
  maxQueue: number;
  /** DOM-mutation summary debounce. */
  domDebounceMs: number;
}

export const DEFAULT_CONFIG: ExtensionConfig = {
  serviceUrl: "http://127.0.0.1:4577",
  token: "",
  safetyMode: DEFAULT_SAFETY_MODE,
  targetOrigins: [],
  batchSize: 50,
  flushIntervalMs: 2000,
  maxQueue: 5000,
  domDebounceMs: 500,
};

/** Normalize an origin string ("https://Host:8443/" → "https://host:8443"). Undefined if invalid. */
export function normalizeOrigin(input: string): string | undefined {
  if (typeof input !== "string") return undefined;
  const s = input.trim().replace(/\/+$/, "");
  const m = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i.exec(s);
  if (!m) return undefined; // rejects paths, userinfo, wildcards, other schemes
  const port = m[3];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return undefined;
  return `${(m[1] as string).toLowerCase()}://${(m[2] as string).toLowerCase()}${port !== undefined ? `:${port}` : ""}`;
}

/** Host-permission match pattern for an origin (Chrome ignores ports in patterns). */
export function originToMatchPattern(origin: string): string {
  const m = /^(https?):\/\/([^:/]+|\[[^\]]+\])/.exec(origin);
  return m ? `${m[1]}://${m[2]}/*` : origin;
}

function intIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

export function validateConfig(
  input: Partial<ExtensionConfig>,
): { ok: true; value: ExtensionConfig } | { ok: false; errors: string[] } {
  const c: ExtensionConfig = { ...DEFAULT_CONFIG, ...input };
  const errors: string[] = [];
  if (!isLoopbackUrl(c.serviceUrl)) {
    errors.push("serviceUrl must be a loopback URL (127.0.0.1 / localhost / [::1]) — events never leave this machine");
  }
  if (typeof c.token !== "string") errors.push("token must be a string");
  if (!isSafetyMode(c.safetyMode)) errors.push("safetyMode invalid");
  if (!Array.isArray(c.targetOrigins)) {
    errors.push("targetOrigins must be an array");
  } else {
    const normalized: string[] = [];
    for (const o of c.targetOrigins) {
      const n = normalizeOrigin(o);
      if (!n) errors.push(`targetOrigins: "${String(o)}" is not an exact http(s) origin`);
      else if (!normalized.includes(n)) normalized.push(n);
    }
    c.targetOrigins = normalized;
  }
  if (!intIn(c.batchSize, 1, 500)) errors.push("batchSize must be an integer 1..500");
  if (!intIn(c.flushIntervalMs, 250, 60_000)) errors.push("flushIntervalMs must be 250..60000");
  if (!intIn(c.maxQueue, 100, 50_000)) errors.push("maxQueue must be 100..50000");
  if (!intIn(c.domDebounceMs, 100, 10_000)) errors.push("domDebounceMs must be 100..10000");
  return errors.length ? { ok: false, errors } : { ok: true, value: c };
}

/** True if a page URL is one the extension may record on (loopback or a granted origin). */
export function isRecordableUrl(url: string | undefined, targetOrigins: readonly string[]): boolean {
  if (!url) return false;
  if (isLoopbackUrl(url)) return true;
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  if (!m) return false;
  const origin = normalizeOrigin(m[1] as string);
  return origin !== undefined && targetOrigins.includes(origin);
}
