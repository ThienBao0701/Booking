/**
 * Hash routing (pure). Routes: #/<page>[/<id>][?k=v&…]. Parameters carry the
 * filters, so every view is linkable and the back button works. The token is
 * never part of a route (see auth.ts).
 */

export const PAGES = [
  "overview",
  "sessions",
  "compare",
  "timeline",
  "workflows",
  "events",
  "findings",
  "environment",
  "runs",
  "screenshots",
  "reports",
  "settings",
] as const;
export type Page = (typeof PAGES)[number];

export interface Route {
  page: Page;
  id?: string;
  params: Record<string, string>;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart = "", query = ""] = raw.split("?", 2);
  const [pageRaw = "", ...rest] = pathPart.split("/").filter((s) => s.length > 0);
  const page = (PAGES as readonly string[]).includes(pageRaw) ? (pageRaw as Page) : "overview";
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) if (v !== "") params[k] = v;
  const id = rest.length > 0 ? decodeURIComponent(rest.join("/")) : undefined;
  return { page, ...(id !== undefined && page === pageRaw ? { id } : {}), params };
}

export function buildHash(page: Page, params: Record<string, string | number | undefined | null> = {}, id?: string): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const qs = q.toString();
  return `#/${page}${id !== undefined ? `/${encodeURIComponent(id)}` : ""}${qs ? `?${qs}` : ""}`;
}

/** Date-range presets used by the filter bar. */
export const RANGES = { all: 0, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 } as const;
export type RangePreset = keyof typeof RANGES | "custom";

/** Resolve range params into absolute [from, to] (ms) — undefined = open. */
export function resolveRange(params: Record<string, string>, now: number): { from?: number; to?: number } {
  const preset = params.range as RangePreset | undefined;
  if (preset === "custom") {
    const from = params.from ? Date.parse(`${params.from}T00:00:00`) : Number.NaN;
    const to = params.to ? Date.parse(`${params.to}T23:59:59.999`) : Number.NaN;
    return { ...(Number.isFinite(from) ? { from } : {}), ...(Number.isFinite(to) ? { to } : {}) };
  }
  if (preset && preset in RANGES && preset !== "all") return { from: now - RANGES[preset as keyof typeof RANGES] };
  return {};
}

/** Build an API query string from filter values (drops empty values). */
export function apiQuery(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}
