/**
 * BrowserController (Component 3 / Phase 6): the automation abstraction the
 * replay engine drives. The interface is deliberately separate from any
 * implementation so the same workflows can run on:
 *
 *   - MockExtranetController (this repo): drives the mock Extranet's page model
 *     over HTTP — deterministic, no browser needed, the default authorized target;
 *   - future adapters: Chrome/Edge/Chromium via CDP, Playwright, Puppeteer.
 *
 * Contract rules every implementation must honour:
 *   - `launch()` binds the controller to ONE origin; navigation to any other
 *     origin fails with NAVIGATION_BLOCKED (replay can never wander off the
 *     authorized target);
 *   - actions respect `opts.signal` (abort) and `opts.timeoutMs`;
 *   - failures throw ControllerError with a stable `code`.
 *
 * Nothing here spoofs, hides or disguises automation: a controller acts as an
 * ordinary, identifiable client of a system it is authorized to drive.
 */

export interface LaunchOptions {
  /** Origin (+ optional path) the controller is bound to. */
  baseUrl: string;
}

export interface ActionOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface PageMetadata {
  url: string;
  title: string;
  tabId: string;
  app?: string;
  view?: string;
  status?: number;
}

export interface PageState {
  url: string;
  tabId: string;
  view?: string;
  /** Test data currently entered in the page (redacted). */
  fields: Record<string, string>;
  /** Most recently created entity id per kind (for `$last` references). */
  entities: Record<string, string>;
  /** Target-side observations (e.g. entity counts). */
  server: Record<string, number>;
  capturedAt: number;
}

export interface ScreenshotResult {
  supported: boolean;
  mimeType?: string;
  data?: Uint8Array;
  sha256?: string;
  reason?: string;
}

/** Opaque, JSON-serializable controller snapshot used for replay checkpoints. */
export type ControllerSnapshot = Record<string, unknown>;

export interface BrowserController {
  readonly name: string;
  launch(opts: LaunchOptions): Promise<void>;
  openTab(url?: string, opts?: ActionOptions): Promise<string>;
  closeTab(tabId?: string): Promise<void>;
  navigate(url: string, opts?: ActionOptions): Promise<void>;
  reload(opts?: ActionOptions): Promise<void>;
  back(opts?: ActionOptions): Promise<void>;
  forward(opts?: ActionOptions): Promise<void>;
  click(selector: string, opts?: ActionOptions): Promise<void>;
  type(selector: string, value: string, opts?: ActionOptions): Promise<void>;
  select(selector: string, value: string, opts?: ActionOptions): Promise<void>;
  waitFor(selector: string, opts?: ActionOptions): Promise<void>;
  captureState(opts?: ActionOptions): Promise<PageState>;
  captureScreenshot(opts?: ActionOptions): Promise<ScreenshotResult>;
  getCurrentUrl(): string;
  getPageMetadata(opts?: ActionOptions): Promise<PageMetadata>;
  /** Optional checkpoint support (page model only — never target-side data). */
  snapshot?(): Promise<ControllerSnapshot>;
  restore?(snapshot: ControllerSnapshot): Promise<void>;
  close(): Promise<void>;
}

export type ControllerErrorCode =
  | "NOT_LAUNCHED"
  | "NO_TAB"
  | "NO_HISTORY"
  | "ELEMENT_NOT_FOUND"
  | "NOT_VISIBLE"
  | "WRONG_ELEMENT"
  | "OPTION_NOT_FOUND"
  | "UNRESOLVED_REFERENCE"
  | "NAVIGATION_BLOCKED"
  | "TARGET_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "UNSUPPORTED";

export class ControllerError extends Error {
  readonly code: ControllerErrorCode;
  /** Whether retrying the same action could succeed (transient condition). */
  readonly retryable: boolean;
  constructor(code: ControllerErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ControllerError";
    this.code = code;
    this.retryable = retryable;
  }
}
