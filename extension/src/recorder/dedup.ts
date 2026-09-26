/**
 * Event deduplication:
 *  1. by event_id (bounded LRU) — protects against re-enqueue of the same event;
 *  2. by content within a short window — collapses double-fired DOM events
 *     (e.g. the same click reported twice within a few ms).
 */

import type { RecordedEvent } from "../shared.ts";

export interface DedupOptions {
  /** Identical-content events closer together than this are dropped. */
  windowMs: number;
  /** Max remembered ids / content keys. */
  maxEntries: number;
}

export const DEFAULT_DEDUP: DedupOptions = { windowMs: 250, maxEntries: 2000 };

/** Actions that are unique by nature and never content-deduplicated. */
const NEVER_CONTENT_DEDUP = new Set(["session_start", "session_end", "workflow_transition", "screenshot"]);

/** Every recorded field except identity (event_id), ordering (seq) and time. */
function contentKey(e: RecordedEvent): string {
  return JSON.stringify([
    e.session_id,
    e.tab_id ?? null,
    e.action,
    e.page,
    e.workflow,
    e.severity ?? null,
    e.target ?? null,
    e.metadata,
  ]);
}

export class Deduplicator {
  #opts: DedupOptions;
  #ids = new Map<string, true>();
  #content = new Map<string, number>();

  constructor(opts: Partial<DedupOptions> = {}) {
    this.#opts = { ...DEFAULT_DEDUP, ...opts };
  }

  /** Returns true when `e` duplicates something already seen (and should be dropped). */
  isDuplicate(e: RecordedEvent): boolean {
    if (this.#ids.has(e.event_id)) return true;
    this.#remember(this.#ids, e.event_id, true);

    if (NEVER_CONTENT_DEDUP.has(e.action)) return false;
    const key = contentKey(e);
    const last = this.#content.get(key);
    this.#remember(this.#content, key, e.timestamp);
    return last !== undefined && Math.abs(e.timestamp - last) < this.#opts.windowMs;
  }

  #remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key); // refresh recency
    map.set(key, value);
    while (map.size > this.#opts.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
