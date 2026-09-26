/**
 * Error classification (Phase 11): every adapter failure becomes a
 * ControllerError with a stable code (so the replay engine's retry rules keep
 * working unchanged) plus a finer `category` for logs, runs and reports.
 */

import { type ControllerErrorCode, ControllerError } from "../controller.ts";

export type BrowserErrorCategory =
  | "timeout"
  | "aborted"
  | "element_missing"
  | "element_hidden"
  | "ambiguous_selector"
  | "option_missing"
  | "navigation_blocked"
  | "request_blocked"
  | "network"
  | "browser_closed"
  | "page_crashed"
  | "launch_failed"
  | "unsupported"
  | "unknown";

export class BrowserError extends ControllerError {
  readonly category: BrowserErrorCategory;
  constructor(code: ControllerErrorCode, category: BrowserErrorCategory, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = "BrowserError";
    this.category = category;
  }
}

const RULES: ReadonlyArray<[RegExp, ControllerErrorCode, BrowserErrorCategory, boolean]> = [
  [/Timeout \d+ ?ms exceeded|TimeoutError|timed out/i, "TIMEOUT", "timeout", true],
  [/strict mode violation|resolved to \d+ elements/i, "WRONG_ELEMENT", "ambiguous_selector", false],
  [/did not find some options|no option|option not found/i, "OPTION_NOT_FOUND", "option_missing", true],
  [/is not visible|not visible|outside of the viewport|element is hidden/i, "NOT_VISIBLE", "element_hidden", true],
  [/not attached|detached from the DOM|no element matches|element not found/i, "ELEMENT_NOT_FOUND", "element_missing", true],
  [/net::ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED.*blocked|route\.abort/i, "NAVIGATION_BLOCKED", "request_blocked", false],
  [/Page crashed|Target crashed/i, "TARGET_ERROR", "page_crashed", false],
  [/Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target closed|has been closed/i, "TARGET_ERROR", "browser_closed", false],
  [/net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_CHANGED|EMPTY_RESPONSE)/i, "TARGET_ERROR", "network", true],
  [/Executable doesn't exist|Failed to launch|browserType\.launch/i, "TARGET_ERROR", "launch_failed", false],
  [/not supported|unsupported/i, "UNSUPPORTED", "unsupported", false],
];

/** Map any thrown value to a BrowserError (ControllerErrors keep their code). */
export function classifyError(err: unknown): BrowserError {
  if (err instanceof BrowserError) return err;
  if (err instanceof ControllerError) {
    const category: BrowserErrorCategory =
      err.code === "TIMEOUT" ? "timeout" : err.code === "ABORTED" ? "aborted" : err.code === "NAVIGATION_BLOCKED" ? "navigation_blocked" : "unknown";
    return new BrowserError(err.code, category, err.message, err.retryable);
  }
  const message = err instanceof Error ? `${err.name === "Error" ? "" : `${err.name}: `}${err.message}` : String(err);
  const firstLine = message.split("\n")[0]?.slice(0, 500) ?? "";
  for (const [re, code, category, retryable] of RULES) {
    if (re.test(message)) return new BrowserError(code, category, firstLine, retryable);
  }
  return new BrowserError("TARGET_ERROR", "unknown", firstLine, false);
}
