/** Plain-text formatting shared by the report renderers. */

/** 350 ms · 12.3 s · 4 min 5 s · 2 h 3 min. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const neg = ms < 0;
  let v = Math.abs(ms);
  let out: string;
  if (v < 1000) out = `${Math.round(v)} ms`;
  else if (v < 60_000) out = `${(Math.round(v / 100) / 10).toFixed(v < 10_000 ? 1 : 0)} s`;
  else if (v < 3_600_000) {
    v = Math.round(v / 1000);
    out = `${Math.floor(v / 60)} min${v % 60 ? ` ${v % 60} s` : ""}`;
  } else {
    v = Math.round(v / 60_000);
    out = `${Math.floor(v / 60)} h${v % 60 ? ` ${v % 60} min` : ""}`;
  }
  return neg ? `-${out}` : out;
}

/** ISO 8601 UTC (unambiguous in forensic output). */
export function iso(ts: number | null | undefined): string {
  return ts === null || ts === undefined || !Number.isFinite(ts) ? "" : new Date(ts).toISOString();
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
