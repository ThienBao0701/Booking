/**
 * IndexedDB-backed EventQueue (local persistence). MV3 service workers are
 * terminated when idle, so an in-memory buffer would lose events; this queue
 * survives worker restarts, browser restarts and service downtime.
 *
 * Layout: object store "queue" keyed by an auto-increment insertion counter
 * (FIFO), with a unique index on event_id (duplicate pushes are ignored).
 * Implements the same contract as MemoryQueue (test/primitives.test.ts).
 */

import type { RecordedEvent } from "../shared.ts";
import type { EventQueue } from "../recorder/queue.ts";

const DB_NAME = "lab-extension";
const DB_VERSION = 1;
const STORE = "queue";
const BY_ID = "by_event_id";

interface Row {
  q?: number;
  event: RecordedEvent;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction error"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "q", autoIncrement: true });
        store.createIndex(BY_ID, "event.event_id", { unique: true });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("cannot open IndexedDB"));
  });
}

export class IdbQueue implements EventQueue {
  #db: Promise<IDBDatabase>;

  constructor(db: Promise<IDBDatabase> = openQueueDb()) {
    this.#db = db;
  }

  async push(events: RecordedEvent[]): Promise<void> {
    if (events.length === 0) return;
    const db = await this.#db;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const event of events) {
      const r = store.add({ event } satisfies Row);
      // A duplicate event_id violates the unique index: ignore it, keep the transaction.
      r.onerror = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
    }
    await txDone(tx);
  }

  async peek(limit: number): Promise<RecordedEvent[]> {
    const db = await this.#db;
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll(undefined, limit);
    const rows = await new Promise<Row[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as Row[]);
      req.onerror = () => reject(req.error);
    });
    return rows.map((r) => r.event);
  }

  async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.#db;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const index = store.index(BY_ID);
    for (const id of ids) {
      const k = index.getKey(id);
      k.onsuccess = () => {
        if (k.result !== undefined) store.delete(k.result);
      };
    }
    await txDone(tx);
  }

  async size(): Promise<number> {
    const db = await this.#db;
    const req = db.transaction(STORE, "readonly").objectStore(STORE).count();
    return await new Promise<number>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async trim(max: number): Promise<number> {
    const db = await this.#db;
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    let dropped = 0;
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - max;
      if (excess <= 0) return;
      const cursor = store.openCursor(); // ascending key = oldest first
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || excess <= 0) return;
        c.delete();
        excess -= 1;
        dropped += 1;
        c.continue();
      };
    };
    await txDone(tx);
    return dropped;
  }

  async clear(): Promise<void> {
    const db = await this.#db;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await txDone(tx);
  }
}
