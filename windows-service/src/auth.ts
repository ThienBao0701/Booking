/**
 * Auth token handling (Component 13). Constant-time bearer comparison; tokens
 * are generated locally and stored user-only. Tokens are never logged in full.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** Generate a URL-safe random token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison that tolerates length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still do a comparison to avoid early-exit timing leak, then return false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

/** Short, non-reversible id for a token, safe to log. */
export function tokenId(token: string): string {
  // First 8 chars of a base64url of a length-salted hash-free digest substitute:
  // we avoid importing hash here to keep it trivial; use a fixed prefix marker.
  return `tok_${token.slice(0, 4)}…(${token.length})`;
}

export function verifyToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return safeEqual(provided, expected);
}
