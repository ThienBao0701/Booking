/**
 * Data access layer over node:sqlite (docs/08-data-model.md). Prepared
 * statements, WAL, defensive re-redaction on write.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  type Finding,
  type LabEvent,
  type LabStats,
  type ReplayRunSummary,
  type ScreenshotRecord,
  type SessionSummary,
  type StoredEventRow,
  type SessionRecord,
  type RunRecord,
  redactValue,
  looksSensitive,
} from "../shared.ts";

export interface FindingFilter {
  sessionId?: string | undefined;
  workflow?: string | undefined;
  severity?: string | undefined;
  ruleId?: string | undefined;
  category?: string | undefined;
  /** Case-insensitive substring over title, description and rule id. */
  q?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
import { ADDED_COLUMNS, ADDED_INDEXES, DDL, PRAGMAS, SCHEMA_VERSION } from "./schema.ts";

export interface SessionFilter {
  from?: number | undefined;
  to?: number | undefined;
  q?: string | undefined;
  workflow?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface EventFilter {
  sessionId?: string | undefined;
  kind?: string | undefined;
  workflow?: string | undefined;
  severity?: string | undefined;
  category?: string | undefined;
  /** Case-insensitive substring over the (redacted) payload, id and kind. */
  q?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  order?: "asc" | "desc" | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** LIKE pattern for a user search term (LIKE wildcards stripped). */
function likePattern(q: string): string {
  return `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(500, limit ?? fallback));
}

// Row contracts live in shared (ADR-0006); re-exported for existing importers.
export type { LabStats, ReplayRunSummary, SessionSummary, StoredEventRow };

export interface NewSession {
  id: string;
  startedAt: number;
  mode: string;
  targetKind: string;
  targetHost?: string;
  metadata?: Record<string, unknown>;
}

export interface AnalysisMetaInput {
  session_id: string;
  analyzed_at: number;
  rules_version: string;
  event_count: number;
}
export interface AnalysisMetaRow extends AnalysisMetaInput {
  finding_count: number;
}

export class Store {
  #db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    for (const p of PRAGMAS) this.#db.exec(p);
    this.#db.exec(DDL);
    this.#migrate();
    this.#setMeta("schema_version", String(SCHEMA_VERSION));
  }

  close(): void {
    this.#db.close();
  }

  /** Apply additive column migrations to databases from older schema versions. */
  #migrate(): void {
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const cols = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    for (const ddl of ADDED_INDEXES) this.#db.exec(ddl);
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
          `INSERT INTO runs(run_id, workflow, mode, started_at, ended_at, status, checkpoints, source_session_id, dry_run, target)
           VALUES(?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(run_id) DO UPDATE SET
             ended_at=excluded.ended_at, status=excluded.status,
             checkpoints=excluded.checkpoints, dry_run=excluded.dry_run, target=excluded.target`,
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
          run.target ? JSON.stringify(run.target) : null,
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
      ...(row.target != null ? { target: JSON.parse(row.target as string) as NonNullable<RunRecord["target"]> } : {}),
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

  // ---- findings (Component 6 table + Phase 8 columns) ----

  /**
   * Replace the findings of `sessionIds` with `findings` (one transaction):
   * re-running analysis never leaves stale or duplicate findings.
   */
  saveFindings(sessionIds: readonly string[], findings: readonly Finding[], meta: ReadonlyArray<AnalysisMetaInput> = []): void {
    this.transaction(() => {
      const up = this.#db.prepare(
        `INSERT INTO analysis_meta(session_id, analyzed_at, rules_version, event_count, finding_count) VALUES(?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET analyzed_at=excluded.analyzed_at, rules_version=excluded.rules_version,
           event_count=excluded.event_count, finding_count=excluded.finding_count`,
      );
      for (const m of meta) up.run(m.session_id, m.analyzed_at, m.rules_version, m.event_count, findings.filter((f) => f.session_id === m.session_id).length);
      const del = this.#db.prepare("DELETE FROM findings WHERE session_id=?");
      for (const id of sessionIds) del.run(id);
      const ins = this.#db.prepare(
        `INSERT OR REPLACE INTO findings(id, session_id, observed_pattern, evidence, frequency, context, possible_explanation,
           first_ts, last_ts, workflow, event_ids, rule_id, category, severity, description, confidence,
           counter_evidence, recommended_next_test, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const f of findings) {
        ins.run(
          f.finding_id,
          f.session_id,
          f.title,
          JSON.stringify(f.evidence),
          f.frequency,
          JSON.stringify(f.context),
          f.possible_explanation,
          f.timestamp_range.start,
          f.timestamp_range.end,
          f.workflow,
          JSON.stringify(f.event_ids),
          f.rule_id,
          f.category,
          f.severity,
          f.description,
          f.confidence,
          JSON.stringify(f.counter_evidence),
          f.recommended_next_test,
          f.created_at,
        );
      }
    });
  }

  /** Provenance of stored findings (diagnostics); all sessions when `ids` is omitted. */
  getAnalysisMeta(ids?: readonly string[]): AnalysisMetaRow[] {
    const rows = (ids
      ? ids.length === 0
        ? []
        : this.#db.prepare(`SELECT * FROM analysis_meta WHERE session_id IN (${ids.map(() => "?").join(",")})`).all(...ids)
      : this.#db.prepare("SELECT * FROM analysis_meta").all()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ session_id: r.session_id as string, analyzed_at: r.analyzed_at as number, rules_version: r.rules_version as string, event_count: r.event_count as number, finding_count: r.finding_count as number }));
  }

  /** Stored finding counts per session. */
  findingCounts(ids: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = this.#db.prepare(`SELECT session_id, COUNT(*) AS n FROM findings WHERE session_id IN (${ids.map(() => "?").join(",")}) GROUP BY session_id`).all(...ids) as Array<{ session_id: string; n: number }>;
    for (const r of rows) out.set(r.session_id, r.n);
    return out;
  }

  #rowToFinding(r: Record<string, unknown>): Finding {
    return {
      finding_id: r.id as string,
      session_id: r.session_id as string,
      workflow: ((r.workflow as string | null) ?? "UNKNOWN") as Finding["workflow"],
      event_ids: JSON.parse((r.event_ids as string | null) ?? "[]") as string[],
      timestamp_range: { start: r.first_ts as number, end: r.last_ts as number },
      rule_id: (r.rule_id as string | null) ?? "LEGACY",
      category: ((r.category as string | null) ?? "EVENT_SEQUENCE") as Finding["category"],
      severity: ((r.severity as string | null) ?? "info") as Finding["severity"],
      title: r.observed_pattern as string,
      description: (r.description as string | null) ?? (r.observed_pattern as string),
      evidence: JSON.parse(r.evidence as string) as Finding["evidence"],
      confidence: (r.confidence as number | null) ?? 0.5,
      counter_evidence: JSON.parse((r.counter_evidence as string | null) ?? "[]") as string[],
      recommended_next_test: (r.recommended_next_test as string | null) ?? "",
      frequency: r.frequency as number,
      context: JSON.parse(r.context as string) as Record<string, unknown>,
      possible_explanation: r.possible_explanation as string,
      created_at: (r.created_at as number | null) ?? (r.first_ts as number),
    };
  }

  listFindings(filter: FindingFilter = {}): { total: number; findings: Finding[] } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const eq = (col: string, v: string | undefined) => {
      if (v) {
        where.push(`${col} = ?`);
        args.push(v);
      }
    };
    eq("session_id", filter.sessionId);
    eq("workflow", filter.workflow);
    eq("severity", filter.severity);
    eq("rule_id", filter.ruleId);
    eq("category", filter.category);
    if (filter.from !== undefined) {
      where.push("last_ts >= ?");
      args.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("first_ts <= ?");
      args.push(filter.to);
    }
    if (filter.q) {
      where.push("(lower(observed_pattern) LIKE ? OR lower(description) LIKE ? OR lower(rule_id) LIKE ?)");
      const like = `%${filter.q.toLowerCase().replace(/[%_]/g, "")}%`;
      args.push(like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM findings ${clause}`).get(...args) as { n: number }).n;
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.#db
      .prepare(
        `SELECT * FROM findings ${clause}
         ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, first_ts DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Array<Record<string, unknown>>;
    return { total, findings: rows.map((r) => this.#rowToFinding(r)) };
  }

  getFinding(id: string): Finding | undefined {
    const row = this.#db.prepare("SELECT * FROM findings WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.#rowToFinding(row) : undefined;
  }

  /** Stored events by id (for finding drill-down / report evidence). */
  getEventsByIds(ids: readonly string[]): StoredEventRow[] {
    if (ids.length === 0) return [];
    const out: StoredEventRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.#db
        .prepare(`SELECT * FROM events WHERE id IN (${chunk.map(() => "?").join(",")}) ORDER BY session_id, seq`)
        .all(...chunk) as unknown as StoredEventRow[];
      out.push(...rows);
    }
    return out;
  }

  // ---- dashboard queries (read-only; ADR-0006) ----

  /** Session list with per-session counts, newest first. */
  listSessionSummaries(filter: SessionFilter = {}): { total: number; sessions: SessionSummary[] } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.from !== undefined) {
      where.push("COALESCE(s.ended_at, s.started_at) >= ?");
      args.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("s.started_at <= ?");
      args.push(filter.to);
    }
    if (filter.q) {
      where.push("(lower(s.id) LIKE ? OR lower(COALESCE(s.target_host,'')) LIKE ? OR lower(s.mode) LIKE ?)");
      const like = likePattern(filter.q);
      args.push(like, like, like);
    }
    if (filter.workflow) {
      where.push("EXISTS (SELECT 1 FROM events w WHERE w.session_id = s.id AND w.workflow = ?)");
      args.push(filter.workflow);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM sessions s ${clause}`).get(...args) as { n: number }).n;
    const rows = this.#db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id) AS event_count,
           (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.severity = 'error') AS error_count,
           (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS finding_count
         FROM sessions s ${clause} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, clampLimit(filter.limit, 100), Math.max(0, filter.offset ?? 0)) as Array<Record<string, unknown>>;
    return {
      total,
      sessions: rows.map((r) => ({
        id: r.id as string,
        startedAt: r.started_at as number,
        endedAt: (r.ended_at as number | null) ?? null,
        mode: r.mode as string,
        targetKind: r.target_kind as string,
        targetHost: (r.target_host as string | null) ?? null,
        eventCount: r.event_count as number,
        errorCount: r.error_count as number,
        findingCount: r.finding_count as number,
      })),
    };
  }

  /** Cross-session event search (redacted rows as stored). */
  queryEvents(filter: EventFilter = {}): { total: number; events: StoredEventRow[] } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const eq = (col: string, v: string | undefined) => {
      if (v) {
        where.push(`${col} = ?`);
        args.push(v);
      }
    };
    eq("session_id", filter.sessionId);
    eq("kind", filter.kind);
    eq("workflow", filter.workflow);
    eq("severity", filter.severity);
    eq("category", filter.category);
    if (filter.from !== undefined) {
      where.push("ts >= ?");
      args.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("ts <= ?");
      args.push(filter.to);
    }
    if (filter.q) {
      where.push("(lower(data) LIKE ? OR lower(id) LIKE ? OR lower(kind) LIKE ?)");
      const like = likePattern(filter.q);
      args.push(like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM events ${clause}`).get(...args) as { n: number }).n;
    const order = filter.order === "asc" ? "ASC" : "DESC";
    const events = this.#db
      .prepare(`SELECT * FROM events ${clause} ORDER BY ts ${order}, seq ${order} LIMIT ? OFFSET ?`)
      .all(...args, clampLimit(filter.limit, 200), Math.max(0, filter.offset ?? 0)) as unknown as StoredEventRow[];
    return { total, events };
  }

  /** Aggregates for the dashboard overview. `tzOffsetMin` buckets days in local time. */
  stats(filter: { from?: number | undefined; to?: number | undefined; tzOffsetMin?: number | undefined } = {}): LabStats {
    const args: number[] = [];
    if (filter.from !== undefined) args.push(filter.from);
    if (filter.to !== undefined) args.push(filter.to);
    // Range predicate over [startCol, endCol] overlapping [from, to]; args are (from?, to?).
    const range = (startCol: string, endCol = startCol) => {
      const parts: string[] = [];
      if (filter.from !== undefined) parts.push(`${endCol} >= ?`);
      if (filter.to !== undefined) parts.push(`${startCol} <= ?`);
      return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
    };
    const evWhere = range("ts");
    const sWhere = range("started_at", "COALESCE(ended_at, started_at)");
    const fWhere = range("first_ts", "last_ts");
    const rWhere = range("started_at", "COALESCE(ended_at, started_at)");
    const offsetMs = Math.round((filter.tzOffsetMin ?? 0) * 60_000);
    const count = (sql: string, a: number[] = args) => (this.#db.prepare(sql).get(...a) as { n: number }).n;
    const group = (sql: string, a: number[] = args) =>
      Object.fromEntries((this.#db.prepare(sql).all(...a) as Array<{ k: string | null; n: number }>).map((r) => [r.k ?? "UNKNOWN", r.n]));
    return {
      sessions: count(`SELECT COUNT(*) AS n FROM sessions ${sWhere}`),
      events: count(`SELECT COUNT(*) AS n FROM events ${evWhere}`),
      findings: count(`SELECT COUNT(*) AS n FROM findings ${fWhere}`),
      runs: count(`SELECT COUNT(*) AS n FROM runs ${rWhere}`),
      events_by_kind: group(`SELECT kind AS k, COUNT(*) AS n FROM events ${evWhere} GROUP BY kind ORDER BY n DESC`),
      events_by_workflow: group(`SELECT workflow AS k, COUNT(*) AS n FROM events ${evWhere} GROUP BY workflow ORDER BY n DESC`),
      events_by_severity: group(`SELECT severity AS k, COUNT(*) AS n FROM events ${evWhere} GROUP BY severity`),
      findings_by_severity: group(`SELECT COALESCE(severity,'info') AS k, COUNT(*) AS n FROM findings ${fWhere} GROUP BY k`),
      findings_by_category: group(`SELECT COALESCE(category,'EVENT_SEQUENCE') AS k, COUNT(*) AS n FROM findings ${fWhere} GROUP BY k ORDER BY n DESC`),
      runs_by_status: group(`SELECT status AS k, COUNT(*) AS n FROM runs ${rWhere} GROUP BY status`),
      events_by_day: (
        this.#db
          .prepare(`SELECT date((ts + ?) / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM events ${evWhere} GROUP BY day ORDER BY day`)
          .all(offsetMs, ...args) as Array<{ day: string; n: number }>
      ).map((r) => ({ day: r.day, count: r.n })),
    };
  }

  /** Replay runs, newest first, with step outcome counts (no step detail). */
  listRuns(filter: { status?: string | undefined; workflow?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}): {
    total: number;
    runs: ReplayRunSummary[];
  } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.status) {
      where.push("r.status = ?");
      args.push(filter.status);
    }
    if (filter.workflow) {
      where.push("r.workflow = ?");
      args.push(filter.workflow);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM runs r ${clause}`).get(...args) as { n: number }).n;
    const rows = this.#db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.run_id) AS steps_total,
           (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.run_id AND s.status = 'ok') AS steps_ok,
           (SELECT COUNT(*) FROM run_steps s WHERE s.run_id = r.run_id AND s.status = 'failed') AS steps_failed
         FROM runs r ${clause} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, clampLimit(filter.limit, 100), Math.max(0, filter.offset ?? 0)) as Array<Record<string, unknown>>;
    return {
      total,
      runs: rows.map((r) => ({
        runId: r.run_id as string,
        workflow: r.workflow as string,
        mode: r.mode as string,
        status: r.status as string,
        startedAt: r.started_at as number,
        endedAt: (r.ended_at as number | null) ?? null,
        dryRun: r.dry_run === 1,
        sourceSessionId: (r.source_session_id as string | null) ?? null,
        targetKind: r.target ? ((JSON.parse(r.target as string) as { kind?: string }).kind ?? null) : null,
        steps: { total: r.steps_total as number, ok: r.steps_ok as number, failed: r.steps_failed as number },
      })),
    };
  }

  // ---- screenshots (Phase 12) ----

  insertScreenshot(r: ScreenshotRecord): void {
    this.#db
      .prepare(
        `INSERT INTO screenshots(id, session_id, event_id, run_id, step_id, source, sha256, bytes, width, height, mime, ts, workflow, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(r.id, r.session_id, r.event_id, r.run_id, r.step_id, r.source, r.sha256, r.bytes, r.width, r.height, r.mime, r.ts, r.workflow, r.created_at);
  }

  getScreenshot(id: string): ScreenshotRecord | undefined {
    return this.#db.prepare("SELECT * FROM screenshots WHERE id=?").get(id) as ScreenshotRecord | undefined;
  }

  getScreenshotByEvent(eventId: string): ScreenshotRecord | undefined {
    return this.#db.prepare("SELECT * FROM screenshots WHERE event_id=?").get(eventId) as ScreenshotRecord | undefined;
  }

  listScreenshots(filter: { sessionId?: string | undefined; runId?: string | undefined; from?: number | undefined; to?: number | undefined; limit?: number | undefined; offset?: number | undefined } = {}): {
    total: number;
    screenshots: ScreenshotRecord[];
  } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.sessionId) {
      where.push("session_id = ?");
      args.push(filter.sessionId);
    }
    if (filter.runId) {
      where.push("run_id = ?");
      args.push(filter.runId);
    }
    if (filter.from !== undefined) {
      where.push("ts >= ?");
      args.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("ts <= ?");
      args.push(filter.to);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM screenshots ${clause}`).get(...args) as { n: number }).n;
    const screenshots = this.#db
      .prepare(`SELECT * FROM screenshots ${clause} ORDER BY ts DESC, id LIMIT ? OFFSET ?`)
      .all(...args, clampLimit(filter.limit, 100), Math.max(0, filter.offset ?? 0)) as unknown as ScreenshotRecord[];
    return { total, screenshots };
  }

  /** Delete rows; returns the removed records (so their files can be released). */
  deleteScreenshots(where: { id?: string; sessionId?: string; olderThan?: number }): ScreenshotRecord[] {
    let clause: string;
    let arg: string | number;
    if (where.id !== undefined) [clause, arg] = ["id = ?", where.id];
    else if (where.sessionId !== undefined) [clause, arg] = ["session_id = ?", where.sessionId];
    else if (where.olderThan !== undefined) [clause, arg] = ["ts < ?", where.olderThan];
    else return [];
    return this.transaction(() => {
      const rows = this.#db.prepare(`SELECT * FROM screenshots WHERE ${clause}`).all(arg) as unknown as ScreenshotRecord[];
      this.#db.prepare(`DELETE FROM screenshots WHERE ${clause}`).run(arg);
      return rows;
    });
  }

  isScreenshotShaReferenced(sha256: string): boolean {
    return this.#db.prepare("SELECT 1 AS x FROM screenshots WHERE sha256=? LIMIT 1").get(sha256) !== undefined;
  }

  /** Distinct stored images (files) and their total size, plus row count. */
  screenshotUsage(): { count: number; files: number; bytes: number; oldest: number | null } {
    const rows = this.#db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM screenshots").get() as { n: number; oldest: number | null };
    const files = this.#db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes FROM (SELECT sha256, MAX(bytes) AS bytes FROM screenshots GROUP BY sha256)").get() as {
      files: number;
      bytes: number;
    };
    return { count: rows.n, files: files.files, bytes: files.bytes, oldest: rows.oldest ?? null };
  }

  /** One stored event (for binding an uploaded image to its SCREENSHOT event). */
  getStoredEvent(id: string): StoredEventRow | undefined {
    return this.#db.prepare("SELECT * FROM events WHERE id=?").get(id) as StoredEventRow | undefined;
  }

  // ---- maintenance ----

  purgeSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id=?").run(id); // cascades
  }

  vacuum(): void {
    this.#db.exec("VACUUM;");
  }
}
