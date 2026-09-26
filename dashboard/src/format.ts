/** Pure formatting helpers (no DOM). All output is plain text. */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Local date-time "YYYY-MM-DD HH:MM:SS". */
export function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local clock "HH:MM:SS.mmm" (timeline detail). */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Human duration: 350 ms · 12.3 s · 4 min 5 s · 2 h 3 min · 3 d 4 h. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const neg = ms < 0;
  let v = Math.abs(ms);
  let out: string;
  if (v < 1000) out = `${Math.round(v)} ms`;
  else if (v < 60_000) out = `${(Math.round(v / 100) / 10).toFixed(v < 10_000 ? 1 : 0)} s`;
  else if (v < 3_600_000) {
    v = Math.round(v / 1000);
    out = `${Math.floor(v / 60)} min${v % 60 ? ` ${v % 60} s` : ""}`;
  } else if (v < 86_400_000) {
    v = Math.round(v / 60_000);
    out = `${Math.floor(v / 60)} h${v % 60 ? ` ${v % 60} min` : ""}`;
  } else {
    v = Math.round(v / 3_600_000);
    out = `${Math.floor(v / 24)} d${v % 24 ? ` ${v % 24} h` : ""}`;
  }
  return neg ? `−${out}` : out;
}

/** Thousands separators: 12,345. */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

/** Compact: 1,284 · 12.9K · 4.2M. */
export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a < 10_000) return fmtInt(n);
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtPct(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** Shorten a long id for tables, keeping head and tail. */
export function shortId(id: string, keep = 10): string {
  return id.length <= keep * 2 + 1 ? id : `${id.slice(0, keep)}…${id.slice(-keep + 2)}`;
}

/** Workflow / enum label for display: RESERVATION → Reservation, RATE_SETUP → Rate setup. */
export function label(v: string | null | undefined): string {
  if (!v) return "—";
  const s = v.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Parse the stored JSON payload of an event row; never throws. */
export function parseData(data: string): Record<string, unknown> {
  try {
    const v = JSON.parse(data) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { unparsable: true };
  }
}

/** One-line summary of an event payload (target selector, page, from→to). */
export function eventSummary(kind: string, data: Record<string, unknown>): string {
  const md = (data.metadata ?? {}) as Record<string, unknown>;
  const target = (data.target ?? {}) as Record<string, unknown>;
  if (kind === "WORKFLOW_TRANSITION") return `${String(md.from ?? "?")} → ${String(md.to ?? "?")}`;
  if (typeof target.selector === "string") return `${String(data.action ?? kind.toLowerCase())} ${target.selector}`;
  if (md.quarantined === true || data.quarantined === true) return "payload quarantined (sensitive content)";
  if (kind === "SCREENSHOT") return `screenshot ${typeof md.sha256 === "string" ? md.sha256.slice(0, 12) : ""}`.trim();
  if (kind === "ERROR" && typeof md.message === "string") return md.message;
  const page = typeof data.page === "string" ? data.page : typeof data.path === "string" ? data.path : "";
  return `${String(data.action ?? kind.toLowerCase())}${page ? ` ${page}` : ""}`;
}
