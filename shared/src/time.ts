/**
 * Time + ordering helpers. Ordering within a session uses a monotonic sequence
 * because two events can share a millisecond (see docs/02-event-schema.md).
 */

/** Epoch-millisecond clock, injectable for deterministic tests. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/**
 * Per-session monotonic sequence generator. Guarantees strictly increasing
 * ordering keys even if the wall clock does not advance or moves backward.
 */
export class SequenceCounter {
  #next: number;

  constructor(start = 0) {
    this.#next = start;
  }

  /** Return the next sequence value (strictly increasing). */
  next(): number {
    const v = this.#next;
    this.#next += 1;
    return v;
  }

  /** Current value that would be returned next, without advancing. */
  peek(): number {
    return this.#next;
  }
}

/** Format an epoch-ms as `HH:MM:SS` (UTC) for timeline rendering. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
