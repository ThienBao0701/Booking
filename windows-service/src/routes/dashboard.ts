/**
 * Static hosting of the built dashboard at /dashboard/ (ADR-0006). Serves files
 * only (no data); every response carries a strict CSP and anti-framing headers.
 * Paths are decoded, normalised and confined to the dashboard directory.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

export const DEFAULT_DASHBOARD_DIR = fileURLToPath(new URL("../../../dashboard/dist/", import.meta.url));

export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": DASHBOARD_CSP,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-read=()",
    "cache-control": "no-cache",
  };
}

function plain(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): number {
  res.writeHead(status, { ...securityHeaders(), "content-type": "text/plain; charset=utf-8", ...extra });
  res.end(body);
  return status;
}

/**
 * Resolve a request path under `/dashboard/` to a file inside `root`, or return
 * undefined when the path is not acceptable (traversal, hidden, unknown type).
 */
export function resolveDashboardFile(root: string, requestPath: string): string | undefined {
  let rel: string;
  try {
    rel = decodeURIComponent(requestPath.slice("/dashboard/".length));
  } catch {
    return undefined;
  }
  if (rel === "") rel = "index.html";
  if (rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return undefined;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) return undefined;
  if (!(extname(rel).toLowerCase() in TYPES)) return undefined;
  const base = resolve(root);
  const file = resolve(base, ...parts);
  if (!file.startsWith(base + sep)) return undefined;
  return file;
}

/** Handle GET/HEAD for "/", "/dashboard" and "/dashboard/*". Returns the status sent. */
export function serveDashboard(dir: string | undefined, method: string, path: string, res: ServerResponse): number {
  if (path === "/" || path === "/dashboard") {
    return plain(res, 308, "", { location: "/dashboard/" });
  }
  const root = dir ?? DEFAULT_DASHBOARD_DIR;
  if (!existsSync(join(root, "index.html"))) {
    return plain(res, 503, "dashboard not built: run `pnpm run build` (or set LAB_DASHBOARD_DIR)\n");
  }
  const file = resolveDashboardFile(root, path);
  if (!file) return plain(res, 404, "not found\n");
  let real: string;
  try {
    real = realpathSync(file);
    const realRoot = realpathSync(root);
    if (!real.startsWith(realRoot + sep)) return plain(res, 404, "not found\n");
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return plain(res, 404, "not found\n");
  } catch {
    return plain(res, 404, "not found\n");
  }
  const body = readFileSync(real);
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": TYPES[extname(real).toLowerCase()] as string,
    "content-length": String(body.length),
  });
  res.end(method === "HEAD" ? undefined : body);
  return 200;
}
