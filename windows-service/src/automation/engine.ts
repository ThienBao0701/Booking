/**
 * Replay engine (Component 5 / Phase 7). Executes a shared-schema WorkflowFile
 * through a BrowserController.
 *
 * Authorization happens BEFORE any controller call (validation → mock-only
 * rule → shared policy target guard). A denied run never launches the
 * controller.
 *
 * Controls:
 *   start()     authorize, launch, run until done / paused / stopped / failed
 *   pause()     halt before the next step (graceful)
 *   resume()    continue a paused / rolled-back run
 *   stop()      abort the in-flight action and end the run (status "stopped")
 *   step()      execute exactly one step, then pause
 *   retry()     re-run the failed step, then continue
 *   checkpoint() / automatic on `checkpoint: true` steps — snapshot of the
 *               controller's page model + run position
 *   rollback()  return to the last checkpoint (page model + position); target-
 *               side effects are NOT undone (use the mock for that)
 *   dryRun()    validate + authorize + plan (params, timeouts); zero side effects
 *
 * Per step: timeout (abort signal + race), retries for transient failures with
 * backoff, `{{param}}` substitution (values are never written to the run
 * record), captureState artifacts.
 */

import {
  type IdEnv,
  type PolicyDecision,
  type ReplayStep,
  type ReplayTarget,
  type RunRecord,
  type RunStepResult,
  type SafetyMode,
  type WorkflowFile,
  ReplayNotAuthorizedError,
  defaultIdEnv,
  evaluateReplay,
  newPrefixedId,
  validateWorkflowFile,
} from "../shared.ts";
import { type BrowserController, type ControllerSnapshot, type PageState, ControllerError } from "./controller.ts";

export type EngineState = "idle" | "running" | "paused" | "completed" | "failed" | "stopped";

export type ReplayEventType =
  | "run.denied"
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.stopped"
  | "run.completed"
  | "run.failed"
  | "run.rolledBack"
  | "step.started"
  | "step.succeeded"
  | "step.retrying"
  | "step.failed"
  | "step.skipped"
  | "step.warning"
  | "checkpoint";

export interface ReplayEvent {
  type: ReplayEventType;
  runId: string;
  at: number;
  stepId?: string;
  detail?: Record<string, unknown>;
}

export interface ReplayOptions {
  mode: SafetyMode;
  controller: BrowserController;
  /** "Mock mode": refuse any target that is not kind "mock". */
  mockOnly?: boolean;
  /** Values for `{{name}}` placeholders (test data; never persisted). */
  params?: Record<string, string>;
  /** Fallback per-step timeout when neither step nor defaults set one (10 s). */
  defaultTimeoutMs?: number;
  /** Delay before retry attempt n is n × retryDelayMs (250 ms). */
  retryDelayMs?: number;
  sourceSessionId?: string;
  idEnv?: IdEnv;
  clock?: () => number;
  onEvent?: (e: ReplayEvent) => void;
  /** Persist the run record after every change (e.g. Store.saveRun). */
  persist?: (run: RunRecord) => void | Promise<void>;
  /**
   * Receive screenshot images taken by `captureScreenshot` steps (Phase 12,
   * e.g. ScreenshotService.storeReplay). A failing sink never fails the step.
   */
  onScreenshot?: (shot: { runId: string; stepId: string; data: Uint8Array; sha256?: string | undefined; mimeType?: string | undefined }) => void | Promise<void>;
}

export interface Checkpoint {
  id: string;
  cursor: number;
  snapshot: ControllerSnapshot | undefined;
}

export interface Artifact {
  stepId: string;
  kind: "state";
  data: PageState;
}

export interface DryRunPlan {
  runId: string;
  workflow: string;
  mode: SafetyMode;
  authorization: PolicyDecision;
  valid: boolean;
  errors: string[];
  requiredParams: string[];
  missingParams: string[];
  /** True only if the run would be allowed to start as-is. */
  wouldExecute: boolean;
  steps: Array<{
    id: string;
    action: ReplayStep["action"];
    target?: string;
    timeoutMs: number;
    retries: number;
    checkpoint: boolean;
    params: string[];
  }>;
}

export class ReplayValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid workflow:\n- ${errors.join("\n- ")}`);
    this.name = "ReplayValidationError";
    this.errors = errors;
  }
}

class ParamError extends Error {}
class StepTimeout extends Error {}
class Stopped extends Error {}

const NEEDS_TARGET = new Set(["navigate", "click", "type", "select", "waitFor", "assert"]);
const NON_RETRYABLE = new Set([
  "NOT_LAUNCHED",
  "NO_TAB",
  "NO_HISTORY",
  "WRONG_ELEMENT",
  "UNRESOLVED_REFERENCE",
  "NAVIGATION_BLOCKED",
  "UNSUPPORTED",
]);
const PARAM_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

function paramsIn(s: string | undefined): string[] {
  return s ? [...s.matchAll(PARAM_RE)].map((m) => m[1] as string) : [];
}

function semanticErrors(file: WorkflowFile): string[] {
  const errors: string[] = [];
  for (const s of file.steps) {
    if (NEEDS_TARGET.has(s.action) && !s.target) errors.push(`step ${s.id}: ${s.action} requires a target`);
    if ((s.action === "type" || s.action === "select") && s.value === undefined) {
      errors.push(`step ${s.id}: ${s.action} requires a value`);
    }
    if (s.timeoutMs !== undefined && !(Number.isInteger(s.timeoutMs) && s.timeoutMs > 0)) {
      errors.push(`step ${s.id}: timeoutMs must be a positive integer`);
    }
    if (s.retries !== undefined && !(Number.isInteger(s.retries) && s.retries >= 0 && s.retries <= 10)) {
      errors.push(`step ${s.id}: retries must be 0..10`);
    }
  }
  return errors;
}

export class ReplayEngine {
  readonly file: WorkflowFile;
  #o: Required<Pick<ReplayOptions, "defaultTimeoutMs" | "retryDelayMs" | "mockOnly">> & ReplayOptions;
  #clock: () => number;
  #state: EngineState = "idle";
  #record: RunRecord;
  #cursor = 0;
  #launched = false;
  #running: Promise<RunRecord> | undefined;
  #pauseRequested = false;
  #stopRequested = false;
  #inflight: AbortController | undefined;
  #checkpoints: Checkpoint[] = [];
  #artifacts: Artifact[] = [];

  constructor(workflow: unknown, opts: ReplayOptions) {
    const v = validateWorkflowFile(workflow);
    if (!v.ok) throw new ReplayValidationError(v.errors);
    const semantic = semanticErrors(v.value);
    if (semantic.length > 0) throw new ReplayValidationError(semantic);
    this.file = v.value;
    this.#o = { defaultTimeoutMs: 10_000, retryDelayMs: 250, mockOnly: false, ...opts };
    this.#clock = opts.clock ?? (() => Date.now());
    this.#record = {
      runId: newPrefixedId("run", opts.idEnv ?? defaultIdEnv),
      workflow: this.file.workflow,
      mode: opts.mode,
      startedAt: this.#clock(),
      status: "pending",
      steps: this.file.steps.map((s) => ({ id: s.id, status: "pending" as const, attempts: 0 })),
      checkpoints: [],
      target: structuredClone(this.file.target as ReplayTarget),
      ...(opts.sourceSessionId !== undefined ? { sourceSessionId: opts.sourceSessionId } : {}),
    };
  }

  get state(): EngineState {
    return this.#state;
  }
  /** Index of the next step to execute. */
  get cursor(): number {
    return this.#cursor;
  }
  get record(): RunRecord {
    return structuredClone(this.#record);
  }
  get checkpoints(): readonly Checkpoint[] {
    return this.#checkpoints;
  }
  get artifacts(): readonly Artifact[] {
    return this.#artifacts;
  }

  // ---- authorization ----

  /** Mock-only rule + shared policy target guard. Pure: never touches the controller. */
  authorize(): PolicyDecision {
    const target = this.file.target as ReplayTarget;
    if (this.#o.mockOnly && target.kind !== "mock") {
      return {
        allowed: false,
        code: "MODE_FORBIDS_AUTHORIZED_TARGET",
        reason: `mock mode: only mock targets may be replayed (got "${target.kind}")`,
      };
    }
    return evaluateReplay(this.#o.mode, target);
  }

  // ---- dry run ----

  async dryRun(): Promise<DryRunPlan> {
    const authorization = this.authorize();
    const d = this.file.defaults ?? {};
    const provided = this.#o.params ?? {};
    const steps = this.file.steps.map((s) => ({
      id: s.id,
      action: s.action,
      ...(s.target !== undefined ? { target: s.target } : {}),
      timeoutMs: s.timeoutMs ?? d.timeoutMs ?? this.#o.defaultTimeoutMs,
      retries: s.retries ?? d.retries ?? 0,
      checkpoint: s.checkpoint === true,
      params: [...new Set([...paramsIn(s.target), ...paramsIn(s.value)])],
    }));
    const requiredParams = [...new Set(steps.flatMap((s) => s.params))].sort();
    const missingParams = requiredParams.filter((p) => provided[p] === undefined);
    this.#record.dryRun = true;
    return {
      runId: this.#record.runId,
      workflow: this.file.workflow,
      mode: this.#o.mode,
      authorization,
      valid: true,
      errors: [],
      requiredParams,
      missingParams,
      wouldExecute: authorization.allowed && missingParams.length === 0,
      steps,
    };
  }

  // ---- lifecycle controls ----

  start(): Promise<RunRecord> {
    if (this.#state !== "idle") return Promise.reject(new Error(`cannot start from state ${this.#state}`));
    return this.#run(false);
  }

  resume(): Promise<RunRecord> {
    if (this.#state !== "paused") return Promise.reject(new Error(`cannot resume from state ${this.#state}`));
    this.#pauseRequested = false;
    this.#emit("run.resumed");
    return this.#run(false);
  }

  async step(): Promise<RunStepResult | undefined> {
    if (this.#state !== "idle" && this.#state !== "paused") throw new Error(`cannot step from state ${this.#state}`);
    const index = this.#cursor;
    await this.#run(true);
    return this.#record.steps[index] ? structuredClone(this.#record.steps[index]) : undefined;
  }

  retry(): Promise<RunRecord> {
    if (this.#state !== "failed") return Promise.reject(new Error(`cannot retry from state ${this.#state}`));
    const r = this.#record.steps[this.#cursor];
    if (r) {
      r.status = "pending";
      delete r.error;
      delete r.endedAt;
    }
    return this.#run(false);
  }

  pause(): void {
    if (this.#state === "running") this.#pauseRequested = true;
  }

  /** Stop the run. A running step is aborted immediately; the run ends "stopped". */
  async stop(): Promise<RunRecord> {
    if (this.#state === "completed" || this.#state === "stopped") return this.record;
    if (this.#running) {
      this.#stopRequested = true;
      this.#inflight?.abort(new Stopped("stopped by operator"));
      return await this.#running;
    }
    await this.#finish("stopped", "run.stopped");
    return this.record;
  }

  /** Record a checkpoint at the current position (not while running). */
  async checkpoint(label?: string): Promise<Checkpoint> {
    if (this.#running) throw new Error("cannot checkpoint while a step is running; pause first");
    return await this.#takeCheckpoint(this.#cursor, label ?? `manual@${this.#cursor}`);
  }

  /**
   * Return to a checkpoint (default: the most recent) — controller page model +
   * run position. Checkpoints taken after it are discarded (that future was
   * undone); the run record keeps the full checkpoint history.
   */
  async rollback(checkpointId?: string): Promise<Checkpoint> {
    if (this.#running) throw new Error("cannot roll back while a step is running; pause first");
    if (this.#state === "completed" || this.#state === "stopped") throw new Error(`cannot roll back a ${this.#state} run`);
    const index =
      checkpointId === undefined
        ? this.#checkpoints.length - 1
        : this.#checkpoints.map((c) => c.id).lastIndexOf(checkpointId);
    const cp = this.#checkpoints[index];
    if (!cp) throw new Error(checkpointId ? `no checkpoint named "${checkpointId}"` : "no checkpoint to roll back to");
    this.#checkpoints = this.#checkpoints.slice(0, index + 1);
    if (cp.snapshot !== undefined && this.#o.controller.restore) await this.#o.controller.restore(cp.snapshot);
    this.#cursor = cp.cursor;
    for (let i = cp.cursor; i < this.#record.steps.length; i++) {
      this.#record.steps[i] = { id: this.file.steps[i]!.id, status: "pending", attempts: 0 };
    }
    this.#record.status = "rolledBack";
    this.#state = "paused";
    this.#emit("run.rolledBack", undefined, { checkpoint: cp.id, cursor: cp.cursor });
    await this.#persist();
    return cp;
  }

  // ---- execution ----

  #run(single: boolean): Promise<RunRecord> {
    if (this.#running) return Promise.reject(new Error("a run is already in progress"));
    this.#running = this.#loop(single).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #loop(single: boolean): Promise<RunRecord> {
    if (!this.#launched) {
      const decision = this.authorize(); // before ANY controller call
      if (!decision.allowed) {
        this.#record.status = "failed";
        this.#record.endedAt = this.#clock();
        this.#state = "failed";
        this.#emit("run.denied", undefined, { code: decision.code, reason: decision.reason });
        await this.#persist();
        throw new ReplayNotAuthorizedError(decision);
      }
      const missing = (await this.dryRun()).missingParams;
      delete this.#record.dryRun;
      if (missing.length > 0) {
        this.#record.status = "failed";
        this.#state = "failed";
        await this.#persist();
        throw new ReplayValidationError(missing.map((p) => `missing parameter: ${p}`));
      }
      const target = this.file.target as { baseUrl: string };
      await this.#o.controller.launch({ baseUrl: target.baseUrl });
      this.#launched = true;
      this.#record.startedAt = this.#clock();
      await this.#takeCheckpoint(0, "start");
      this.#emit("run.started", undefined, { mode: this.#o.mode, target: this.file.target.kind });
    }

    this.#state = "running";
    this.#record.status = "running";
    await this.#persist();

    while (this.#cursor < this.file.steps.length) {
      if (this.#stopRequested) return await this.#finish("stopped", "run.stopped");
      if (this.#pauseRequested) {
        this.#pauseRequested = false;
        return await this.#pauseHere();
      }
      const ok = await this.#execStep(this.#cursor);
      if (this.#stopRequested) return await this.#finish("stopped", "run.stopped");
      if (!ok) {
        this.#state = "failed";
        this.#record.status = "failed";
        this.#emit("run.failed", this.file.steps[this.#cursor]?.id);
        await this.#persist();
        return this.record; // controller stays open for retry() / rollback()
      }
      this.#cursor += 1;
      if (single && this.#cursor < this.file.steps.length) return await this.#pauseHere();
    }
    return await this.#finish("completed", "run.completed");
  }

  async #pauseHere(): Promise<RunRecord> {
    this.#state = "paused";
    this.#record.status = "paused";
    this.#emit("run.paused", undefined, { cursor: this.#cursor });
    await this.#persist();
    return this.record;
  }

  async #finish(status: "completed" | "stopped", event: ReplayEventType): Promise<RunRecord> {
    this.#state = status;
    this.#record.status = status;
    this.#record.endedAt = this.#clock();
    if (status === "stopped") {
      for (const s of this.#record.steps) if (s.status === "pending") s.status = "skipped";
    }
    if (this.#launched) await this.#o.controller.close();
    this.#launched = false;
    this.#emit(event);
    await this.#persist();
    return this.record;
  }

  #resolve(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    return text.replace(PARAM_RE, (_, name: string) => {
      const v = this.#o.params?.[name];
      if (v === undefined) throw new ParamError(`missing parameter: ${name}`);
      return v;
    });
  }

  async #execStep(index: number): Promise<boolean> {
    const step = this.file.steps[index] as ReplayStep;
    const res = this.#record.steps[index] as RunStepResult;
    const d = this.file.defaults ?? {};
    const timeoutMs = step.timeoutMs ?? d.timeoutMs ?? this.#o.defaultTimeoutMs;
    const retries = step.retries ?? d.retries ?? 0;

    res.startedAt = this.#clock();
    this.#emit("step.started", step.id, { action: step.action });

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      res.attempts += 1;
      const ctrl = new AbortController();
      this.#inflight = ctrl;
      const timer = setTimeout(() => ctrl.abort(new StepTimeout(`timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        const outcome = await Promise.race([
          this.#dispatch(step, ctrl.signal, timeoutMs),
          new Promise<never>((_, reject) => {
            ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason), { once: true });
          }),
        ]);
        res.status = outcome === "skipped" ? "skipped" : "ok";
        res.endedAt = this.#clock();
        this.#emit(outcome === "skipped" ? "step.skipped" : "step.succeeded", step.id, { attempts: res.attempts });
        if (step.checkpoint) await this.#takeCheckpoint(index + 1, step.id);
        await this.#persist();
        return true;
      } catch (err) {
        const stopped = this.#stopRequested || err instanceof Stopped;
        const message = stopped ? "stopped by operator" : err instanceof Error ? err.message : String(err);
        const retryable =
          !stopped &&
          !(err instanceof ParamError) &&
          !(err instanceof ControllerError && (NON_RETRYABLE.has(err.code) || (err.code === "TARGET_ERROR" && !err.retryable)));
        if (retryable && attempt <= retries) {
          this.#emit("step.retrying", step.id, { attempt, error: message });
          await new Promise((r) => setTimeout(r, this.#o.retryDelayMs * attempt));
          continue;
        }
        res.status = "failed";
        res.error = message;
        res.endedAt = this.#clock();
        this.#emit("step.failed", step.id, { attempts: res.attempts, error: message });
        await this.#persist();
        return false;
      } finally {
        clearTimeout(timer);
        this.#inflight = undefined;
      }
    }
    return false;
  }

  async #dispatch(step: ReplayStep, signal: AbortSignal, timeoutMs: number): Promise<"ok" | "skipped"> {
    const c = this.#o.controller;
    const opts = { signal, timeoutMs };
    const target = this.#resolve(step.target);
    const value = this.#resolve(step.value);
    switch (step.action) {
      case "navigate":
        await c.navigate(target as string, opts);
        return "ok";
      case "reload":
        await c.reload(opts);
        return "ok";
      case "back":
        await c.back(opts);
        return "ok";
      case "forward":
        await c.forward(opts);
        return "ok";
      case "click":
        await c.click(target as string, opts);
        return "ok";
      case "type":
        await c.type(target as string, value as string, opts);
        return "ok";
      case "select":
        await c.select(target as string, value as string, opts);
        return "ok";
      case "waitFor":
      case "assert":
        await c.waitFor(target as string, opts);
        return "ok";
      case "captureState":
        this.#artifacts.push({ stepId: step.id, kind: "state", data: await c.captureState(opts) });
        return "ok";
      case "captureScreenshot": {
        const shot = await c.captureScreenshot(opts);
        if (shot.supported && shot.data && this.#o.onScreenshot) {
          try {
            await this.#o.onScreenshot({ runId: this.#record.runId, stepId: step.id, data: shot.data, sha256: shot.sha256, mimeType: shot.mimeType });
          } catch (err) {
            this.#emit("step.warning", step.id, { warning: "screenshot not stored", error: err instanceof Error ? err.message : String(err) });
          }
        }
        return shot.supported ? "ok" : "skipped";
      }
    }
  }

  async #takeCheckpoint(cursor: number, id: string): Promise<Checkpoint> {
    const snapshot = this.#launched && this.#o.controller.snapshot ? await this.#o.controller.snapshot() : undefined;
    const cp: Checkpoint = { id, cursor, snapshot };
    this.#checkpoints.push(cp);
    this.#record.checkpoints.push(id);
    this.#emit("checkpoint", undefined, { id, cursor });
    return cp;
  }

  #emit(type: ReplayEventType, stepId?: string, detail?: Record<string, unknown>): void {
    this.#o.onEvent?.({
      type,
      runId: this.#record.runId,
      at: this.#clock(),
      ...(stepId !== undefined ? { stepId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  async #persist(): Promise<void> {
    await this.#o.persist?.(this.record);
  }
}
