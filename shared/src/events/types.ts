/** Event contract types (docs/02-event-schema.md). */

import type { WorkflowLabel } from "../workflow/types.ts";

export const EVENT_KINDS = [
  "NAVIGATION",
  "TAB_LIFECYCLE",
  "PAGE_STATE",
  "DOM_CHANGE",
  "FORM_ACTIVITY",
  "CLICK",
  "SESSION_CHANGE",
  "SCREENSHOT",
  "HTTP_STATUS",
  "WORKFLOW_TRANSITION",
  "ERROR",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_CATEGORIES = [
  "navigation",
  "tab",
  "page",
  "dom",
  "form",
  "interaction",
  "session",
  "media",
  "network",
  "workflow",
  "error",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const SEVERITIES = ["info", "warn", "error"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Element descriptor — structure only, never values. */
export interface ElementDescriptor {
  role?: string;
  label?: string;
  selector?: string;
  tag?: string;
  name?: string;
}

/** HTTP observability payload — metadata only (docs/02). */
export interface HttpObservation {
  method: string;
  endpointCategory: string;
  urlHost: string;
  status: number;
  requestMs?: number;
  responseMs?: number;
  redirected?: boolean;
  redirectCount?: number;
  retryCount?: number;
  failed?: boolean;
}

/** The event envelope. `data` is kind-specific and already redacted. */
export interface LabEvent {
  id: string;
  sessionId: string;
  seq: number;
  ts: number;
  tabId?: number;
  kind: EventKind;
  category: EventCategory;
  workflow?: WorkflowLabel;
  severity: Severity;
  redacted: boolean;
  data: Record<string, unknown>;
}

export function isEventKind(v: unknown): v is EventKind {
  return typeof v === "string" && (EVENT_KINDS as readonly string[]).includes(v);
}
export function isEventCategory(v: unknown): v is EventCategory {
  return typeof v === "string" && (EVENT_CATEGORIES as readonly string[]).includes(v);
}
export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}
