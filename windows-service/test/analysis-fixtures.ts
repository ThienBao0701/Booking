/** Session fixtures for analyzer tests, built through the real recorder→wire conversion. */
import {
  type ElementDescriptor,
  type LabEvent,
  type RecordedAction,
  type SessionRecord,
  type Severity,
  type WorkflowLabel,
  toLabEvent,
} from "../src/shared.ts";
import { type SessionData, sessionData } from "../src/analysis/model.ts";
import type { Store } from "../src/db/store.ts";

export const T0 = 1_790_000_000_000;

export interface AddOpts {
  tab?: number | null;
  workflow?: WorkflowLabel;
  page?: string;
  target?: ElementDescriptor;
  metadata?: Record<string, unknown>;
  severity?: Severity;
}

export class SessionBuilder {
  readonly id: string;
  #seq = 0;
  #ts: number;
  #events: LabEvent[] = [];
  #session: SessionRecord;

  constructor(id: string, opts: { t0?: number; target?: "mock" | "observe"; ended?: boolean; mode?: string } = {}) {
    this.id = id;
    this.#ts = opts.t0 ?? T0;
    this.#session = {
      sessionId: id,
      startedAt: this.#ts,
      mode: opts.mode ?? "OBSERVE",
      target: { kind: opts.target ?? "mock", host: "127.0.0.1" },
      tabs: [],
      timeline: [],
      metadata: {},
    };
    if (opts.ended !== false) this.#session.endedAt = this.#ts; // updated by end()
  }

  wait(ms: number): this {
    this.#ts += ms;
    return this;
  }

  /** Skip sequence numbers (simulates missing / undelivered events). */
  skipSeq(n: number): this {
    this.#seq += n;
    return this;
  }

  add(action: RecordedAction, o: AddOpts = {}): string {
    const id = `${this.id}-e${String(this.#seq).padStart(4, "0")}`;
    const tab = o.tab === undefined ? 1 : o.tab;
    const lab = toLabEvent({
      event_id: id,
      session_id: this.id,
      seq: this.#seq++,
      timestamp: this.#ts,
      ...(tab !== null ? { tab_id: tab } : {}),
      page: o.page ?? "/",
      workflow: o.workflow ?? "UNKNOWN",
      action,
      ...(o.target ? { target: o.target } : {}),
      metadata: o.metadata ?? {},
      ...(o.severity ? { severity: o.severity } : {}),
    });
    this.#events.push(lab);
    return id;
  }

  /** Raw LabEvent (e.g. a quarantined payload). */
  raw(e: Omit<LabEvent, "id" | "sessionId" | "seq" | "ts">): string {
    const id = `${this.id}-e${String(this.#seq).padStart(4, "0")}`;
    this.#events.push({ ...e, id, sessionId: this.id, seq: this.#seq++, ts: this.#ts });
    return id;
  }

  start(env?: Record<string, unknown>): string {
    return this.add("session_start", { tab: null, metadata: { mode: "OBSERVE", targetKind: "mock", ...(env ? { environment: env } : {}) } });
  }

  transition(to: WorkflowLabel, from: WorkflowLabel = "UNKNOWN", tab = 1): string {
    return this.add("workflow_transition", { tab, workflow: to, metadata: { from, to, trigger: "page_state" } });
  }

  click(selector: string, workflow: WorkflowLabel, tab = 1): string {
    return this.add("click", { tab, workflow, target: { tag: "button", selector } });
  }

  change(selector: string, workflow: WorkflowLabel, metadata: Record<string, unknown> = { filled: true, inputType: "input" }, tab = 1): string {
    return this.add("change", { tab, workflow, target: { tag: "input", selector }, metadata });
  }

  dom(workflow: WorkflowLabel, tab = 1): string {
    return this.add("dom_change", { tab, workflow, metadata: { mutations: 3, added: 2, removed: 0 } });
  }

  end(): string {
    const id = this.add("session_end", { tab: null, metadata: { recorded: this.#seq } });
    if (this.#session.endedAt !== undefined) this.#session.endedAt = this.#ts;
    return id;
  }

  get now(): number {
    return this.#ts;
  }

  build(): SessionData {
    return sessionData(this.#session, this.#events);
  }

  get labEvents(): LabEvent[] {
    return this.#events;
  }
  get session(): SessionRecord {
    return this.#session;
  }
}

/**
 * A realistic mock-Extranet session: login → property → rooms → reservation →
 * cancellation → reports. `pace` scales the pauses.
 */
export function mockFlow(id: string, opts: { t0?: number; pace?: number; env?: Record<string, unknown>; target?: "mock" | "observe" } = {}): SessionBuilder {
  const p = opts.pace ?? 1;
  const b = new SessionBuilder(id, { ...(opts.t0 !== undefined ? { t0: opts.t0 } : {}), ...(opts.target ? { target: opts.target } : {}) });
  b.start(opts.env);
  b.wait(1000 * p).transition("LOGIN");
  b.add("page_state", { workflow: "LOGIN", metadata: { view: "login" } });
  b.wait(3000 * p).change("#login-username", "LOGIN");
  b.wait(1000 * p).click("#login-submit", "LOGIN");
  b.wait(300).dom("LOGIN");
  b.wait(2000 * p).click('button[data-view="property"]', "LOGIN");
  b.transition("PROPERTY_SETUP", "LOGIN");
  b.add("page_state", { workflow: "PROPERTY_SETUP", metadata: { view: "property" } });
  b.wait(4000 * p).change("#prop-name", "PROPERTY_SETUP");
  b.wait(3000 * p).change("#prop-address", "PROPERTY_SETUP");
  b.wait(1000 * p).click("#prop-submit", "PROPERTY_SETUP");
  b.wait(300).dom("PROPERTY_SETUP");
  b.wait(2000 * p).click('button[data-view="rooms"]', "PROPERTY_SETUP");
  b.transition("ROOM_SETUP", "PROPERTY_SETUP");
  b.add("page_state", { workflow: "ROOM_SETUP", metadata: { view: "rooms" } });
  b.wait(3000 * p).change("#room-name", "ROOM_SETUP");
  b.wait(1000 * p).click("#room-submit", "ROOM_SETUP");
  b.wait(300).dom("ROOM_SETUP");
  b.wait(2000 * p).click('button[data-view="reservations"]', "ROOM_SETUP");
  b.transition("RESERVATION", "ROOM_SETUP");
  b.add("page_state", { workflow: "RESERVATION", metadata: { view: "reservations" } });
  b.wait(4000 * p).change("#res-guest", "RESERVATION");
  b.wait(1000 * p).click("#res-submit", "RESERVATION");
  b.wait(300).dom("RESERVATION");
  b.wait(5000 * p).transition("CANCELLATION", "RESERVATION");
  b.click("button[data-cancel]", "CANCELLATION");
  b.wait(300).dom("CANCELLATION");
  b.wait(2000 * p).transition("RESERVATION", "CANCELLATION");
  b.click('button[data-view="reports"]', "RESERVATION");
  b.transition("REPORTING", "RESERVATION");
  b.add("page_state", { workflow: "REPORTING", metadata: { view: "reports" } });
  b.wait(2000 * p).click("#report-submit", "REPORTING");
  b.wait(300).dom("REPORTING");
  b.wait(1000).end();
  return b;
}

/** Persist a built session (session row + events + end) into a Store. */
export function persist(store: Store, b: SessionBuilder): void {
  const s = b.session;
  store.createSession({
    id: s.sessionId,
    startedAt: s.startedAt,
    mode: s.mode,
    targetKind: s.target.kind,
    ...(s.target.host ? { targetHost: s.target.host } : {}),
  });
  store.transaction(() => {
    for (const ev of b.labEvents) store.insertEvent(ev);
  });
  if (s.endedAt !== undefined) store.endSession(s.sessionId, s.endedAt);
}

export const ENV_A = {
  browser: "Chrome",
  browser_major: 131,
  platform: "Windows",
  language: "en-US",
  timezone: "Europe/Amsterdam",
  timezone_offset_min: 60,
  hardware_concurrency: 8,
  extension_version: "0.1.0",
};
