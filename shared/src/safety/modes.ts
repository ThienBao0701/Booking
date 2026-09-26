/**
 * Safety modes (Component 12 / docs/07-safety-modes.md).
 *
 * Modes are a closed set. Default is OBSERVE. The mode determines whether replay
 * may cause side effects and which targets are permitted.
 */

export const SAFETY_MODES = [
  "OBSERVE",
  "SIMULATE",
  "AUTHORIZED_AUTOMATION",
] as const;

export type SafetyMode = (typeof SAFETY_MODES)[number];

export const DEFAULT_SAFETY_MODE: SafetyMode = "OBSERVE";

export function isSafetyMode(v: unknown): v is SafetyMode {
  return typeof v === "string" && (SAFETY_MODES as readonly string[]).includes(v);
}

/** Whether recording is permitted in a mode (always true — observe is the point). */
export function allowsRecording(_mode: SafetyMode): boolean {
  return true;
}

/** Whether replay may cause side effects (i.e. actually drive a page). */
export function allowsReplaySideEffects(mode: SafetyMode): boolean {
  return mode === "SIMULATE" || mode === "AUTHORIZED_AUTOMATION";
}

/** Whether a mode permits an operator-declared authorized (non-mock) target. */
export function allowsAuthorizedTarget(mode: SafetyMode): boolean {
  return mode === "AUTHORIZED_AUTOMATION";
}
