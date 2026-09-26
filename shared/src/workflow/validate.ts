/** Workflow / session-record validation. docs/03-workflow-schema.md. */

import { type SessionRecord, isWorkflowLabel } from "./types.ts";
import type { ValidationResult } from "../events/validate.ts";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function validateSessionRecord(input: unknown): ValidationResult<SessionRecord> {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["session record must be an object"] };

  if (!isNonEmptyString(input.sessionId)) errors.push("sessionId: required");
  if (!isInt(input.startedAt)) errors.push("startedAt: required integer");
  if (input.endedAt !== undefined && !isInt(input.endedAt)) errors.push("endedAt: integer when present");
  if (!isNonEmptyString(input.mode)) errors.push("mode: required");
  if (!isPlainObject(input.target) || !isNonEmptyString((input.target as Record<string, unknown>).kind)) {
    errors.push("target: required with a kind");
  }
  if (!Array.isArray(input.tabs)) errors.push("tabs: required array");
  if (!Array.isArray(input.timeline)) {
    errors.push("timeline: required array");
  } else {
    input.timeline.forEach((t, i) => {
      if (!isPlainObject(t)) {
        errors.push(`timeline[${i}]: must be an object`);
        return;
      }
      if (!isInt(t.ts)) errors.push(`timeline[${i}].ts: required integer`);
      if (!isWorkflowLabel(t.workflow)) errors.push(`timeline[${i}].workflow: invalid label`);
      if (!isNonEmptyString(t.eventId)) errors.push(`timeline[${i}].eventId: required`);
    });
  }
  if (!isPlainObject(input.metadata)) errors.push("metadata: required object");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as SessionRecord };
}
