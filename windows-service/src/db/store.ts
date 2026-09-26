/**
 * Data access layer over node:sqlite (docs/08-data-model.md). Prepared
 * statements, WAL, defensive re-redaction on write.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  type LabEvent,
  type SessionRecord,
  type RunRecord,
  redactValue,
  looksSensitive,
} from "../shared.ts";
import { DDL, PRAGMAS, SCHEMA_VERSION } from "./schema.ts";

export interface NewSession {
  id: string;
  startedAt: number;
  mode: string;
  targetKind: string;
  targetHost?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredEventRow {
  id: string;
  session_id: string;
  seq: number;
  ts: number;
  tab_id: number | null;
  kind: string;
  category: string;
  workflow: string | null;
  severity: string;
  redacted: number;
  data: string;
}

export class Store {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    for (const p of PRAGMAS) this.#db.exec(p);
    this.#db.exec(DDL);
    this.#setMeta("schema_version", String(SCHEMA_VERSION));
  }

  close(): void {
    this.#db.close();
  }

  #setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  // ---- sessions ----

  /**
   * Create a session. Idempotent: re-registering an existing id (e.g. a bridge
   * reconnect) is a no-op and returns false instead of failing.
   */
  createSession(s: NewSession): boolean {
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO sessions(id, started_at, mode, target_kind, target_host, metadata)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(
        s.id,
        s.startedAt,
        s.mode,
        s.targetKind,
        s.targetHost ?? null,
        JSON.stringify(s.metadata ?? {}),
      );
    return r.changes > 0;
  }

  hasSession(id: string): boolean {
    return this.#db.prepare("SELECT 1 AS x FROM sessions WHERE id=?").get(id) !== undefined;
  }

  /**
   * Run `fn` inside a single SQLite transaction (atomic batch + one fsync
   * instead of one per row — Component 16 "minimal disk writes").
   */
  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  endSession(id: string, endedAt: number): boolean {
    const r = this.#db.prepare("UPDATE sessions SET ended_at=? WHERE id=?").run(endedAt, id);
    return r.changes > 0;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.id as string,
      startedAt: row.started_at as number,
      ...(row.ended_at != null ? { endedAt: row.ended_at as number } : {}),
      mode: row.mode as string,
      target: { kind: row.target_kind as string, ...(row.target_host ? { host: row.target_host as string } : {}) },
      tabs: [],
      timeline: [],
      metadata: JSON.parse((row.metadata as string) ?? "{}"),
    };
  }

  listSessions(limit = 100): Array<{ id: string; startedAt: number; endedAt: number | null; mode: string }> {
    const rows = this.#db
      .prepare("SELECT id, started_at, ended_at, mode FROM sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
      mode: r.mode as string,
    }));
  }

  // ---- events ----

  /**
   * Persist a validated event. Redaction is re-applied defensively; if the
   * payload still looks sensitive it is quarantined (data replaced with a marker)
   * rather than stored raw. Returns the action taken.
   *
   * Idempotent on `id`: re-sending an already-stored event (a bridge retry after
   * a lost response) returns "duplicate" instead of failing the batch.
   */
  insertEvent(ev: LabEvent): "stored" | "quarantined" | "duplicate" {
    const safeData = redactValue(ev.data);
    let dataStr = JSON.stringify(safeData);
    let quarantined = false;
    if (looksSensitive(dataStr)) {
      dataStr = JSON.stringify({ quarantined: true, reason: "post-redaction sensitive match" });
      quarantined = true;
    }
    const r = this.#db
      .prepare(
        `INSERT OR IGNORE INTO events(id, session_id, seq, ts, tab_id, kind, category, workflow, severity, redacted, data)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ev.id,
        ev.sessionId,
        ev.seq,
        ev.ts,
        ev.tabId ?? null,
        ev.kind,
        ev.category,
        ev.workflow ?? null,
        ev.severity,
        1,
        dataStr,
      );
    if (r.changes === 0) return "duplicate";
    return quarantined ? "quarantined" : "stored";
  }

  countEvents(sessionId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id=?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  getEvents(sessionId: string, limit = 1000): StoredEventRow[] {
    return this.#db
      .prepare("SELECT * FROM events WHERE session_id=? ORDER BY seq ASC LIMIT ?")
      .all(sessionId, limit) as unknown as StoredEventRow[];
  }

  /** Stored events as wire-contract LabEvents (ordered by seq). */
  getLabEvents(sessionId: string, limit = 10_000): LabEvent[] {
    return this.getEvents(sessionId, limit).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      ts: r.ts,
      ...(r.tab_id !== null ? { tabId: r.tab_id } : {}),
      kind: r.kind as LabEvent["kind"],
      category: r.category as LabEvent["category"],
      ...(r.workflow !== null ? { workflow: r.workflow as NonNullable<LabEvent["workflow"]> } : {}),
      severity: r.severity as LabEvent["severity"],
      redacted: r.redacted === 1,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
  }

  // ---- replay runs (docs/04-replay-format.md run record) ----

  /** Upsert a replay run record and its step results atomically. */
  saveRun(run: RunRecord): void {
    this.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO runs(run_id, workflow, mode, started_at, ended_at, status, checkpoints, source_session_id, dry_run)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(run_id) DO UPDATE SET
             ended_at=excluded.ended_at, status=excluded.status,
             checkpoints=excluded.checkpoints, dry_run=excluded.dry_run`,
        )
        .run(
          run.runId,
          run.workflow,
          run.mode,
          run.startedAt,
          run.endedAt ?? null,
          run.status,
          JSON.stringify(run.checkpoints),
          run.sourceSessionId ?? null,
          run.dryRun ? 1 : 0,
        );
      const upsertStep = this.#db.prepare(
        `INSERT INTO run_steps(run_id, step_id, status, started_at, ended_at, attempts, error)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(run_id, step_id) DO UPDATE SET
           status=excluded.status, started_at=excluded.started_at, ended_at=excluded.ended_at,
           attempts=excluded.attempts, error=excluded.error`,
      );
      for (const s of run.steps) {
        upsertStep.run(run.runId, s.id, s.status, s.startedAt ?? null, s.endedAt ?? null, s.attempts, s.error ?? null);
      }
    });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const steps = this.#db
      .prepare("SELECT * FROM run_steps WHERE run_id=? ORDER BY rowid ASC")
      .all(runId) as Array<Record<string, unknown>>;
    return {
      runId: row.run_id as string,
      workflow: row.workflow as string,
      mode: row.mode as string,
      startedAt: row.started_at as number,
      ...(row.ended_at != null ? { endedAt: row.ended_at as number } : {}),
      status: row.status as RunRecord["status"],
      checkpoints: JSON.parse(row.checkpoints as string) as string[],
      ...(row.source_session_id != null ? { sourceSessionId: row.source_session_id as string } : {}),
      dryRun: row.dry_run === 1,
      steps: steps.map((s) => ({
        id: s.step_id as string,
        status: s.status as RunRecord["steps"][number]["status"],
        ...(s.started_at != null ? { startedAt: s.started_at as number } : {}),
        ...(s.ended_at != null ? { endedAt: s.ended_at as number } : {}),
        attempts: s.attempts as number,
        ...(s.error != null ? { error: s.error as string } : {}),
      })),
    };
  }

  // ---- maintenance ----

  purgeSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id=?").run(id); // cascades
  }

  vacuum(): void {
    this.#db.exec("VACUUM;");
  }
}
