/**
 * Capability registry (Component 12 / ADR-0002).
 *
 * This is the enforced boundary between "diagnostics / authorized automation"
 * and "bypass security". Forbidden capabilities are declared here as data and
 * are asserted un-implementable by shared/test/safety.test.ts. There is no
 * runtime switch, env var, or config that can flip a forbidden capability to
 * available — attempting to use one throws ForbiddenCapabilityError.
 */

/** Capabilities the lab legitimately provides. */
export const ALLOWED_CAPABILITIES = [
  "RECORD_OWN_SESSION",
  "OBSERVE_REQUEST_METADATA",
  "REPLAY_ON_MOCK",
  "REPLAY_ON_AUTHORIZED_TARGET",
  "ENVIRONMENT_REPORT",
  "WORKFLOW_ANALYSIS",
  "FORENSIC_REPORT",
] as const;
export type AllowedCapability = (typeof ALLOWED_CAPABILITIES)[number];

/**
 * Capabilities that are FORBIDDEN and intentionally not implemented.
 * (docs/07-safety-modes.md). Do not remove entries from this list; doing so
 * does not add a feature — it only weakens the guard, and CI asserts each of
 * these is never reported available.
 */
export const FORBIDDEN_CAPABILITIES = [
  "ANTI_DETECTION",
  "STEALTH_EVASION",
  "FINGERPRINT_SPOOFING",
  "IP_ROTATION",
  "CAPTCHA_BYPASS",
  "BOT_DETECTION_BYPASS",
  "FAKE_USER_BEHAVIOR",
] as const;
export type ForbiddenCapability = (typeof FORBIDDEN_CAPABILITIES)[number];

export type Capability = AllowedCapability | ForbiddenCapability;

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_CAPABILITIES);
const FORBIDDEN_SET: ReadonlySet<string> = new Set(FORBIDDEN_CAPABILITIES);

export function isAllowedCapability(v: unknown): v is AllowedCapability {
  return typeof v === "string" && ALLOWED_SET.has(v);
}

export function isForbiddenCapability(v: unknown): v is ForbiddenCapability {
  return typeof v === "string" && FORBIDDEN_SET.has(v);
}

/**
 * The single source of truth for whether a capability is available at runtime.
 * Forbidden capabilities are ALWAYS unavailable. Unknown capabilities are
 * unavailable by default (deny-by-default).
 */
export function isCapabilityAvailable(cap: string): boolean {
  if (FORBIDDEN_SET.has(cap)) return false;
  return ALLOWED_SET.has(cap);
}

export class ForbiddenCapabilityError extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(
      `Capability "${capability}" is forbidden by the lab safety policy and is not implemented. ` +
        `See docs/07-safety-modes.md and docs/adr/0002-safety-scope-and-exclusions.md.`,
    );
    this.name = "ForbiddenCapabilityError";
    this.capability = capability;
  }
}

/**
 * Assert a capability may be used. Throws ForbiddenCapabilityError for anything
 * forbidden or unknown. Call this at any policy boundary before acting on a
 * requested capability.
 */
export function assertCapabilityAllowed(cap: string): asserts cap is AllowedCapability {
  if (FORBIDDEN_SET.has(cap)) throw new ForbiddenCapabilityError(cap);
  if (!ALLOWED_SET.has(cap)) throw new ForbiddenCapabilityError(cap);
}
