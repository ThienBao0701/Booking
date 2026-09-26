/**
 * Environment extraction (Component 8) and session comparison / cross-session
 * correlation inputs. Pure functions over the analyzer model.
 */

import type { EnvironmentReport, SessionComparison, WorkflowLabel } from "../shared.ts";
import { type AEvent, type SessionData, USER_ACTIONS, actionToken, median } from "./model.ts";
import type { Segment, TimingSummary } from "../shared.ts";

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
function size(v: unknown): { width: number; height: number } | undefined {
  const o = obj(v);
  const w = num(o?.width);
  const h = num(o?.height);
  return w !== undefined && h !== undefined ? { width: w, height: h } : undefined;
}

/**
 * Environment as observed by the extension: browser-level facts on
 * `session_start` (metadata.environment) and page-level facts on the first
 * `page_state` (metadata.environment). Nothing is inferred or spoofed.
 */
export function extractEnvironment(data: SessionData, sessionDurationMs: number): EnvironmentReport {
  const report: EnvironmentReport = {
    session_id: data.session.sessionId,
    captured: false,
    session_duration_ms: sessionDurationMs,
    source_event_ids: [],
  };
  const browserEv = data.events.find((e) => e.action === "session_start" && obj(e.metadata.environment));
  const pageEv = data.events.find((e) => e.action === "page_state" && size(obj(e.metadata.environment)?.viewport));
  const set = <K extends keyof EnvironmentReport>(k: K, v: EnvironmentReport[K] | undefined) => {
    if (v !== undefined) report[k] = v;
  };
  if (browserEv) {
    const env = obj(browserEv.metadata.environment) as Record<string, unknown>;
    set("browser", str(env.browser));
    set("browser_major", num(env.browser_major));
    set("platform", str(env.platform));
    set("language", str(env.language));
    set("timezone", str(env.timezone));
    set("timezone_offset_min", num(env.timezone_offset_min));
    set("hardware_concurrency", num(env.hardware_concurrency));
    set("extension_version", str(env.extension_version));
    report.source_event_ids.push(browserEv.event_id);
  }
  if (pageEv) {
    const env = obj(pageEv.metadata.environment) as Record<string, unknown>;
    set("viewport", size(env.viewport));
    set("screen", size(env.screen));
    set("device_pixel_ratio", num(env.device_pixel_ratio));
    set("color_scheme", str(env.color_scheme));
    report.source_event_ids.push(pageEv.event_id);
  }
  report.captured = report.source_event_ids.length > 0;
  return report;
}

const ENV_FIELDS: ReadonlyArray<keyof EnvironmentReport> = [
  "browser",
  "browser_major",
  "platform",
  "language",
  "timezone",
  "timezone_offset_min",
  "viewport",
  "screen",
  "device_pixel_ratio",
  "color_scheme",
  "hardware_concurrency",
  "extension_version",
];

export function environmentDifferences(a: EnvironmentReport, b: EnvironmentReport): Array<{ field: string; a: unknown; b: unknown }> {
  const out: Array<{ field: string; a: unknown; b: unknown }> = [];
  for (const f of ENV_FIELDS) {
    const va = a[f];
    const vb = b[f];
    if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ field: f, a: va ?? null, b: vb ?? null });
  }
  return out;
}

/** Longest common subsequence of two label sequences. */
export function lcs<T>(a: readonly T[], b: readonly T[]): T[] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      row[j] = a[i] === b[j] ? ((dp[i + 1] as number[])[j + 1] as number) + 1 : Math.max((dp[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i] as T);
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) i++;
    else j++;
  }
  return out;
}

export interface ComparableSession {
  data: SessionData;
  segments: Segment[];
  sequence: WorkflowLabel[];
  timing: TimingSummary;
  environment: EnvironmentReport;
}

function gaps(events: readonly AEvent[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < events.length; i++) {
    const d = (events[i] as AEvent).timestamp - (events[i - 1] as AEvent).timestamp;
    if (d >= 0) out.push(d);
  }
  return out;
}

function tokenSet(data: SessionData): Set<string> {
  return new Set(data.events.filter((e) => USER_ACTIONS.has(e.action)).map(actionToken));
}

export function compareSessions(A: ComparableSession, B: ComparableSession): SessionComparison {
  const common = lcs(A.sequence, B.sequence);
  const labels = [...new Set([...A.sequence, ...B.sequence])];
  const workflows = labels.map((w) => {
    const a = A.timing.workflow_duration_ms[w] ?? null;
    const b = B.timing.workflow_duration_ms[w] ?? null;
    return {
      workflow: w,
      a_ms: a,
      b_ms: b,
      delta_ms: a !== null && b !== null ? b - a : null,
      ratio: a !== null && b !== null && a > 0 ? Math.round((b / a) * 100) / 100 : null,
    };
  });
  const ta = tokenSet(A.data);
  const tb = tokenSet(B.data);
  const inter = [...ta].filter((t) => tb.has(t));
  const union = new Set([...ta, ...tb]);
  const jaccard = union.size ? Math.round((inter.length / union.size) * 100) / 100 : 1;
  const seqSim = Math.max(A.sequence.length, B.sequence.length) ? common.length / Math.max(A.sequence.length, B.sequence.length) : 1;
  const errors = (d: SessionData) => d.events.filter((e) => e.severity === "error").length;
  const notes: string[] = [];
  if (!A.environment.captured || !B.environment.captured) {
    notes.push("Environment was not captured for at least one session; environment differences are incomplete.");
  }
  if (A.data.session.target.kind !== B.data.session.target.kind) {
    notes.push(`Sessions were recorded against different target kinds (${A.data.session.target.kind} vs ${B.data.session.target.kind}).`);
  }
  if (Math.min(A.data.events.length, B.data.events.length) < 10) {
    notes.push("At least one session has fewer than 10 events; differences may reflect sample size.");
  }
  return {
    a: A.data.session.sessionId,
    b: B.data.session.sessionId,
    similarity: Math.round((0.6 * seqSim + 0.4 * jaccard) * 100) / 100,
    workflow_sequence: {
      a: A.sequence,
      b: B.sequence,
      common,
      only_a: A.sequence.filter((w) => !B.sequence.includes(w)),
      only_b: B.sequence.filter((w) => !A.sequence.includes(w)),
    },
    workflows,
    counts: { a_events: A.data.events.length, b_events: B.data.events.length, a_errors: errors(A.data), b_errors: errors(B.data) },
    timing: { a_median_gap_ms: median(gaps(A.data.events)), b_median_gap_ms: median(gaps(B.data.events)) },
    actions: {
      jaccard,
      only_a: [...ta].filter((t) => !tb.has(t)).sort().slice(0, 50),
      only_b: [...tb].filter((t) => !ta.has(t)).sort().slice(0, 50),
    },
    environment_differences: environmentDifferences(A.environment, B.environment),
    notes,
  };
}

/** Workflow bigrams ("A→B") present in a sequence. */
export function workflowBigrams(sequence: readonly WorkflowLabel[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i < sequence.length; i++) out.add(`${sequence[i - 1]}→${sequence[i]}`);
  return out;
}

/** Operator action trigrams present in a session. */
export function actionTrigrams(data: SessionData): Set<string> {
  const out = new Set<string>();
  const tokens = data.events.filter((e) => USER_ACTIONS.has(e.action)).map(actionToken);
  for (let i = 2; i < tokens.length; i++) out.add(`${tokens[i - 2]} → ${tokens[i - 1]} → ${tokens[i]}`);
  return out;
}
