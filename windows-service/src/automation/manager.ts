/**
 * ReplayManager (Phase 13): controlled replays started from the dashboard.
 *
 *  1. prepare() validates the workflow, authorizes it (the engine's policy and,
 *     for the browser controller, the explicit origin allowlist) and returns a
 *     dry-run plan with target, authorization, workflow, step count and a risk
 *     notice, plus a single-use confirmation token (10 min).
 *  2. start() executes only with that token AND an explicit acknowledgement —
 *     an operator action bound to exactly the plan that was shown.
 *
 * The service's configured safety mode is the ceiling for these runs
 * (OBSERVE < SIMULATE < AUTHORIZED_AUTOMATION): in OBSERVE the dashboard can
 * plan, never execute. One run executes at a time. Parameter values stay in
 * memory for the run only; they are never persisted or logged.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  type ReplayControllerKind,
  type ReplayLogEntry,
  type ReplayPlanView,
  type ReplayRunListItem,
  type ReplayRunStatus,
  type ReplayTarget,
  type RunRecord,
  type SafetyMode,
  isSafetyMode,
  redactText,
} from "../shared.ts";
import type { BrowserController } from "./controller.ts";
import { type EngineState, ReplayEngine, ReplayValidationError } from "./engine.ts";
import { BrowserTargetPolicy } from "./browser/target-policy.ts";

const MODE_RANK: Record<SafetyMode, number> = { OBSERVE: 0, SIMULATE: 1, AUTHORIZED_AUTOMATION: 2 };
const CONFIRM_TTL_MS = 10 * 60_000;
const KEEP_FINISHED_MS = 60 * 60_000;
const MAX_LOG = 1000;
const MAX_MANAGED = 50;
const TERMINAL: ReadonlySet<EngineState> = new Set(["completed", "stopped"]);

export class ReplayManagerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ControllerKind = ReplayControllerKind;

export interface ControllerFactoryInput {
  kind: ControllerKind;
  policy?: BrowserTargetPolicy | undefined;
}
export type ControllerFactory = (i: ControllerFactoryInput) => BrowserController;

export interface PrepareInput {
  workflow: unknown;
  /** Where the workflow came from (display only). */
  source: string;
  mode: SafetyMode;
  controller: ControllerKind;
  allowOrigins?: readonly string[];
  resourceOrigins?: readonly string[];
  params?: Record<string, string>;
  sourceSessionId?: string | undefined;
}

export type LogEntry = ReplayLogEntry;
export type RunPlanView = ReplayPlanView;
export type RunStatusView = ReplayRunStatus;

interface Managed {
  engine: ReplayEngine;
  plan: RunPlanView;
  confirmToken: string | null;
  confirmExpires: number;
  started: boolean;
  busy: Promise<unknown> | null;
  logs: LogEntry[];
  logSeq: number;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ReplayManagerOptions {
  /** The service's configured safety mode: the ceiling for managed runs. */
  serviceMode: () => SafetyMode;
  controllerFactory: ControllerFactory;
  persist?: (run: RunRecord) => void;
  onScreenshot?: (s: { runId: string; stepId: string; data: Uint8Array; workflow: string }) => void;
  now?: () => number;
}

function riskNotice(target: ReplayTarget, controller: ControllerKind, origins: string[]): string[] {
  const out: string[] = [];
  if (target.kind === "mock") out.push("This run creates and changes test data in the local mock Extranet only.");
  if (target.kind === "authorized") {
    const a = target.authorization;
    out.push(
      `This run performs REAL actions on ${target.baseUrl} (${a.system}, owner ${a.owner}, authorized by ${a.grantedBy}). Only continue if you are allowed to change data there.`,
    );
  }
  out.push("Rollback returns the replay to a checkpoint (page and position) only; changes already made on the target are not undone.");
  if (controller === "browser") out.push(`A real browser (Chromium) runs on this machine, confined to: ${origins.join(", ") || "no origins"}.`);
  out.push("Parameter values are used for this run only and are never stored or logged.");
  return out;
}

export class ReplayManager {
  #o: ReplayManagerOptions;
  #runs = new Map<string, Managed>();
  #now: () => number;

  constructor(opts: ReplayManagerOptions) {
    this.#o = opts;
    this.#now = opts.now ?? Date.now;
  }

  #get(id: string): Managed {
    const m = this.#runs.get(id);
    if (!m) throw new ReplayManagerError(404, "run_not_found");
    return m;
  }

  #log(m: Managed, type: LogEntry["type"], message: string, stepId?: string): void {
    m.logs.push({ seq: ++m.logSeq, at: this.#now(), type, ...(stepId ? { stepId } : {}), message: redactText(message).slice(0, 500) });
    if (m.logs.length > MAX_LOG) m.logs.shift();
  }

  #evict(): void {
    const now = this.#now();
    for (const m of this.#runs.values()) {
      // A failed run left alone keeps its controller (maybe a browser) open: stop it after a while.
      const idleSince = m.logs.at(-1)?.at ?? m.createdAt;
      if (m.started && m.engine.state === "failed" && !m.busy && now - idleSince > KEEP_FINISHED_MS) {
        void m.engine.stop().then(() => (m.finishedAt ??= this.#now()));
      }
    }
    for (const [id, m] of this.#runs) {
      const finished = m.finishedAt !== null && now - m.finishedAt > KEEP_FINISHED_MS;
      const abandoned = !m.started && now > m.confirmExpires + KEEP_FINISHED_MS;
      if (finished || abandoned) this.#runs.delete(id);
    }
  }

  /** The run that is executing or paused (at most one). */
  #active(): Managed | undefined {
    return [...this.#runs.values()].find((m) => m.started && !TERMINAL.has(m.engine.state) && m.finishedAt === null);
  }

  async prepare(input: PrepareInput): Promise<{ plan: RunPlanView; confirmToken: string | null; expiresAt: number }> {
    this.#evict();
    if (this.#runs.size >= MAX_MANAGED) throw new ReplayManagerError(429, "too_many_runs", "too many prepared runs; discard some first");
    if (!isSafetyMode(input.mode)) throw new ReplayManagerError(400, "invalid_mode");
    const serviceMode = this.#o.serviceMode();
    const target = (input.workflow as { target?: ReplayTarget } | null)?.target;

    // Browser runs: the explicit allowlist policy (decided before any browser exists).
    let browserPolicy: RunPlanView["authorization"]["browser"] = null;
    let policy: BrowserTargetPolicy | undefined;
    if (input.controller === "browser") {
      const r = BrowserTargetPolicy.create({ mode: input.mode, target: target as ReplayTarget, allowlist: input.allowOrigins ?? [], resourceOrigins: input.resourceOrigins ?? [] });
      if (r.ok) {
        policy = r.policy;
        const d = r.policy.describe();
        browserPolicy = { allowed: true, code: "OK", reason: "allowlisted", origins: d.navigationOrigins, resourceOrigins: d.resourceOrigins };
      } else browserPolicy = { allowed: false, code: r.code, reason: r.reason, origins: [...(input.allowOrigins ?? [])], resourceOrigins: [...(input.resourceOrigins ?? [])] };
    } else if (input.controller !== "mock") throw new ReplayManagerError(400, "invalid_controller");

    const controller = this.#o.controllerFactory({ kind: input.controller, policy });
    let engine: ReplayEngine;
    const holder: { m?: Managed } = {};
    try {
      engine = new ReplayEngine(input.workflow, {
        mode: input.mode,
        controller,
        mockOnly: input.controller === "mock",
        params: { ...(input.params ?? {}) },
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        ...(this.#o.persist ? { persist: (r: RunRecord) => this.#o.persist?.(r) } : {}),
        onEvent: (e) => {
          const m = holder.m;
          if (!m) return;
          const detail = e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ") : "";
          this.#log(m, e.type, `${e.type}${e.stepId ? ` ${e.stepId}` : ""}${detail ? ` — ${detail}` : ""}`, e.stepId);
          if (e.type === "run.completed" || e.type === "run.stopped") m.finishedAt = this.#now();
        },
        ...(this.#o.onScreenshot ? { onScreenshot: (s: { runId: string; stepId: string; data: Uint8Array }) => this.#o.onScreenshot?.({ ...s, workflow: engine.file.workflow }) } : {}),
      });
    } catch (err) {
      if (err instanceof ReplayValidationError) throw new ReplayManagerError(400, "invalid_workflow", err.message, err.errors);
      throw err;
    }
    const dry = await engine.dryRun();
    const blockers: string[] = [];
    if (MODE_RANK[input.mode] > MODE_RANK[serviceMode]) {
      blockers.push(`The service runs in ${serviceMode} mode; ${input.mode} runs cannot be started from the dashboard (restart the service with LAB_SAFETY_MODE=${input.mode} to allow them).`);
    }
    if (!dry.authorization.allowed) blockers.push(`Not authorized: ${dry.authorization.reason} (${dry.authorization.code})`);
    if (browserPolicy && !browserPolicy.allowed) blockers.push(`Browser allowlist: ${browserPolicy.reason} (${browserPolicy.code})`);
    if (dry.missingParams.length) blockers.push(`Missing parameters: ${dry.missingParams.join(", ")}`);
    const t = engine.file.target as ReplayTarget;
    const plan: RunPlanView = {
      runId: dry.runId,
      source: input.source,
      workflow: engine.file.workflow,
      version: engine.file.version,
      mode: input.mode,
      serviceMode,
      controller: input.controller,
      target: { kind: t.kind, baseUrl: t.kind === "observe" ? null : t.baseUrl },
      authorization: {
        allowed: dry.authorization.allowed,
        code: dry.authorization.code ?? (dry.authorization.allowed ? "OK" : "DENIED"),
        reason: dry.authorization.reason,
        record: t.kind === "authorized" ? t.authorization : null,
        browser: browserPolicy,
      },
      stepCount: dry.steps.length,
      steps: dry.steps,
      requiredParams: dry.requiredParams,
      missingParams: dry.missingParams,
      wouldExecute: blockers.length === 0 && dry.wouldExecute,
      blockers,
      riskNotice: riskNotice(t, input.controller, browserPolicy?.origins ?? []),
    };
    const confirmToken = plan.wouldExecute ? randomBytes(24).toString("base64url") : null;
    const m: Managed = {
      engine,
      plan,
      confirmToken,
      confirmExpires: this.#now() + CONFIRM_TTL_MS,
      started: false,
      busy: null,
      logs: [],
      logSeq: 0,
      lastError: null,
      createdAt: this.#now(),
      startedAt: null,
      finishedAt: null,
    };
    holder.m = m;
    this.#log(m, "manager", `prepared ${plan.workflow} (${plan.stepCount} steps, ${plan.controller}, ${plan.mode}) — ${plan.wouldExecute ? "ready to start" : `blocked: ${blockers.join("; ")}`}`);
    this.#runs.set(plan.runId, m);
    return { plan, confirmToken, expiresAt: m.confirmExpires };
  }

  /** Execute a prepared run: requires its confirmation token and an explicit acknowledgement. */
  start(runId: string, confirm: { confirmToken?: unknown; acknowledge?: unknown }): RunStatusView {
    const m = this.#get(runId);
    if (m.started) throw new ReplayManagerError(409, "already_started");
    if (confirm.acknowledge !== true) throw new ReplayManagerError(400, "acknowledgement_required", "the operator must acknowledge the target, authorization and risk notice");
    const token = typeof confirm.confirmToken === "string" ? confirm.confirmToken : "";
    const expected = m.confirmToken ?? "";
    const matches = expected.length > 0 && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!matches) throw new ReplayManagerError(403, "invalid_confirmation", "the confirmation does not match this plan (prepare again)");
    if (this.#now() > m.confirmExpires) throw new ReplayManagerError(410, "confirmation_expired", "the plan expired; prepare again");
    const serviceMode = this.#o.serviceMode();
    if (MODE_RANK[m.plan.mode] > MODE_RANK[serviceMode]) throw new ReplayManagerError(403, "mode_ceiling", `service safety mode is ${serviceMode}`);
    if (this.#active()) throw new ReplayManagerError(409, "another_run_active", "another replay is running or paused; stop it first");
    m.confirmToken = null; // single use
    m.started = true;
    m.startedAt = this.#now();
    this.#log(m, "manager", "started by operator (acknowledged plan)");
    this.#background(m, () => m.engine.start());
    return this.status(runId);
  }

  #background(m: Managed, fn: () => Promise<unknown>): void {
    const p = fn()
      .then(() => {
        m.lastError = null;
      })
      .catch((err: unknown) => {
        m.lastError = err instanceof Error ? redactText(err.message).slice(0, 500) : String(err);
        this.#log(m, "manager", `error: ${m.lastError}`);
      })
      .finally(() => {
        if (m.busy === p) m.busy = null;
        if (TERMINAL.has(m.engine.state) && m.finishedAt === null) m.finishedAt = this.#now();
      });
    m.busy = p;
  }

  #requireStarted(m: Managed): void {
    if (!m.started) throw new ReplayManagerError(409, "not_started", "start the run first");
  }

  control(runId: string, action: "pause" | "resume" | "stop" | "step" | "retry" | "checkpoint" | "rollback", arg: { label?: unknown; checkpointId?: unknown } = {}): RunStatusView | Promise<RunStatusView> {
    const m = this.#get(runId);
    this.#requireStarted(m);
    const e = m.engine;
    const guard = (allowed: EngineState[]) => {
      if (!allowed.includes(e.state) || (m.busy && action !== "pause" && action !== "stop")) {
        throw new ReplayManagerError(409, "invalid_state", `cannot ${action} while ${m.busy ? "a step is running" : e.state}`);
      }
    };
    switch (action) {
      case "pause":
        guard(["running"]);
        e.pause();
        this.#log(m, "manager", "pause requested (after the current step)");
        break;
      case "resume":
        guard(["paused"]);
        this.#background(m, () => e.resume());
        break;
      case "step":
        guard(["paused"]);
        this.#background(m, () => e.step());
        break;
      case "retry":
        guard(["failed"]);
        this.#background(m, () => e.retry());
        break;
      case "stop":
        if (TERMINAL.has(e.state)) throw new ReplayManagerError(409, "invalid_state", `run already ${e.state}`);
        this.#log(m, "manager", "stop requested by operator");
        return e.stop().then(() => {
          m.finishedAt ??= this.#now();
          return this.status(runId);
        });
      case "checkpoint": {
        guard(["paused", "failed"]);
        const label = typeof arg.label === "string" && arg.label.length <= 60 ? arg.label : undefined;
        return e.checkpoint(label).then(() => this.status(runId));
      }
      case "rollback": {
        guard(["paused", "failed"]);
        const id = typeof arg.checkpointId === "string" ? arg.checkpointId : undefined;
        return e
          .rollback(id)
          .then(() => this.status(runId))
          .catch((err: unknown) => {
            throw new ReplayManagerError(409, "rollback_failed", err instanceof Error ? err.message : String(err));
          });
      }
    }
    return this.status(runId);
  }

  /** Discard a prepared (never started) run. */
  discard(runId: string): void {
    const m = this.#get(runId);
    if (m.started) throw new ReplayManagerError(409, "already_started", "stop the run instead");
    this.#runs.delete(runId);
  }

  status(runId: string, sinceLog = 0): RunStatusView {
    const m = this.#get(runId);
    const e = m.engine;
    const record = e.record;
    const done = record.steps.filter((s) => s.status === "ok" || s.status === "skipped").length;
    const phase: RunStatusView["phase"] = !m.started ? "prepared" : e.state === "idle" ? "running" : (e.state as RunStatusView["phase"]);
    return {
      runId,
      phase,
      state: e.state,
      cursor: e.cursor,
      progress: { done, total: record.steps.length },
      plan: m.plan,
      record,
      checkpoints: e.checkpoints.map((c) => c.id),
      busy: m.busy !== null,
      logs: m.logs.filter((l) => l.seq > sinceLog),
      lastError: m.lastError,
      createdAt: m.createdAt,
      startedAt: m.startedAt,
    };
  }

  list(): ReplayRunListItem[] {
    this.#evict();
    return [...this.#runs.keys()]
      .map((id) => {
        const s = this.status(id);
        return { runId: id, phase: s.phase, state: s.state, progress: s.progress, createdAt: s.createdAt, startedAt: s.startedAt, workflow: s.plan.workflow, controller: s.plan.controller };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Stop everything (service shutdown). */
  async shutdown(): Promise<void> {
    for (const m of this.#runs.values()) {
      if (m.started && !TERMINAL.has(m.engine.state)) await m.engine.stop().catch(() => undefined);
    }
  }
}
