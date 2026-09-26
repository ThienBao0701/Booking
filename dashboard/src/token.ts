/**
 * Token handling (pure part). The operator opens /dashboard/#token=<token>;
 * the fragment never reaches the server. The app moves the token into
 * sessionStorage and rewrites the address bar without it (ADR-0006).
 */

/** Tokens are base64url (generateToken) — accept a conservative charset only. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

export function isPlausibleToken(t: string): boolean {
  return TOKEN_RE.test(t);
}

/**
 * Split a location hash into a token (when the hash is `#token=…`, optionally
 * followed by `&next=<route>`) and the route hash to continue with.
 */
export function takeToken(hash: string): { token?: string; rest: string } {
  const m = /^#token=([^&]*)(?:&next=(.*))?$/.exec(hash);
  if (!m) return { rest: hash };
  const token = decodeURIComponent(m[1] ?? "");
  const next = m[2] ? decodeURIComponent(m[2]) : "";
  const rest = next.startsWith("#/") ? next : "#/overview";
  return isPlausibleToken(token) ? { token, rest } : { rest };
}
