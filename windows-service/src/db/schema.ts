/**
 * SQLite schema + pragmas (docs/08-data-model.md). WAL mode for low-latency
 * concurrent reads and crash safety (Component 16).
 */

export const PRAGMAS = [
  "PRAGMA journal_mode = WAL;",
  "PRAGMA synchronous = NORMAL;",
  "PRAGMA foreign_keys = ON;",
  "PRAGMA busy_timeout = 5000;",
];

export const SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  mode        TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_host TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  tab_id     INTEGER,
  kind       TEXT NOT NULL,
  category   TEXT NOT NULL,
  workflow   TEXT,
  severity   TEXT NOT NULL,
  redacted   INTEGER NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_session_kind ON events(session_id, kind);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_workflow ON events(workflow);

CREATE TABLE IF NOT EXISTS findings (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  observed_pattern     TEXT NOT NULL,
  evidence             TEXT NOT NULL,
  frequency            INTEGER NOT NULL DEFAULT 1,
  context              TEXT NOT NULL DEFAULT '{}',
  possible_explanation TEXT NOT NULL DEFAULT '',
  first_ts             INTEGER NOT NULL,
  last_ts              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id);

CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,
  workflow          TEXT NOT NULL,
  mode              TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  status            TEXT NOT NULL,
  checkpoints       TEXT NOT NULL DEFAULT '[]',
  source_session_id TEXT,
  dry_run           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_id    TEXT NOT NULL,
  status     TEXT NOT NULL,
  started_at INTEGER,
  ended_at   INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  PRIMARY KEY (run_id, step_id)
);
`;
