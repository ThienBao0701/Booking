/**
 * Persistent event queue contract. Events stay queued until the service
 * acknowledges them (stored / duplicate / quarantined / terminally rejected),
 * so nothing is lost across service-worker restarts, service downtime, or
 * network changes. `MemoryQueue` is the reference implementation (tests);
 * `IdbQueue` (storage/idb-queue.ts) is the browser implementation.
 */

import type { RecordedEvent } from "../shared.ts";

export interface EventQueue {
  /** Append events (FIFO). Pushing an id that is already queued is a no-op. */
  push(events: RecordedEvent[]): Promise<void>;
  /** Oldest-first, up to `limit`, without removing. */
  peek(limit: number): Promise<RecordedEvent[]>;
  /** Remove acknowledged events by id (unknown ids ignored). */
  ack(ids: string[]): Promise<void>;
  size(): Promise<number>;
  /** Drop oldest events so that at most `max` remain; returns how many were dropped. */
  trim(max: number): Promise<number>;
  clear(): Promise<void>;
}

export class MemoryQueue implements EventQueue {
  #items = new Map<string, RecordedEvent>();

  async push(events: RecordedEvent[]): Promise<void> {
    for (const e of events) if (!this.#items.has(e.event_id)) this.#items.set(e.event_id, e);
  }

  async peek(limit: number): Promise<RecordedEvent[]> {
    const out: RecordedEvent[] = [];
    for (const e of this.#items.values()) {
      if (out.length >= limit) break;
      out.push(e);
    }
    return out;
  }

  async ack(ids: string[]): Promise<void> {
    for (const id of ids) this.#items.delete(id);
  }

  async size(): Promise<number> {
    return this.#items.size;
  }

  async trim(max: number): Promise<number> {
    let dropped = 0;
    while (this.#items.size > max) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
      dropped += 1;
    }
    return dropped;
  }

  async clear(): Promise<void> {
    this.#items.clear();
  }
}
