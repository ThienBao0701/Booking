/** Workflow contract types (docs/03-workflow-schema.md). */

export const WORKFLOW_LABELS = [
  "LOGIN",
  "PROPERTY_SETUP",
  "ROOM_SETUP",
  "RATE_SETUP",
  "RESERVATION",
  "CANCELLATION",
  "MESSAGING",
  "REVIEW",
  "PHOTO",
  "REPORTING",
  "UNKNOWN",
] as const;
export type WorkflowLabel = (typeof WORKFLOW_LABELS)[number];

export function isWorkflowLabel(v: unknown): v is WorkflowLabel {
  return typeof v === "string" && (WORKFLOW_LABELS as readonly string[]).includes(v);
}

export interface TimelineEntry {
  ts: number;
  workflow: WorkflowLabel;
  eventId: string;
}

export interface TabRecord {
  tabId: number;
  openedAt: number;
  closedAt?: number;
}

/** A recording session record (recorder output). */
export interface SessionRecord {
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  mode: string;
  target: { kind: string; host?: string };
  tabs: TabRecord[];
  timeline: TimelineEntry[];
  metadata: Record<string, unknown>;
}

/** A single recorded step (docs/03 per-step record). */
export interface WorkflowStepRecord {
  sessionId: string;
  timestamp: number;
  tabId: number;
  page: string;
  action: string;
  element?: import("../events/types.ts").ElementDescriptor;
  workflow: WorkflowLabel;
  metadata: Record<string, unknown>;
}
