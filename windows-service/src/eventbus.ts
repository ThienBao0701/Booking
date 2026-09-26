/**
 * In-process structured JSON event bus (Component 2). Decouples ingestion from
 * consumers (persistence, analyzer, dashboard live-feed). Bounded, non-blocking:
 * a slow subscriber never blocks the browser/UI (Component 16).
 */

import type { LabEvent } from "./shared.ts";

export type BusMessage =
  | { type: "event"; payload: LabEvent }
  | { type: "session.start"; payload: { sessionId: string } }
  | { type: "session.end"; payload: { sessionId: string } };

export type BusHandler = (msg: BusMessage) => void;

export class EventBus {
  #handlers = new Set<BusHandler>();

  subscribe(handler: BusHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  publish(msg: BusMessage): void {
    for (const h of this.#handlers) {
      try {
        h(msg);
      } catch {
        // A faulty subscriber must not break publication for others.
      }
    }
  }

  get size(): number {
    return this.#handlers.size;
  }
}
