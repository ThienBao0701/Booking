/**
 * Event recorder (Phase 2). Pipeline for every captured input:
 *
 *   build (standardized RecordedEvent) → redact → strip raw values
 *   → workflow detection (+ WORKFLOW_TRANSITION) → dedup → seq
 *   → micro-batched persist to the queue → debounced / size-triggered flush
 *   → sink (bridge) with retry + exponential backoff.
 *
 * Events leave the queue only when the sink reports them terminal (stored,
 * duplicate, quarantined, or rejected as invalid). Auth / origin / contract
 * failures block delivery WITHOUT dropping data until the operator fixes the
 * configuration.
 */

import {
  type ElementDescriptor,
  type IdEnv,
  type RecordedAction,
  type RecordedEvent,
  type SafetyMode,
  type Severity,
  type WorkflowLabel,
  SequenceCounter,
  defaultIdEnv,
  newId,
  newPrefixedId,
  redactValue,
} from "../shared.ts";
import { pagePath } from "../common/paths.ts";
import { Debouncer, realTimers, type TimerApi } from "./debounce.ts";
import { Deduplicator, type DedupOptions } from "./dedup.ts";
import type { EventQueue } from "./queue.ts";
import { DEFAULT_WORKFLOW_RULES, detectWorkflow, type WorkflowRule } from "./workflow-rules.ts";

// ---- sink contract (implemented by the bridge) ----

export type DeliveryFailureReason =
  | "transport"
  | "timeout"
  | "server"
  | "rate_limited"
  | "auth"
  | "forbidden"
  | "incompatible"
  | "unpaired"
  | "rejected_batch";

export type DeliveryResult =
  | { ok: true; ackIds: string[]; rejected: Array<{ id: string; code: string; errors: string[] }> }
  | { ok: false; reason: DeliveryFailureReason; retryable: boolean; error: string };

export interface EventSink {
  /** Deliver a batch. `ok: true` means every event in the batch is terminal. */
  deliver(batch: RecordedEvent[]): Promise<DeliveryResult>;
}

// ---- recorder types ----

export interface SessionDescriptor {
  sessionId: string;
  mode: SafetyMode;
  target: { kind: string; host?: string };
  startedAt: number;
}

export interface RecordInput {
  action: RecordedAction;
  /** URL or path; reduced to a redacted path. */
  page: string;
  tabId?: number | undefined;
  view?: string | undefined;
  target?: ElementDescriptor | undefined;
  metadata?: Record<string, unknown> | undefined;
  severity?: Severity | undefined;
  timestamp?: number | undefined;
  /** Explicit workflow; otherwise detected from rules. */
  workflow?: WorkflowLabel | undefined;
}

export interface RecorderStats {
  recording: boolean;
  sessionId: string | null;
  nextSeq: number;
  recorded: number;
  deduplicated: number;
  delivered: number;
  rejected: number;
  dropped: number;
  retries: number;
  queueSize: number;
  blocked: DeliveryFailureReason | null;
  lastError: string | null;
  lastDeliveryAt: number | null;
}

export interface FlushResult {
  delivered: number;
  status: "ok" | "empty" | "blocked" | "retry_scheduled" | "error";
}

export interface RecorderOptions {
  queue: EventQueue;
  sink: EventSink;
  timers?: TimerApi;
  idEnv?: IdEnv;
  batchSize?: number;
  flushIntervalMs?: number;
  maxFlushDelayMs?: number;
  maxQueue?: number;
  dedup?: Partial<DedupOptions>;
  retry?: { baseMs: number; maxMs: number };
  random?: () => number;
  rules?: readonly WorkflowRule[];
  onStats?: (s: RecorderStats) => void;
}

const MAX_BATCHES_PER_FLUSH = 20;
const TRANSITION_ACTIONS = new Set<RecordedAction>([
  "navigate",
  "page_load",
  "page_state",
  "click",
  "input",
  "change",
  "submit",
]);
/** Keys that commonly carry raw user content; stripped at the recorder boundary. */
const RAW_CONTENT_KEYS = new Set(["value", "values", "rawValue", "innerText", "textContent", "html", "innerHTML", "outerHTML"]);

function stripRawContent(v: unknown, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => stripRawContent(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!RAW_CONTENT_KEYS.has(k)) out[k] = stripRawContent(val, depth + 1);
  }
  return out;
}

export class Recorder {
  #queue: EventQueue;
  #sink: EventSink;
  #timers: TimerApi;
  #idEnv: IdEnv;
  #batchSize: number;
  #maxQueue: number;
  #retry: { baseMs: number; maxMs: number };
  #random: () => number;
  #rules: readonly WorkflowRule[];
  #onStats: ((s: RecorderStats) => void) | undefined;

  #dedup: Deduplicator;
  #debouncer: Debouncer;
  #session: SessionDescriptor | undefined;
  #seq = new SequenceCounter(0);
  #lastWorkflow = new Map<number, WorkflowLabel>();
  #buffer: RecordedEvent[] = [];
  #persistScheduled = false;
  #pending: Promise<void> = Promise.resolve();
  #unflushed = 0;
  #flushing: Promise<FlushResult> | undefined;
  #retryHandle: unknown = undefined;
  #failures = 0;
  #stats: RecorderStats = {
    recording: false,
    sessionId: null,
    nextSeq: 0,
    recorded: 0,
    deduplicated: 0,
    delivered: 0,
    rejected: 0,
    dropped: 0,
    retries: 0,
    queueSize: 0,
    blocked: null,
    lastError: null,
    lastDeliveryAt: null,
  };

  constructor(opts: RecorderOptions) {
    this.#queue = opts.queue;
    this.#sink = opts.sink;
    this.#timers = opts.timers ?? realTimers;
    this.#idEnv = opts.idEnv ?? defaultIdEnv;
    this.#batchSize = Math.max(1, Math.min(500, opts.batchSize ?? 50));
    this.#maxQueue = opts.maxQueue ?? 5000;
    this.#retry = opts.retry ?? { baseMs: 1000, maxMs: 60_000 };
    this.#random = opts.random ?? Math.random;
    this.#rules = opts.rules ?? DEFAULT_WORKFLOW_RULES;
    this.#onStats = opts.onStats;
    this.#dedup = new Deduplicator(opts.dedup);
    const interval = opts.flushIntervalMs ?? 2000;
    this.#debouncer = new Debouncer(() => void this.flush(), interval, opts.maxFlushDelayMs ?? interval * 5, this.#timers);
  }

  get session(): SessionDescriptor | undefined {
    return this.#session;
  }

  get stats(): RecorderStats {
    return { ...this.#stats, nextSeq: this.#seq.peek() };
  }

  /** Swap the delivery sink (e.g. after the operator re-pairs the service). */
  setSink(sink: EventSink): void {
    this.#sink = sink;
    this.#stats.blocked = null;
    this.#failures = 0;
  }

  startSession(opts: {
    mode: SafetyMode;
    target: { kind: string; host?: string };
    sessionId?: string;
    startedAt?: number;
  }): SessionDescriptor {
    if (this.#session) throw new Error(`session ${this.#session.sessionId} is already active`);
    const desc: SessionDescriptor = {
      sessionId: opts.sessionId ?? newPrefixedId("session", this.#idEnv),
      mode: opts.mode,
      target: opts.target,
      startedAt: opts.startedAt ?? this.#timers.now(),
    };
    this.#session = desc;
    this.#seq = new SequenceCounter(0);
    this.#lastWorkflow.clear();
    this.#stats.recording = true;
    this.#stats.sessionId = desc.sessionId;
    this.record({ action: "session_start", page: "/", metadata: { mode: desc.mode, targetKind: desc.target.kind } });
    return desc;
  }

  /** Resume an active session after a service-worker restart. */
  restoreSession(desc: SessionDescriptor, nextSeq: number): void {
    this.#session = desc;
    this.#seq = new SequenceCounter(nextSeq);
    this.#stats.recording = true;
    this.#stats.sessionId = desc.sessionId;
  }

  async endSession(): Promise<SessionDescriptor | undefined> {
    const s = this.#session;
    if (!s) return undefined;
    this.record({ action: "session_end", page: "/", metadata: { recorded: this.#stats.recorded } });
    this.#session = undefined;
    this.#stats.recording = false;
    this.#stats.sessionId = null;
    await this.flush({ manual: true });
    return s;
  }

  /**
   * Record one captured input. Returns the standardized event, or undefined when
   * not recording or when the event was deduplicated.
   */
  record(input: RecordInput): RecordedEvent | undefined {
    const session = this.#session;
    if (!session) return undefined;
    const timestamp = input.timestamp ?? this.#timers.now();
    const page = pagePath(input.page);
    const target = input.target ? (redactValue(input.target) as ElementDescriptor) : undefined;
    const metadata = stripRawContent(redactValue(input.metadata ?? {})) as Record<string, unknown>;
    const workflow =
      input.workflow ?? detectWorkflow({ page, view: input.view, action: input.action, target }, this.#rules);

    const tabKey = input.tabId ?? -1;
    if (workflow !== "UNKNOWN" && TRANSITION_ACTIONS.has(input.action) && this.#lastWorkflow.get(tabKey) !== workflow) {
      const from = this.#lastWorkflow.get(tabKey) ?? "UNKNOWN";
      this.#lastWorkflow.set(tabKey, workflow);
      this.#emit(
        this.#build(session, {
          action: "workflow_transition",
          page,
          tabId: input.tabId,
          workflow,
          timestamp,
          metadata: { from, to: workflow, trigger: input.action },
        }),
      );
    }

    return this.#emit(
      this.#build(session, {
        action: input.action,
        page,
        tabId: input.tabId,
        workflow,
        timestamp,
        target,
        metadata,
        severity: input.severity,
      }),
    );
  }

  #build(
    session: SessionDescriptor,
    p: {
      action: RecordedAction;
      page: string;
      tabId: number | undefined;
      workflow: WorkflowLabel;
      timestamp: number;
      target?: ElementDescriptor | undefined;
      metadata: Record<string, unknown>;
      severity?: Severity | undefined;
    },
  ): RecordedEvent {
    return {
      event_id: newId(this.#idEnv),
      session_id: session.sessionId,
      seq: -1, // assigned after dedup so dropped duplicates leave no gaps
      timestamp: p.timestamp,
      ...(p.tabId !== undefined ? { tab_id: p.tabId } : {}),
      page: p.page,
      workflow: p.workflow,
      action: p.action,
      ...(p.target !== undefined ? { target: p.target } : {}),
      metadata: p.metadata,
      ...(p.severity !== undefined ? { severity: p.severity } : {}),
    };
  }

  #emit(ev: RecordedEvent): RecordedEvent | undefined {
    if (this.#dedup.isDuplicate(ev)) {
      this.#stats.deduplicated += 1;
      this.#notify();
      return undefined;
    }
    ev.seq = this.#seq.next();
    this.#stats.recorded += 1;
    this.#buffer.push(ev);
    this.#schedulePersist();
    this.#unflushed += 1;
    if (this.#unflushed >= this.#batchSize) void this.flush();
    else this.#debouncer.trigger();
    return ev;
  }

  /** Micro-batched persistence: many events per tick → one queue write. */
  #schedulePersist(): void {
    if (this.#persistScheduled) return;
    this.#persistScheduled = true;
    this.#pending = this.#pending
      .then(async () => {
        this.#persistScheduled = false;
        const batch = this.#buffer;
        this.#buffer = [];
        if (batch.length === 0) return;
        await this.#queue.push(batch);
        const dropped = await this.#queue.trim(this.#maxQueue);
        if (dropped > 0) {
          this.#stats.dropped += dropped;
          this.#stats.lastError = `queue full: dropped ${dropped} oldest event(s)`;
        }
      })
      .catch((err: unknown) => {
        this.#persistScheduled = false;
        this.#stats.lastError = `persist failed: ${String(err)}`;
      });
  }

  /** Wait until every recorded event has been written to the queue. */
  async settled(): Promise<void> {
    await this.#pending;
  }

  /**
   * Deliver queued events. Concurrent calls coalesce. Automatic flushes skip
   * while delivery is blocked on configuration (auth/origin/contract);
   * `manual: true` always attempts.
   */
  flush(opts: { manual?: boolean } = {}): Promise<FlushResult> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#doFlush(opts).finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #doFlush(opts: { manual?: boolean }): Promise<FlushResult> {
    this.#debouncer.cancel();
    this.#clearRetry();
    this.#unflushed = 0;
    await this.#pending;
    if (this.#stats.blocked && !opts.manual) {
      this.#stats.queueSize = await this.#queue.size();
      this.#notify();
      return { delivered: 0, status: "blocked" };
    }

    let delivered = 0;
    let status: FlushResult["status"] = "empty";
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH; i++) {
      const batch = await this.#queue.peek(this.#batchSize);
      if (batch.length === 0) break;

      let result: DeliveryResult;
      try {
        result = await this.#sink.deliver(batch);
      } catch (err) {
        result = { ok: false, reason: "transport", retryable: true, error: String(err) };
      }

      if (result.ok) {
        await this.#queue.ack(batch.map((e) => e.event_id));
        delivered += result.ackIds.length;
        this.#stats.delivered += result.ackIds.length;
        this.#stats.rejected += result.rejected.length;
        if (result.rejected.length > 0) {
          const r = result.rejected[0];
          this.#stats.lastError = `service rejected ${result.rejected.length} event(s): ${r?.code ?? ""} ${r?.errors[0] ?? ""}`.trim();
        }
        this.#stats.blocked = null;
        this.#stats.lastDeliveryAt = this.#timers.now();
        this.#failures = 0;
        status = "ok";
        if (batch.length < this.#batchSize) break;
        continue;
      }

      this.#stats.lastError = `${result.reason}: ${result.error}`;
      if (!result.retryable) {
        if (result.reason === "rejected_batch") {
          // Poison batch (can never be accepted): drop it so the queue keeps moving.
          await this.#queue.ack(batch.map((e) => e.event_id));
          this.#stats.dropped += batch.length;
          status = "error";
          continue;
        }
        this.#stats.blocked = result.reason; // keep data until configuration is fixed
        status = "blocked";
        break;
      }
      this.#failures += 1;
      this.#stats.retries += 1;
      this.#scheduleRetry(result.reason === "rate_limited");
      status = "retry_scheduled";
      break;
    }

    this.#stats.queueSize = await this.#queue.size();
    this.#notify();
    return { delivered, status };
  }

  #scheduleRetry(rateLimited: boolean): void {
    this.#clearRetry();
    const exp = Math.min(this.#retry.maxMs, this.#retry.baseMs * 2 ** Math.max(0, this.#failures - 1));
    const jittered = Math.round(exp * (0.5 + this.#random() * 0.5));
    const delay = rateLimited ? Math.max(jittered, 5000) : jittered;
    this.#retryHandle = this.#timers.setTimeout(() => {
      this.#retryHandle = undefined;
      void this.flush();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryHandle !== undefined) this.#timers.clearTimeout(this.#retryHandle);
    this.#retryHandle = undefined;
  }

  #notify(): void {
    this.#onStats?.(this.stats);
  }

  dispose(): void {
    this.#debouncer.cancel();
    this.#clearRetry();
  }
}
