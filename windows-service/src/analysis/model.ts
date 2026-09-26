/**
 * Analyzer input model. Built from the existing contracts only: stored
 * `LabEvent`s (wire contract) converted to the standardized recorder view
 * (`fromLabEvent`), plus the envelope kind/category that the view derives.
 */

import {
  type EventCategory,
  type EventKind,
  type LabEvent,
  type RecordedAction,
  type SessionRecord,
  type Severity,
  type WorkflowLabel,
  type ElementDescriptor,
  type EvidenceItem,
  fromLabEvent,
  formatClock,
} from "../shared.ts";

export interface AEvent {
  event_id: string;
  session_id: string;
  seq: number;
  timestamp: number;
  tab_id: number | null;
  kind: EventKind;
  category: EventCategory;
  severity: Severity;
  workflow: WorkflowLabel;
  action: RecordedAction;
  page: string;
  target: ElementDescriptor | undefined;
  metadata: Record<string, unknown>;
  /** The service replaced the payload because it still looked sensitive. */
  quarantined: boolean;
}

export interface SessionData {
  session: SessionRecord;
  events: AEvent[];
}

export function toAEvent(e: LabEvent): AEvent {
  const r = fromLabEvent(e);
  return {
    event_id: r.event_id,
    session_id: r.session_id,
    seq: r.seq,
    timestamp: r.timestamp,
    tab_id: r.tab_id ?? null,
    kind: e.kind,
    category: e.category,
    severity: e.severity,
    workflow: r.workflow,
    action: r.action,
    page: r.page,
    target: r.target,
    metadata: r.metadata,
    quarantined: e.data.quarantined === true,
  };
}

export function sessionData(session: SessionRecord, events: readonly LabEvent[]): SessionData {
  return { session, events: events.map(toAEvent).sort((a, b) => a.seq - b.seq) };
}

/** Actions that represent something the operator did (vs. lifecycle / DOM noise). */
export const USER_ACTIONS: ReadonlySet<RecordedAction> = new Set(["navigate", "click", "change", "input", "submit"]);

export function targetText(t: ElementDescriptor | undefined): string {
  if (!t) return "";
  return [t.selector, t.label, t.name, t.role].filter((x): x is string => typeof x === "string").join(" ");
}

/** Stable token for an operator action, e.g. "click:#res-submit". */
export function actionToken(e: AEvent): string {
  return `${e.action}:${e.target?.selector ?? e.page}`;
}

export function summarize(e: AEvent): string {
  const what = e.target?.selector ?? (e.action === "workflow_transition" ? `${String(e.metadata.from ?? "?")} → ${String(e.metadata.to ?? "?")}` : e.page);
  return `${formatClock(e.timestamp)} ${e.kind} ${e.action} ${what} (${e.workflow})${e.quarantined ? " [quarantined]" : ""}`;
}

export function evidenceItem(e: AEvent, role: EvidenceItem["role"]): EvidenceItem {
  return {
    event_id: e.event_id,
    seq: e.seq,
    timestamp: e.timestamp,
    kind: e.kind,
    action: e.action,
    workflow: e.workflow,
    page: e.page,
    summary: summarize(e),
    role,
  };
}

export function stats(values: readonly number[]): { count: number; min: number; p50: number; p90: number; max: number; mean: number } {
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p90: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] as number;
  return {
    count: s.length,
    min: s[0] as number,
    p50: q(0.5),
    p90: q(0.9),
    max: s[s.length - 1] as number,
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Robust z-score (median / MAD). Returns 0 when MAD is 0. */
export function robustZ(x: number, sample: readonly number[]): number {
  const m = median(sample);
  const mad = median(sample.map((v) => Math.abs(v - m)));
  if (mad === 0) return 0;
  return (0.6745 * (x - m)) / mad;
}
