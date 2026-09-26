/** Deterministic test doubles for the recorder / bridge (no browser, no network). */

import type { IdEnv, RecordedEvent } from "../src/shared.ts";
import type { TimerApi } from "../src/recorder/debounce.ts";
import type { DeliveryResult, EventSink } from "../src/recorder/recorder.ts";

/** Let pending promise chains (queue writes, flushes) settle. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Manually-advanced clock + timer queue. */
export class FakeTimers implements TimerApi {
  #now: number;
  #seq = 0;
  #tasks = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_750_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#tasks.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#tasks.delete(handle as number);
  }

  get pending(): number {
    return this.#tasks.size;
  }

  /** Delays of currently scheduled timers, relative to now. */
  scheduledDelays(): number[] {
    return [...this.#tasks.values()].map((t) => t.at - this.#now).sort((a, b) => a - b);
  }

  /** Advance time by `ms`, firing due timers in order and settling async work after each. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, t] of this.#tasks) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const task = this.#tasks.get(nextId)!;
      this.#tasks.delete(nextId);
      this.#now = task.at;
      task.fn();
      await settle();
    }
    this.#now = target;
    await settle();
  }
}

/** Unique, time-sortable ids with no randomness. */
export function deterministicIdEnv(timers: { now(): number }): IdEnv {
  let n = 0;
  return {
    now: () => timers.now(),
    randomBytes: (len: number) => {
      n += 1;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = Math.floor(n / 32 ** i) % 32;
      return out;
    },
  };
}

/** Sink with scripted results (default: accept everything). */
export class FakeSink implements EventSink {
  calls: RecordedEvent[][] = [];
  delivered: RecordedEvent[] = [];
  script: DeliveryResult[] = [];

  async deliver(batch: RecordedEvent[]): Promise<DeliveryResult> {
    this.calls.push(batch);
    const r = this.script.shift() ?? { ok: true as const, ackIds: batch.map((e) => e.event_id), rejected: [] };
    if (r.ok) this.delivered.push(...batch);
    return r;
  }
}
