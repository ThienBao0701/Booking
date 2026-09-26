/**
 * BrowserAdapter (Phase 11): the engine-level abstraction under
 * BrowserSession. It is a deliberately small, Playwright-compatible subset
 * (browser → context → page) so it can be implemented over Playwright
 * (playwright-adapter.ts), raw CDP, or an in-memory fake for tests.
 *
 * Adapters expose ordinary browser behaviour only. They must not alter what a
 * site can observe about the browser (no user-agent / navigator / fingerprint
 * changes, no automation-indicator suppression) — see docs/17-browser-adapter.md.
 */

/** A CSS selector plus how to pick among matches (`$last` → the last match in document order). */
export interface SelectorSpec {
  css: string;
  pick: "only" | "last";
}

export interface AdapterLaunchOptions {
  headless: boolean;
  /** Browser binary (default: the adapter's own resolution). */
  executablePath?: string | undefined;
  /** Upper bound for starting the browser. */
  timeoutMs: number;
  /**
   * The session's loopback egress proxy (EgressProxy). When set, ALL browser
   * traffic must go through it (loopback included); adapters that cannot
   * guarantee that must refuse to launch.
   */
  proxyServer?: string | undefined;
}

export interface AdapterRequest {
  url: string;
  isNavigation: boolean;
  resourceType: string;
}

export interface FieldObservation {
  key: string;
  tag: string;
  type: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  /** Present only when the page reported a value; the controller redacts/drops it. */
  value?: string;
}

export interface PageEvents {
  close: () => void;
  crash: () => void;
  /** A JavaScript dialog opened; the adapter dismisses it after notifying. */
  dialog: (info: { type: string; message: string }) => void;
  load: (url: string) => void;
}

export interface AdapterPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, o: { timeoutMs: number }): Promise<{ status: number | null }>;
  reload(o: { timeoutMs: number }): Promise<{ status: number | null }>;
  /** Returns false when there is no history entry in that direction. */
  goBack(o: { timeoutMs: number }): Promise<boolean>;
  goForward(o: { timeoutMs: number }): Promise<boolean>;
  click(s: SelectorSpec, o: { timeoutMs: number }): Promise<void>;
  fill(s: SelectorSpec, value: string, o: { timeoutMs: number }): Promise<void>;
  /** Select by option value, or the last non-empty option when value is undefined. */
  selectOption(s: SelectorSpec, value: string | undefined, o: { timeoutMs: number }): Promise<string>;
  waitFor(s: SelectorSpec, o: { timeoutMs: number }): Promise<void>;
  screenshot(o: { timeoutMs: number }): Promise<Uint8Array>;
  /** Form controls of the page (values as reported; redaction happens in the controller). */
  fields(): Promise<FieldObservation[]>;
  on<E extends keyof PageEvents>(event: E, handler: PageEvents[E]): void;
  close(): Promise<void>;
}

export interface AdapterContext {
  /** Every request is offered to `decide`; "abort" blocks it before it leaves the browser. */
  route(decide: (req: AdapterRequest) => "continue" | "abort"): Promise<void>;
  /** Request lifecycle (for network-idle tracking). */
  onRequest(handler: (phase: "start" | "end", req: AdapterRequest) => void): void;
  newPage(): Promise<AdapterPage>;
  close(): Promise<void>;
}

export interface AdapterBrowser {
  newContext(o: { acceptDownloads: false }): Promise<AdapterContext>;
  isConnected(): boolean;
  onDisconnected(handler: () => void): void;
  version(): string;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  /** e.g. "playwright-chromium". */
  readonly name: string;
  launch(o: AdapterLaunchOptions): Promise<AdapterBrowser>;
}
