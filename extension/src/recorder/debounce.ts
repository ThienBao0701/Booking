/**
 * Injectable timers + a debouncer with a max-wait bound (Component 16: debounce
 * DOM observers, batch events, never block the UI). Timers are injectable so
 * the recorder is deterministic under test.
 */

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realTimers: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]),
  now: () => Date.now(),
};

/**
 * Calls `fn` once activity has been quiet for `waitMs`, but never later than
 * `maxWaitMs` after the first trigger of a burst (so a constant stream of
 * activity still flushes regularly).
 */
export class Debouncer {
  #fn: () => void;
  #waitMs: number;
  #maxWaitMs: number;
  #timers: TimerApi;
  #handle: unknown = undefined;
  #burstStart: number | undefined = undefined;

  constructor(fn: () => void, waitMs: number, maxWaitMs = waitMs * 5, timers: TimerApi = realTimers) {
    this.#fn = fn;
    this.#waitMs = waitMs;
    this.#maxWaitMs = Math.max(maxWaitMs, waitMs);
    this.#timers = timers;
  }

  get pending(): boolean {
    return this.#handle !== undefined;
  }

  trigger(): void {
    const now = this.#timers.now();
    if (this.#burstStart === undefined) this.#burstStart = now;
    if (this.#handle !== undefined) this.#timers.clearTimeout(this.#handle);
    const remainingMax = this.#burstStart + this.#maxWaitMs - now;
    const delay = Math.max(0, Math.min(this.#waitMs, remainingMax));
    this.#handle = this.#timers.setTimeout(() => this.flushNow(), delay);
  }

  flushNow(): void {
    if (this.#handle !== undefined) this.#timers.clearTimeout(this.#handle);
    this.#handle = undefined;
    this.#burstStart = undefined;
    this.#fn();
  }

  cancel(): void {
    if (this.#handle !== undefined) this.#timers.clearTimeout(this.#handle);
    this.#handle = undefined;
    this.#burstStart = undefined;
  }
}
