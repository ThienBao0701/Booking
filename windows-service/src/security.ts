/**
 * Request-layer defenses (Component 13 / docs/05-security-model.md):
 *  - Host-header validation (anti DNS-rebinding): Host must match the exact
 *    loopback host:port the service bound to.
 *  - Origin validation: reject web origins; allow no-Origin (native) and
 *    allow-listed chrome-extension origins.
 *  - Rate limiting: fixed-window counter per (token, route).
 */

export interface HostCheckInput {
  hostHeader: string | undefined;
  expectedHost: string;
  expectedPort: number;
}

/** True if the Host header is exactly our bound loopback host:port. */
export function isHostAllowed({ hostHeader, expectedHost, expectedPort }: HostCheckInput): boolean {
  if (!hostHeader) return false;
  const candidates = new Set<string>([
    `${expectedHost}:${expectedPort}`,
    `127.0.0.1:${expectedPort}`,
    `localhost:${expectedPort}`,
    `[::1]:${expectedPort}`,
  ]);
  return candidates.has(hostHeader.trim().toLowerCase());
}

export interface OriginCheckInput {
  origin: string | undefined;
  allowedOrigins: string[];
}

/**
 * Allow: absent Origin (non-browser / native messaging), or an allow-listed
 * chrome-extension:// origin. Reject any http(s) web origin outright.
 */
export function isOriginAllowed({ origin, allowedOrigins }: OriginCheckInput): boolean {
  if (origin === undefined || origin === "" || origin === "null") return true;
  if (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
    // If an allow-list is configured, enforce it; otherwise accept any extension.
    if (allowedOrigins.length === 0) return true;
    return allowedOrigins.includes(origin);
  }
  return false; // http/https or anything else: rejected
}

/** Fixed-window rate limiter. */
export class RateLimiter {
  #windowMs: number;
  #max: number;
  #buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  /** Returns true if the request is allowed; false if rate-limited. */
  allow(key: string, now = Date.now()): boolean {
    const b = this.#buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (b.count >= this.#max) return false;
    b.count += 1;
    return true;
  }

  /** Drop expired buckets (call periodically to bound memory). */
  sweep(now = Date.now()): void {
    for (const [k, b] of this.#buckets) if (now >= b.resetAt) this.#buckets.delete(k);
  }
}
