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

  createSession(s: NewSession): void {
    this.#db
      .prepare(
        `INSERT INTO sessions(id, started_at, mode, target_kind, target_host, metadata)
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
   */
  insertEvent(ev: LabEvent): "stored" | "quarantined" {
    const safeData = redactValue(ev.data);
    let dataStr = JSON.stringify(safeData);
    let quarantined = false;
    if (looksSensitive(dataStr)) {
      dataStr = JSON.stringify({ quarantined: true, reason: "post-redaction sensitive match" });
      quarantined = true;
    }
    this.#db
      .prepare(
        `INSERT INTO events(id, session_id, seq, ts, tab_id, kind, category, workflow, severity, redacted, data)
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

  // ---- maintenance ----

  purgeSession(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id=?").run(id); // cascades
  }

  vacuum(): void {
    this.#db.exec("VACUUM;");
  }
}
