/** Replay workflow-file validation + target guard. docs/04-replay-format.md. */

import { type WorkflowFile, isStepAction } from "./types.ts";
import type { ValidationResult } from "../events/validate.ts";
import {
  type ReplayTarget,
  type SafetyMode,
  evaluateReplay,
  type PolicyDecision,
} from "../safety/policy.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateTarget(t: unknown, errors: string[]): void {
  if (!isPlainObject(t)) {
    errors.push("target: required object");
    return;
  }
  const kind = t.kind;
  if (kind === "observe") return;
  if (kind === "mock") {
    if (!isNonEmptyString(t.baseUrl)) errors.push("target.baseUrl: required for mock target");
    return;
  }
  if (kind === "authorized") {
    if (!isNonEmptyString(t.baseUrl)) errors.push("target.baseUrl: required for authorized target");
    if (!isPlainObject(t.authorization)) {
      errors.push("target.authorization: required for authorized target");
    }
    return;
  }
  errors.push(`target.kind: must be one of observe|mock|authorized (got ${String(kind)})`);
}

/** Validate the structural shape of a workflow file. */
export function validateWorkflowFile(input: unknown): ValidationResult<WorkflowFile> {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["workflow file must be an object"] };

  if (!isNonEmptyString(input.workflow)) errors.push("workflow: required non-empty string");
  if (typeof input.version !== "number" || !Number.isInteger(input.version)) {
    errors.push("version: required integer");
  }
  validateTarget(input.target, errors);

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push("steps: required non-empty array");
  } else {
    const seen = new Set<string>();
    input.steps.forEach((s, i) => {
      if (!isPlainObject(s)) {
        errors.push(`steps[${i}]: must be an object`);
        return;
      }
      if (!isNonEmptyString(s.id)) errors.push(`steps[${i}].id: required`);
      else if (seen.has(s.id)) errors.push(`steps[${i}].id: duplicate id "${s.id}"`);
      else seen.add(s.id);
      if (!isStepAction(s.action)) errors.push(`steps[${i}].action: invalid action`);
      // navigate/type/click/etc. target/value are action-dependent; light checks:
      if ((s.action === "navigate") && !isNonEmptyString(s.target)) {
        errors.push(`steps[${i}].target: required for navigate`);
      }
      if ((s.action === "type") && s.value !== undefined && typeof s.value !== "string") {
        errors.push(`steps[${i}].value: must be a string when present`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as WorkflowFile };
}

/**
 * Full authorization check for executing a workflow file in a given mode.
 * Combines structural validation with the safety-policy target guard.
 */
export function authorizeRun(
  file: WorkflowFile,
  mode: SafetyMode,
): PolicyDecision {
  return evaluateReplay(mode, file.target as ReplayTarget);
}
