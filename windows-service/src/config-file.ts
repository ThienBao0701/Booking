/**
 * Configuration management (Phase 15, ADR-0010): `<dataDir>/config.json`.
 *
 * - Validated strictly (unknown keys, non-loopback hosts, out-of-range values
 *   are rejected). Environment variables still win over the file.
 * - A valid file is copied to `config.last-good.json`. A corrupted or invalid
 *   file never widens anything: the service falls back to the last good copy,
 *   else to the built-in defaults (loopback, port 4577, OBSERVE), and reports
 *   the problem (log + `/healthz` `config` field).
 * - Writes are atomic (temp file + rename) and keep the previous file as
 *   `config.json.bak`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SAFETY_MODES, type SafetyMode } from "./shared.ts";
import { type ConfigEnv, isLoopbackHost } from "./config.ts";

export const CONFIG_FILE = "config.json";
export const LAST_GOOD_FILE = "config.last-good.json";

export interface ServiceConfigFile {
  host?: string;
  port?: number;
  safetyMode?: SafetyMode;
  allowedOrigins?: string[];
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Log rotation: roll at this size (bytes) … */
  logMaxBytes?: number;
  /** … keeping this many rolled files. */
  logMaxFiles?: number;
  dashboardDir?: string;
  workflowsDir?: string;
  /** Supervisor health monitoring. */
  healthIntervalMs?: number;
  healthFailures?: number;
}

const KEYS: Record<keyof ServiceConfigFile, "string" | "int" | "mode" | "origins" | "level"> = {
  host: "string",
  port: "int",
  safetyMode: "mode",
  allowedOrigins: "origins",
  logLevel: "level",
  logMaxBytes: "int",
  logMaxFiles: "int",
  dashboardDir: "string",
  workflowsDir: "string",
  healthIntervalMs: "int",
  healthFailures: "int",
};
const RANGES: Partial<Record<keyof ServiceConfigFile, [number, number]>> = {
  port: [1, 65535],
  logMaxBytes: [64 * 1024, 1024 * 1024 * 1024],
  logMaxFiles: [1, 50],
  healthIntervalMs: [1000, 600_000],
  healthFailures: [1, 20],
};

export function validateServiceConfigFile(input: unknown): { ok: true; value: ServiceConfigFile } | { ok: false; errors: string[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: ["config must be a JSON object"] };
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const kind = KEYS[k as keyof ServiceConfigFile];
    if (!kind) {
      errors.push(`unknown setting: ${k}`);
      continue;
    }
    switch (kind) {
      case "string":
        if (typeof v !== "string" || v.length === 0 || v.length > 1000) errors.push(`${k} must be a non-empty string`);
        else if (k === "host" && !isLoopbackHost(v)) errors.push(`host must be loopback (127.0.0.1, localhost, ::1), got ${v}`);
        else out[k] = v;
        break;
      case "int": {
        const [lo, hi] = RANGES[k as keyof ServiceConfigFile] ?? [0, Number.MAX_SAFE_INTEGER];
        if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) errors.push(`${k} must be an integer ${lo}..${hi}`);
        else out[k] = v;
        break;
      }
      case "mode":
        if (!(SAFETY_MODES as readonly unknown[]).includes(v)) errors.push(`safetyMode must be one of ${SAFETY_MODES.join(", ")}`);
        else out[k] = v;
        break;
      case "level":
        if (!["debug", "info", "warn", "error"].includes(v as string)) errors.push("logLevel must be debug, info, warn or error");
        else out[k] = v;
        break;
      case "origins":
        if (!Array.isArray(v) || v.length > 20 || !v.every((o) => typeof o === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(o))) errors.push("allowedOrigins must list chrome-extension://<id> origins (max 20)");
        else out[k] = [...v];
        break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out as ServiceConfigFile };
}

export interface LoadedConfigFile {
  values: ServiceConfigFile;
  /** none = no file; file = config.json; last-good / defaults = recovered from a bad file. */
  source: "none" | "file" | "last-good" | "defaults";
  problems: string[];
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { ok: false, error: err instanceof SyntaxError ? `not valid JSON: ${err.message}` : String(err) };
  }
}

export function loadServiceConfigFile(dataDir: string): LoadedConfigFile {
  const file = join(dataDir, CONFIG_FILE);
  const lastGood = join(dataDir, LAST_GOOD_FILE);
  if (!existsSync(file)) return { values: {}, source: "none", problems: [] };
  const raw = readJson(file);
  const v = raw.ok ? validateServiceConfigFile(raw.value) : { ok: false as const, errors: [raw.error] };
  if (v.ok) {
    try {
      const text = `${JSON.stringify(v.value, null, 2)}\n`;
      if (!existsSync(lastGood) || readFileSync(lastGood, "utf8") !== text) writeFileSync(lastGood, text, { mode: 0o600 });
    } catch {
      /* the copy is a convenience; never fail start-up over it */
    }
    return { values: v.value, source: "file", problems: [] };
  }
  const problems = v.errors.map((e) => `${CONFIG_FILE}: ${e}`);
  if (existsSync(lastGood)) {
    const lg = readJson(lastGood);
    const lv = lg.ok ? validateServiceConfigFile(lg.value) : undefined;
    if (lv?.ok) return { values: lv.value, source: "last-good", problems };
    problems.push(`${LAST_GOOD_FILE} is unusable too`);
  }
  return { values: {}, source: "defaults", problems };
}

/** File settings as environment (the service's existing configuration path). */
export function configFileToEnv(v: ServiceConfigFile): ConfigEnv {
  const env: ConfigEnv = {};
  if (v.host !== undefined) env.LAB_SERVICE_HOST = v.host;
  if (v.port !== undefined) env.LAB_SERVICE_PORT = String(v.port);
  if (v.safetyMode !== undefined) env.LAB_SAFETY_MODE = v.safetyMode;
  if (v.allowedOrigins !== undefined) env.LAB_ALLOWED_ORIGINS = v.allowedOrigins.join(",");
  if (v.logLevel !== undefined) env.LAB_LOG_LEVEL = v.logLevel;
  if (v.logMaxBytes !== undefined) env.LAB_LOG_MAX_BYTES = String(v.logMaxBytes);
  if (v.logMaxFiles !== undefined) env.LAB_LOG_MAX_FILES = String(v.logMaxFiles);
  if (v.dashboardDir !== undefined) env.LAB_DASHBOARD_DIR = v.dashboardDir;
  if (v.workflowsDir !== undefined) env.LAB_WORKFLOWS_DIR = v.workflowsDir;
  return env;
}

/** Environment wins over the file (explicit operator override). */
export function mergeConfigEnv(fileEnv: ConfigEnv, env: ConfigEnv): ConfigEnv {
  const out: ConfigEnv = { ...fileEnv };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") (out as Record<string, string>)[k] = v;
  return out;
}

/** Validate, then write atomically (previous file kept as config.json.bak). */
export function writeServiceConfigFile(dataDir: string, values: unknown): ServiceConfigFile {
  const v = validateServiceConfigFile(values);
  if (!v.ok) throw new Error(`invalid configuration: ${v.errors.join("; ")}`);
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, CONFIG_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(v.value, null, 2)}\n`, { mode: 0o600 });
  try {
    if (existsSync(file)) {
      rmSync(`${file}.bak`, { force: true });
      renameSync(file, `${file}.bak`);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  writeFileSync(join(dataDir, LAST_GOOD_FILE), `${JSON.stringify(v.value, null, 2)}\n`, { mode: 0o600 });
  return v.value;
}

/** Parse "key=value" for a setting of the right type. */
export function parseSetting(key: string, raw: string): unknown {
  const kind = KEYS[key as keyof ServiceConfigFile];
  if (!kind) throw new Error(`unknown setting: ${key}`);
  if (kind === "int") return Number(raw);
  if (kind === "origins") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return raw;
}
