/** Pure data preparation for pages (unit-tested). */

/** Fill missing days (YYYY-MM-DD) with zero so the time axis is honest. */
export function fillDays(days: ReadonlyArray<{ day: string; count: number }>): Array<{ day: string; count: number }> {
  if (days.length === 0) return [];
  const byDay = new Map(days.map((d) => [d.day, d.count]));
  const first = Date.parse(`${days[0]?.day}T00:00:00Z`);
  const last = Date.parse(`${days[days.length - 1]?.day}T00:00:00Z`);
  const out: Array<{ day: string; count: number }> = [];
  for (let t = first; t <= last && out.length < 3660; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, count: byDay.get(day) ?? 0 });
  }
  return out;
}

/** Most common JSON value of a field across rows (ties → first seen). */
export function modeOf<T>(rows: readonly T[], get: (r: T) => unknown): string | undefined {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = get(r);
    if (v === undefined || v === null) continue;
    const k = JSON.stringify(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return best;
}

/** Sorted [key, value] entries of a count map, largest first. */
export function ranked(m: Record<string, number>, limit = 12): Array<[string, number]> {
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}
