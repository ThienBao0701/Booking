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

/**
 * Bumped only for BREAKING schema changes. Backward-compatible additions are
 * applied by ADDED_COLUMNS below and keep the version unchanged.
 */
export const SCHEMA_VERSION = 1;

/**
 * Additive, backward-compatible column migrations for databases created before
 * the column existed: [table, column, definition]. Applied only when missing.
 */
export const ADDED_COLUMNS: ReadonlyArray<[string, string, string]> = [
  ["runs", "target", "TEXT"], // target + authorization record per run (traceability)
  // Phase 8: the Component 6 findings table gains the analyzer's finding fields.
  ["findings", "workflow", "TEXT"],
  ["findings", "event_ids", "TEXT NOT NULL DEFAULT '[]'"],
  ["findings", "rule_id", "TEXT"],
  ["findings", "category", "TEXT"],
  ["findings", "severity", "TEXT"],
  ["findings", "description", "TEXT"],
  ["findings", "confidence", "REAL"],
  ["findings", "counter_evidence", "TEXT NOT NULL DEFAULT '[]'"],
  ["findings", "recommended_next_test", "TEXT"],
  ["findings", "created_at", "INTEGER"],
];

/** Indexes over migrated columns (created after ADDED_COLUMNS are applied). */
export const ADDED_INDEXES: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_findings_rule ON findings(rule_id)",
  "CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity)",
  "CREATE INDEX IF NOT EXISTS idx_findings_first_ts ON findings(first_ts)",
];

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
  dry_run           INTEGER NOT NULL DEFAULT 0,
  target            TEXT
);

-- Diagnostics: provenance of each session's stored findings (rule version,
-- analysis time, event count analysed) for stale-finding detection.
CREATE TABLE IF NOT EXISTS analysis_meta (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  analyzed_at   INTEGER NOT NULL,
  rules_version TEXT NOT NULL,
  event_count   INTEGER NOT NULL,
  finding_count INTEGER NOT NULL
);

-- Phase 12: stored screenshot images (files live in <dataDir>/screenshots/<sha256>.png).
CREATE TABLE IF NOT EXISTS screenshots (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  event_id   TEXT,
  run_id     TEXT,
  step_id    TEXT,
  source     TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  workflow   TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_screenshots_session ON screenshots(session_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_ts ON screenshots(ts);
CREATE INDEX IF NOT EXISTS idx_screenshots_sha ON screenshots(sha256);
CREATE UNIQUE INDEX IF NOT EXISTS idx_screenshots_event ON screenshots(event_id) WHERE event_id IS NOT NULL;

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
