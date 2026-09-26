/**
 * BrowserTargetPolicy (Phase 11): what a real browser may touch.
 *
 * Created only after the shared replay policy (`evaluateReplay`) allows the
 * mode + target — no policy object exists for an unauthorized run, so a
 * browser can never be launched for one. On top of that it enforces an
 * EXPLICIT origin allowlist:
 *   - the target's origin must itself be listed (authorization record alone is
 *     not enough to drive a browser);
 *   - top-level navigations may only go to listed origins;
 *   - sub-resource requests may go to listed origins plus explicitly listed
 *     resource origins (e.g. a CDN); everything else is blocked and logged;
 *   - entries are exact origins: https for remote hosts, http only for
 *     loopback; no wildcards, paths, queries or userinfo.
 */

import { type PolicyDecision, type ReplayTarget, type SafetyMode, evaluateReplay, isLoopbackUrl } from "../../shared.ts";

export type BrowserPolicyCode =
  | "OK"
  | "NOT_AUTHORIZED"
  | "NO_TARGET_URL"
  | "TARGET_NOT_ALLOWLISTED"
  | "INVALID_ALLOWLIST_ENTRY"
  | "ORIGIN_NOT_ALLOWED"
  | "SCHEME_NOT_ALLOWED";

export interface BrowserPolicyDecision {
  allowed: boolean;
  code: BrowserPolicyCode;
  reason: string;
}

export interface BrowserPolicyInput {
  mode: SafetyMode;
  target: ReplayTarget;
  /** Exact origins the browser may navigate to; must include the target's origin. */
  allowlist: readonly string[];
  /** Extra origins allowed for sub-resources only (scripts, styles, images, XHR). */
  resourceOrigins?: readonly string[];
}

export type BrowserPolicyResult =
  | { ok: true; policy: BrowserTargetPolicy }
  | { ok: false; code: BrowserPolicyCode; reason: string; replayDecision?: PolicyDecision };

const MAX_ENTRIES = 50;

/**
 * Normalise an allowlist entry to an exact origin ("https://host[:port]"), or
 * return an error string. Remote origins must be https; http only for loopback.
 */
export function normalizeOrigin(entry: string): { origin: string } | { error: string } {
  if (typeof entry !== "string" || entry.trim() === "") return { error: "empty entry" };
  const raw = entry.trim();
  if (raw.includes("*")) return { error: `wildcards are not allowed: ${raw}` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: `not a URL: ${raw}` };
  }
  if (u.username || u.password) return { error: `userinfo is not allowed: ${raw}` };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: `only http(s) origins: ${raw}` };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { error: `an origin has no path, query or fragment: ${raw}` };
  if (u.protocol === "http:" && !isLoopbackUrl(u.origin)) return { error: `plain http is allowed for loopback only; use https: ${raw}` };
  return { origin: u.origin };
}

/** Origin of an absolute http(s) URL, or undefined. */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.username || u.password) return undefined;
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export class BrowserTargetPolicy {
  readonly mode: SafetyMode;
  readonly targetKind: ReplayTarget["kind"];
  readonly targetOrigin: string;
  readonly baseUrl: string;
  readonly #navigation: ReadonlySet<string>;
  readonly #resources: ReadonlySet<string>;

  private constructor(mode: SafetyMode, target: { kind: ReplayTarget["kind"]; baseUrl: string }, origin: string, nav: Set<string>, res: Set<string>) {
    this.mode = mode;
    this.targetKind = target.kind;
    this.baseUrl = target.baseUrl;
    this.targetOrigin = origin;
    this.#navigation = nav;
    this.#resources = res;
  }

  /** Authorize (shared policy) and validate the explicit allowlist. */
  static create(input: BrowserPolicyInput): BrowserPolicyResult {
    const decision = evaluateReplay(input.mode, input.target);
    if (!decision.allowed) return { ok: false, code: "NOT_AUTHORIZED", reason: decision.reason, replayDecision: decision };
    if (input.target.kind === "observe") return { ok: false, code: "NO_TARGET_URL", reason: "observe targets have no URL" };
    const targetOrigin = originOf(input.target.baseUrl);
    if (!targetOrigin) return { ok: false, code: "NO_TARGET_URL", reason: `target baseUrl is not an absolute http(s) URL: ${input.target.baseUrl}` };
    if (input.allowlist.length + (input.resourceOrigins?.length ?? 0) > MAX_ENTRIES) {
      return { ok: false, code: "INVALID_ALLOWLIST_ENTRY", reason: `at most ${MAX_ENTRIES} allowlist entries` };
    }
    const nav = new Set<string>();
    for (const e of input.allowlist) {
      const n = normalizeOrigin(e);
      if ("error" in n) return { ok: false, code: "INVALID_ALLOWLIST_ENTRY", reason: n.error };
      nav.add(n.origin);
    }
    const res = new Set<string>();
    for (const e of input.resourceOrigins ?? []) {
      const n = normalizeOrigin(e);
      if ("error" in n) return { ok: false, code: "INVALID_ALLOWLIST_ENTRY", reason: n.error };
      res.add(n.origin);
    }
    if (!nav.has(targetOrigin)) {
      return {
        ok: false,
        code: "TARGET_NOT_ALLOWLISTED",
        reason: `the target origin ${targetOrigin} is not in the browser allowlist; add it explicitly (--allow-origin ${targetOrigin})`,
      };
    }
    return { ok: true, policy: new BrowserTargetPolicy(input.mode, input.target, targetOrigin, nav, res) };
  }

  /** Top-level navigation: listed origins only (about:blank is always allowed). */
  checkNavigation(url: string): BrowserPolicyDecision {
    if (url === "about:blank") return { allowed: true, code: "OK", reason: "blank page" };
    const origin = originOf(url);
    if (!origin) return { allowed: false, code: "SCHEME_NOT_ALLOWED", reason: `navigation to a non-http(s) URL is blocked: ${url.slice(0, 200)}` };
    return this.#navigation.has(origin)
      ? { allowed: true, code: "OK", reason: "allowlisted origin" }
      : { allowed: false, code: "ORIGIN_NOT_ALLOWED", reason: `navigation outside the allowlist is blocked: ${origin}` };
  }

  /** Any request the page makes. Navigations follow checkNavigation; data:/blob: are local. */
  checkRequest(url: string, isNavigation: boolean): BrowserPolicyDecision {
    if (isNavigation) return this.checkNavigation(url);
    if (url.startsWith("data:") || url.startsWith("blob:")) return { allowed: true, code: "OK", reason: "local resource" };
    const origin = originOf(url);
    if (!origin) return { allowed: false, code: "SCHEME_NOT_ALLOWED", reason: `request with a non-http(s) scheme is blocked: ${url.slice(0, 200)}` };
    return this.#navigation.has(origin) || this.#resources.has(origin)
      ? { allowed: true, code: "OK", reason: "allowlisted origin" }
      : { allowed: false, code: "ORIGIN_NOT_ALLOWED", reason: `request outside the allowlist is blocked: ${origin}` };
  }

  /**
   * Network egress (EgressProxy): may this origin be contacted at all?
   * Navigation and resource origins; the finer navigation rule is applied by
   * the browser routing and the landing check.
   */
  checkEgress(origin: string): BrowserPolicyDecision {
    return this.#navigation.has(origin) || this.#resources.has(origin)
      ? { allowed: true, code: "OK", reason: "allowlisted origin" }
      : { allowed: false, code: "ORIGIN_NOT_ALLOWED", reason: `egress to ${origin} is not allowlisted` };
  }

  /** Resolve a step target ("/path" or absolute URL) against the base URL. */
  resolve(url: string): string {
    return new URL(url, this.baseUrl).toString();
  }

  describe(): { mode: SafetyMode; targetKind: string; targetOrigin: string; navigationOrigins: string[]; resourceOrigins: string[] } {
    return {
      mode: this.mode,
      targetKind: this.targetKind,
      targetOrigin: this.targetOrigin,
      navigationOrigins: [...this.#navigation].sort(),
      resourceOrigins: [...this.#resources].sort(),
    };
  }
}
