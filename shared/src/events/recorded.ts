/**
 * Normalized recorder event view (docs/02-event-schema.md §"Recorder view").
 *
 * The recorder (extension) works with `RecordedEvent`, whose field names are the
 * standardized recorder schema:
 *   event_id, session_id, timestamp, tab_id, page, workflow, action, target, metadata
 * (+ `seq` for deterministic ordering, + optional `severity`).
 *
 * The wire/persisted contract remains `LabEvent` (unchanged). `toLabEvent`
 * and `fromLabEvent` convert losslessly between the two, so the service's
 * existing validator and store accept recorder output as-is.
 *
 * `toLabEvent` ALWAYS runs redaction over page/target/metadata before setting
 * `redacted: true`, so the privacy invariant holds by construction.
 */

import {
  type ElementDescriptor,
  type EventCategory,
  type EventKind,
  type LabEvent,
  type Severity,
  isSeverity,
} from "./types.ts";
import { type WorkflowLabel, isWorkflowLabel } from "../workflow/types.ts";
import { type ValidationResult, validateEvent } from "./validate.ts";
import { redactText, redactValue } from "../redaction/redact.ts";

export const RECORDED_ACTIONS = [
  "session_start",
  "session_end",
  "tab_created",
  "tab_activated",
  "tab_updated",
  "tab_closed",
  "navigate",
  "page_load",
  "page_state",
  "dom_change",
  "click",
  "input",
  "change",
  "submit",
  "screenshot",
  "http",
  "workflow_transition",
  "error",
] as const;
export type RecordedAction = (typeof RECORDED_ACTIONS)[number];

export function isRecordedAction(v: unknown): v is RecordedAction {
  return typeof v === "string" && (RECORDED_ACTIONS as readonly string[]).includes(v);
}

const ACTION_KIND: Record<RecordedAction, EventKind> = {
  session_start: "SESSION_CHANGE",
  session_end: "SESSION_CHANGE",
  tab_created: "TAB_LIFECYCLE",
  tab_activated: "TAB_LIFECYCLE",
  tab_updated: "TAB_LIFECYCLE",
  tab_closed: "TAB_LIFECYCLE",
  navigate: "NAVIGATION",
  page_load: "PAGE_STATE",
  page_state: "PAGE_STATE",
  dom_change: "DOM_CHANGE",
  click: "CLICK",
  input: "FORM_ACTIVITY",
  change: "FORM_ACTIVITY",
  submit: "FORM_ACTIVITY",
  screenshot: "SCREENSHOT",
  http: "HTTP_STATUS",
  workflow_transition: "WORKFLOW_TRANSITION",
  error: "ERROR",
};

const KIND_CATEGORY: Record<EventKind, EventCategory> = {
  NAVIGATION: "navigation",
  TAB_LIFECYCLE: "tab",
  PAGE_STATE: "page",
  DOM_CHANGE: "dom",
  FORM_ACTIVITY: "form",
  CLICK: "interaction",
  SESSION_CHANGE: "session",
  SCREENSHOT: "media",
  HTTP_STATUS: "network",
  WORKFLOW_TRANSITION: "workflow",
  ERROR: "error",
};

/** Default action used when converting a LabEvent that carries no recorder action. */
const KIND_DEFAULT_ACTION: Record<EventKind, RecordedAction> = {
  NAVIGATION: "navigate",
  TAB_LIFECYCLE: "tab_updated",
  PAGE_STATE: "page_state",
  DOM_CHANGE: "dom_change",
  FORM_ACTIVITY: "change",
  CLICK: "click",
  SESSION_CHANGE: "session_start",
  SCREENSHOT: "screenshot",
  HTTP_STATUS: "http",
  WORKFLOW_TRANSITION: "workflow_transition",
  ERROR: "error",
};

export function kindForAction(action: RecordedAction): EventKind {
  return ACTION_KIND[action];
}

export function categoryForKind(kind: EventKind): EventCategory {
  return KIND_CATEGORY[kind];
}

/** The standardized recorder event. */
export interface RecordedEvent {
  event_id: string;
  session_id: string;
  /** Monotonic per-session ordering key (docs/02 ordering invariant). */
  seq: number;
  /** Epoch milliseconds (UTC). */
  timestamp: number;
  tab_id?: number;
  /** Logical page / route label (path only — never query string or fragment). */
  page: string;
  workflow: WorkflowLabel;
  action: RecordedAction;
  /** Structural element descriptor — never a value. */
  target?: ElementDescriptor;
  metadata: Record<string, unknown>;
  severity?: Severity;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a RecordedEvent's shape (does not require redaction; toLabEvent enforces it). */
export function validateRecordedEvent(input: unknown): ValidationResult<RecordedEvent> {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["recorded event must be an object"] };
  if (typeof input.event_id !== "string" || input.event_id.length === 0) errors.push("event_id: required");
  if (typeof input.session_id !== "string" || input.session_id.length === 0) errors.push("session_id: required");
  if (typeof input.seq !== "number" || !Number.isInteger(input.seq) || input.seq < 0) {
    errors.push("seq: required non-negative integer");
  }
  if (typeof input.timestamp !== "number" || !Number.isInteger(input.timestamp) || input.timestamp < 0) {
    errors.push("timestamp: required non-negative integer");
  }
  if (input.tab_id !== undefined && (typeof input.tab_id !== "number" || !Number.isInteger(input.tab_id))) {
    errors.push("tab_id: integer when present");
  }
  if (typeof input.page !== "string") errors.push("page: required string");
  if (!isWorkflowLabel(input.workflow)) errors.push("workflow: invalid label");
  if (!isRecordedAction(input.action)) errors.push("action: invalid recorder action");
  if (input.target !== undefined && !isPlainObject(input.target)) errors.push("target: object when present");
  if (!isPlainObject(input.metadata)) errors.push("metadata: required object");
  if (input.severity !== undefined && !isSeverity(input.severity)) errors.push("severity: invalid");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as RecordedEvent };
}

/**
 * Convert to the wire/persisted LabEvent. Redaction is applied here
 * unconditionally, so the returned event satisfies the privacy invariant.
 */
export function toLabEvent(r: RecordedEvent): LabEvent {
  const kind = kindForAction(r.action);
  const data: Record<string, unknown> = {
    page: redactText(r.page),
    action: r.action,
    metadata: redactValue(r.metadata),
  };
  if (r.target !== undefined) data.target = redactValue(r.target);
  const severity: Severity = r.severity ?? (kind === "ERROR" ? "error" : "info");
  return {
    id: r.event_id,
    sessionId: r.session_id,
    seq: r.seq,
    ts: r.timestamp,
    ...(r.tab_id !== undefined ? { tabId: r.tab_id } : {}),
    kind,
    category: categoryForKind(kind),
    workflow: r.workflow,
    severity,
    redacted: true,
    data,
  };
}

/** Convert a LabEvent back to the recorder view (for dashboards/analysis). */
export function fromLabEvent(e: LabEvent): RecordedEvent {
  const d = e.data;
  const action = isRecordedAction(d.action) ? d.action : KIND_DEFAULT_ACTION[e.kind];
  const target = isPlainObject(d.target) ? (d.target as ElementDescriptor) : undefined;
  return {
    event_id: e.id,
    session_id: e.sessionId,
    seq: e.seq,
    timestamp: e.ts,
    ...(e.tabId !== undefined ? { tab_id: e.tabId } : {}),
    page: typeof d.page === "string" ? d.page : "",
    workflow: e.workflow ?? "UNKNOWN",
    action,
    ...(target !== undefined ? { target } : {}),
    metadata: isPlainObject(d.metadata) ? (d.metadata as Record<string, unknown>) : {},
    severity: e.severity,
  };
}

/** Convert + validate against the wire contract in one step. */
export function toValidLabEvent(r: RecordedEvent): ValidationResult<LabEvent> {
  const shape = validateRecordedEvent(r);
  if (!shape.ok) return shape;
  return validateEvent(toLabEvent(r));
}
