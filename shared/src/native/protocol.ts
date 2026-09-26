/**
 * Native Messaging contract (Phase 14, ADR-0009): extension ↔ native host.
 *
 *   Chrome extension ──(length-prefixed JSON on stdio)──► native host
 *   native host ──(loopback HTTP, same /v1 pipeline)──► lab service
 *
 * The host is a validated relay: it holds no data and no secret. Each relayed
 * request carries the extension's own bearer token and is authenticated by
 * the service exactly as over the HTTP transport. Only the bridge's routes can
 * be relayed. Pure module: shared by the extension and the service.
 */

import { CONTRACT_VERSION } from "../version.ts";

/** Registered host name (lowercase, dots/underscores; Chrome's naming rule). */
export const NATIVE_HOST_NAME = "com.automation_lab.bridge";

/** Protocol versions this build speaks; peers negotiate the highest common one. */
export const NATIVE_PROTOCOL = { min: 1, max: 1 } as const;

/** Chrome's limit for host → extension messages (1 MiB). */
export const NATIVE_MAX_TO_EXTENSION_BYTES = 1024 * 1024;
/** Our limit for extension → host messages (screenshot uploads fit; Chrome allows more). */
export const NATIVE_MAX_TO_HOST_BYTES = 32 * 1024 * 1024;
/** Largest relayed request body. */
export const NATIVE_MAX_BODY_CHARS = 30 * 1024 * 1024;

export type NativeErrorCode =
  | "invalid_message"
  | "handshake_required"
  | "already_handshaken"
  | "unsupported_protocol"
  | "origin_not_allowed"
  | "host_misconfigured"
  | "route_not_allowed"
  | "service_unreachable"
  | "timeout"
  | "busy"
  | "message_too_large"
  | "response_too_large"
  | "internal";

/** Errors a client may retry (after reconnecting where the host closed). */
export const RETRYABLE_NATIVE_ERRORS: ReadonlySet<NativeErrorCode> = new Set(["service_unreachable", "timeout", "busy", "internal"]);

// ---- extension → host ----

export interface NativeHello {
  type: "hello";
  protocol: { min: number; max: number };
  extensionVersion: string;
  contractVersion: number;
}

/** Only these request headers are relayed; everything else is dropped. */
export const NATIVE_RELAY_HEADERS = ["authorization", "content-type", "accept"] as const;
export type NativeRelayHeader = (typeof NATIVE_RELAY_HEADERS)[number];

export interface NativeRequest {
  type: "request";
  /** Unique per connection (1..64 chars). */
  id: string;
  method: "GET" | "POST";
  /** Path + query on the service, e.g. "/v1/events". */
  path: string;
  headers: Partial<Record<NativeRelayHeader, string>>;
  body?: string;
}

export interface NativePing {
  type: "ping";
  id: string;
}

export type ExtensionToHost = NativeHello | NativeRequest | NativePing;

// ---- host → extension ----

export interface NativeWelcome {
  type: "welcome";
  protocol: number;
  hostVersion: string;
  contractVersion: number;
  /** The service the host relays to (loopback) and whether its /healthz answered. */
  service: { url: string; reachable: boolean; safetyMode?: string };
}

export interface NativeResponse {
  type: "response";
  id: string;
  status: number;
  /** Parsed JSON body (undefined when the service sent none or non-JSON). */
  body?: unknown;
}

export interface NativeError {
  type: "error";
  /** The request this error answers; absent for connection-level errors. */
  id?: string;
  code: NativeErrorCode;
  message: string;
  retryable: boolean;
  /** The host closes the connection after a fatal error. */
  fatal: boolean;
}

export interface NativePong {
  type: "pong";
  id: string;
}

export type HostToExtension = NativeWelcome | NativeResponse | NativeError | NativePong;

// ---- routes ----

const SEG = "[A-Za-z0-9_.:-]{1,128}";
/** The bridge's routes — nothing else can be reached through the host. */
const RELAY_ROUTES: ReadonlyArray<readonly ["GET" | "POST", RegExp]> = [
  ["GET", /^\/healthz$/],
  ["GET", /^\/v1\/bridge\/handshake$/],
  ["POST", /^\/v1\/sessions$/],
  ["POST", new RegExp(`^/v1/sessions/${SEG}/end$`)],
  ["POST", /^\/v1\/events$/],
  ["POST", /^\/v1\/screenshots$/],
];

export function isRelayableRoute(method: string, path: string): boolean {
  if (typeof path !== "string" || path.length > 300 || /\.\.|[?#%\\]/.test(path)) return false;
  return RELAY_ROUTES.some(([m, re]) => m === method && re.test(path));
}

// ---- negotiation ----

export function negotiateProtocol(offer: { min: number; max: number }, supported: { min: number; max: number } = NATIVE_PROTOCOL): number | undefined {
  const hi = Math.min(offer.max, supported.max);
  const lo = Math.max(offer.min, supported.min);
  return hi >= lo ? hi : undefined;
}

// ---- validation (fail closed: unknown fields are rejected) ----

type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function obj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(`unknown field: ${k}`);
}
function int(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

export function validateExtensionMessage(v: unknown): Result<ExtensionToHost> {
  const errors: string[] = [];
  if (!obj(v)) return { ok: false, errors: ["message must be an object"] };
  switch (v.type) {
    case "hello": {
      onlyKeys(v, ["type", "protocol", "extensionVersion", "contractVersion"], errors);
      const p = v.protocol;
      if (!obj(p) || !int(p.min, 1, 1000) || !int(p.max, 1, 1000) || p.min > p.max || Object.keys(p).length !== 2) errors.push("protocol must be {min, max} with 1 ≤ min ≤ max");
      if (typeof v.extensionVersion !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(v.extensionVersion)) errors.push("extensionVersion invalid");
      if (!int(v.contractVersion, 1, 1000)) errors.push("contractVersion invalid");
      break;
    }
    case "request": {
      onlyKeys(v, ["type", "id", "method", "path", "headers", "body"], errors);
      if (typeof v.id !== "string" || !ID.test(v.id)) errors.push("id invalid");
      if (v.method !== "GET" && v.method !== "POST") errors.push("method must be GET or POST");
      if (typeof v.path !== "string" || !v.path.startsWith("/") || v.path.length > 300) errors.push("path invalid");
      if (!obj(v.headers)) errors.push("headers must be an object");
      else {
        for (const [k, h] of Object.entries(v.headers)) {
          if (!(NATIVE_RELAY_HEADERS as readonly string[]).includes(k)) errors.push(`header not relayed: ${k}`);
          else if (typeof h !== "string" || h.length > 4096 || /[\r\n\0]/.test(h)) errors.push(`header ${k} invalid`);
        }
      }
      if (v.body !== undefined && (typeof v.body !== "string" || v.body.length > NATIVE_MAX_BODY_CHARS)) errors.push("body must be a string within the size limit");
      if (v.method === "GET" && v.body !== undefined) errors.push("GET has no body");
      break;
    }
    case "ping":
      onlyKeys(v, ["type", "id"], errors);
      if (typeof v.id !== "string" || !ID.test(v.id)) errors.push("id invalid");
      break;
    default:
      return { ok: false, errors: [`unknown message type: ${String(v.type).slice(0, 40)}`] };
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v as unknown as ExtensionToHost };
}

const ERROR_CODES: ReadonlySet<string> = new Set<NativeErrorCode>([
  "invalid_message",
  "handshake_required",
  "already_handshaken",
  "unsupported_protocol",
  "origin_not_allowed",
  "host_misconfigured",
  "route_not_allowed",
  "service_unreachable",
  "timeout",
  "busy",
  "message_too_large",
  "response_too_large",
  "internal",
]);

export function validateHostMessage(v: unknown): Result<HostToExtension> {
  const errors: string[] = [];
  if (!obj(v)) return { ok: false, errors: ["message must be an object"] };
  switch (v.type) {
    case "welcome": {
      onlyKeys(v, ["type", "protocol", "hostVersion", "contractVersion", "service"], errors);
      if (!int(v.protocol, 1, 1000)) errors.push("protocol invalid");
      if (typeof v.hostVersion !== "string" || v.hostVersion.length > 32) errors.push("hostVersion invalid");
      if (!int(v.contractVersion, 1, 1000)) errors.push("contractVersion invalid");
      const s = v.service;
      if (!obj(s) || typeof s.url !== "string" || typeof s.reachable !== "boolean" || (s.safetyMode !== undefined && typeof s.safetyMode !== "string")) errors.push("service invalid");
      break;
    }
    case "response":
      onlyKeys(v, ["type", "id", "status", "body"], errors);
      if (typeof v.id !== "string" || !ID.test(v.id)) errors.push("id invalid");
      if (!int(v.status, 100, 599)) errors.push("status invalid");
      break;
    case "error":
      onlyKeys(v, ["type", "id", "code", "message", "retryable", "fatal"], errors);
      if (v.id !== undefined && (typeof v.id !== "string" || !ID.test(v.id))) errors.push("id invalid");
      if (typeof v.code !== "string" || !ERROR_CODES.has(v.code)) errors.push("code invalid");
      if (typeof v.message !== "string" || v.message.length > 1000) errors.push("message invalid");
      if (typeof v.retryable !== "boolean" || typeof v.fatal !== "boolean") errors.push("retryable/fatal must be booleans");
      break;
    case "pong":
      onlyKeys(v, ["type", "id"], errors);
      if (typeof v.id !== "string" || !ID.test(v.id)) errors.push("id invalid");
      break;
    default:
      return { ok: false, errors: [`unknown message type: ${String(v.type).slice(0, 40)}`] };
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: v as unknown as HostToExtension };
}

/** The hello this build sends. */
export function helloMessage(extensionVersion: string): NativeHello {
  return { type: "hello", protocol: { ...NATIVE_PROTOCOL }, extensionVersion, contractVersion: CONTRACT_VERSION };
}

/** Chrome extension origin as passed to the host ("chrome-extension://<32 a-p>/"). */
export const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})\/?$/;
export const EXTENSION_ID_RE = /^[a-p]{32}$/;
