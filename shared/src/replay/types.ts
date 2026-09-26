/** Replay contract types (docs/04-replay-format.md). */

import type { ReplayTarget } from "../safety/policy.ts";

export const STEP_ACTIONS = [
  "navigate",
  "reload",
  "back",
  "forward",
  "click",
  "type",
  "select",
  "waitFor",
  "captureState",
  "captureScreenshot",
  "assert",
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export function isStepAction(v: unknown): v is StepAction {
  return typeof v === "string" && (STEP_ACTIONS as readonly string[]).includes(v);
}

export interface ReplayStep {
  id: string;
  action: StepAction;
  /** Selector or URL/path, depending on action. */
  target?: string;
  /** Test data only — never a captured secret. */
  value?: string;
  timeoutMs?: number;
  retries?: number;
  /** Marks this step as a rollback anchor. */
  checkpoint?: boolean;
}

export interface ReplayDefaults {
  timeoutMs?: number;
  retries?: number;
}

/** A saved workflow file. */
export interface WorkflowFile {
  workflow: string;
  version: number;
  target: ReplayTarget;
  defaults?: ReplayDefaults;
  steps: ReplayStep[];
}

export const RUN_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "rolledBack",
  /** Operator stopped the run before completion (additive, contract v1-compatible). */
  "stopped",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = ["pending", "ok", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface RunStepResult {
  id: string;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  attempts: number;
  error?: string;
}

export interface RunRecord {
  runId: string;
  workflow: string;
  mode: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  steps: RunStepResult[];
  checkpoints: string[];
  /** When derived from a recording, for comparison. */
  sourceSessionId?: string;
  /** True when executed without side effects. */
  dryRun?: boolean;
}
