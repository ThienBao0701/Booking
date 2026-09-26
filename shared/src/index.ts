/**
 * @lab/shared — cross-component contracts + safety/redaction core.
 * Zero runtime dependencies; erasable-syntax only (see ADR-0003).
 */

export * from "./version.ts";
export * from "./ids.ts";
export * from "./time.ts";

// Safety (Component 12) — modes, capabilities, policy/target-guard.
export * from "./safety/modes.ts";
export * from "./safety/capabilities.ts";
export {
  type AuthorizationRecord,
  type ReplayTarget,
  type PolicyDecision,
  evaluateReplay,
  assertReplayAllowed,
  ReplayNotAuthorizedError,
  requireCapability,
  isLoopbackUrl,
} from "./safety/policy.ts";

// Redaction (privacy).
export * from "./redaction/rules.ts";
export {
  redactText,
  redactValue,
  redactFieldValue,
  looksSensitive,
} from "./redaction/redact.ts";

// Contracts.
export * from "./events/types.ts";
export {
  type ValidationResult,
  validateEvent,
  validateEventBatch,
} from "./events/validate.ts";
export * from "./events/recorded.ts";
export * from "./workflow/types.ts";
export { validateSessionRecord } from "./workflow/validate.ts";
export * from "./replay/types.ts";
export { validateWorkflowFile, authorizeRun } from "./replay/validate.ts";
