/** Real-browser automation (Phase 11): policy → adapter → session → controller. */
export * from "./adapter.ts";
export { BrowserError, classifyError, type BrowserErrorCategory } from "./errors.ts";
export { BrowserTargetPolicy, normalizeOrigin, originOf, type BrowserPolicyCode, type BrowserPolicyDecision, type BrowserPolicyInput, type BrowserPolicyResult } from "./target-policy.ts";
export { BrowserSession, type BlockedRequest, type SessionLaunchOptions, type SessionLogEntry } from "./session.ts";
export { BrowserAdapterController, resolveSelector, type BrowserControllerOptions } from "./controller.ts";
export { PlaywrightAdapter, type PlaywrightAdapterOptions } from "./playwright-adapter.ts";
