/** Event validation (dependency-free). docs/02-event-schema.md. */

import {
  type LabEvent,
  isEventKind,
  isEventCategory,
  isSeverity,
} from "./types.ts";
import { isWorkflowLabel } from "../workflow/types.ts";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * Validate an inbound event. Enforces the redaction invariant: an event with
 * `redacted !== true` is rejected (the service must not persist un-redacted data).
 */
export function validateEvent(input: unknown): ValidationResult<LabEvent> {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["event must be an object"] };

  if (!isNonEmptyString(input.id)) errors.push("id: required non-empty string");
  if (!isNonEmptyString(input.sessionId)) errors.push("sessionId: required non-empty string");
  if (!isInt(input.seq) || (input.seq as number) < 0) errors.push("seq: required non-negative integer");
  if (!isInt(input.ts) || (input.ts as number) < 0) errors.push("ts: required non-negative integer");
  if (input.tabId !== undefined && !isInt(input.tabId)) errors.push("tabId: must be an integer when present");
  if (!isEventKind(input.kind)) errors.push("kind: invalid event kind");
  if (!isEventCategory(input.category)) errors.push("category: invalid category");
  if (input.workflow !== undefined && !isWorkflowLabel(input.workflow)) {
    errors.push("workflow: invalid workflow label");
  }
  if (!isSeverity(input.severity)) errors.push("severity: invalid severity");
  if (input.redacted !== true) errors.push("redacted: must be true before persistence (privacy invariant)");
  if (!isPlainObject(input.data)) errors.push("data: required object");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as LabEvent };
}

/** Batch validation helper — returns valid events and per-index errors. */
export function validateEventBatch(inputs: unknown): {
  valid: LabEvent[];
  invalid: Array<{ index: number; errors: string[] }>;
} {
  const valid: LabEvent[] = [];
  const invalid: Array<{ index: number; errors: string[] }> = [];
  if (!Array.isArray(inputs)) return { valid, invalid: [{ index: -1, errors: ["batch must be an array"] }] };
  inputs.forEach((item, index) => {
    const r = validateEvent(item);
    if (r.ok) valid.push(r.value);
    else invalid.push({ index, errors: r.errors });
  });
  return { valid, invalid };
}
