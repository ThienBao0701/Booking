/**
 * Policy engine (Component 12). Combines safety mode + target + capability into
 * a single, testable decision. This is the boundary the service and replay
 * engine call before doing anything with side effects.
 */

import {
  type SafetyMode,
  allowsReplaySideEffects,
  allowsAuthorizedTarget,
  isSafetyMode,
} from "./modes.ts";
import {
  assertCapabilityAllowed,
  isCapabilityAvailable,
  ForbiddenCapabilityError,
} from "./capabilities.ts";

export {
  assertCapabilityAllowed,
  isCapabilityAvailable,
  ForbiddenCapabilityError,
} from "./capabilities.ts";
export * from "./modes.ts";

/**
 * Operator-supplied authorization record, required for a non-mock target.
 * This is a traceability artifact recorded with every run.
 */
export interface AuthorizationRecord {
  /** Who owns / is responsible for the target (free text, e.g. "me"). */
  owner: string;
  /** The system being automated, e.g. "staging-extranet". */
  system: string;
  /** Who granted authorization, e.g. "self", "team-lead". */
  grantedBy: string;
  /** Free-text note describing the authorization basis. */
  note?: string;
  /** Epoch ms when the operator acknowledged responsibility. */
  acknowledgedAt: number;
}

export type ReplayTarget =
  | { kind: "observe" }
  | { kind: "mock"; baseUrl: string }
  | { kind: "authorized"; baseUrl: string; authorization: AuthorizationRecord };

export interface PolicyDecision {
  allowed: boolean;
  /** Machine-readable reason code when not allowed. */
  code?:
    | "OK"
    | "MODE_FORBIDS_SIDE_EFFECTS"
    | "MODE_FORBIDS_AUTHORIZED_TARGET"
    | "MISSING_AUTHORIZATION"
    | "INVALID_MODE"
    | "UNKNOWN_TARGET";
  /** Human-readable explanation. */
  reason: string;
}

function ok(): PolicyDecision {
  return { allowed: true, code: "OK", reason: "permitted" };
}
function deny(code: NonNullable<PolicyDecision["code"]>, reason: string): PolicyDecision {
  return { allowed: false, code, reason };
}

function validAuthorization(a: AuthorizationRecord | undefined): boolean {
  return (
    !!a &&
    typeof a.owner === "string" &&
    a.owner.length > 0 &&
    typeof a.system === "string" &&
    a.system.length > 0 &&
    typeof a.grantedBy === "string" &&
    a.grantedBy.length > 0 &&
    typeof a.acknowledgedAt === "number" &&
    Number.isFinite(a.acknowledgedAt)
  );
}

/**
 * Decide whether a replay may execute against `target` in `mode`.
 * This is the target guard referenced throughout the docs.
 */
export function evaluateReplay(mode: SafetyMode, target: ReplayTarget): PolicyDecision {
  if (!isSafetyMode(mode)) return deny("INVALID_MODE", `unknown safety mode: ${String(mode)}`);

  if (target.kind === "observe") {
    // Observe-only: never any side effect regardless of mode.
    return deny(
      "MODE_FORBIDS_SIDE_EFFECTS",
      "target.kind=observe performs no replay side effects",
    );
  }

  if (!allowsReplaySideEffects(mode)) {
    return deny(
      "MODE_FORBIDS_SIDE_EFFECTS",
      `mode ${mode} does not permit replay side effects (use SIMULATE or AUTHORIZED_AUTOMATION)`,
    );
  }

  if (target.kind === "mock") {
    return ok();
  }

  if (target.kind === "authorized") {
    if (!allowsAuthorizedTarget(mode)) {
      return deny(
        "MODE_FORBIDS_AUTHORIZED_TARGET",
        `mode ${mode} may only target the mock environment; use AUTHORIZED_AUTOMATION for authorized targets`,
      );
    }
    if (!validAuthorization(target.authorization)) {
      return deny(
        "MISSING_AUTHORIZATION",
        "authorized target requires a valid authorization record (owner, system, grantedBy, acknowledgedAt)",
      );
    }
    return ok();
  }

  return deny("UNKNOWN_TARGET", "unknown replay target kind");
}

/**
 * Convenience guard that throws if a replay is not permitted. Use where a
 * boolean decision is not enough and execution must halt.
 */
export class ReplayNotAuthorizedError extends Error {
  readonly decision: PolicyDecision;
  constructor(decision: PolicyDecision) {
    super(`Replay not authorized: ${decision.reason} (${decision.code})`);
    this.name = "ReplayNotAuthorizedError";
    this.decision = decision;
  }
}

export function assertReplayAllowed(mode: SafetyMode, target: ReplayTarget): void {
  const d = evaluateReplay(mode, target);
  if (!d.allowed) throw new ReplayNotAuthorizedError(d);
}

/** Re-export used by callers that want to gate a capability before acting. */
export function requireCapability(cap: string): void {
  assertCapabilityAllowed(cap);
}
