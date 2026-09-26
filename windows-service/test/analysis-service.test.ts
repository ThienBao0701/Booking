/** AnalysisService: rule configuration, persistence of findings, findings migration. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Store } from "../src/db/store.ts";
import { AnalysisService, loadDefaultRules } from "../src/analysis/service.ts";
import { ENV_A, SessionBuilder, T0, mockFlow, persist } from "./analysis-fixtures.ts";

function setup(): { dir: string; store: Store; svc: AnalysisService; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lab-an-"));
  const store = new Store(":memory:");
  const svc = new AnalysisService({ store, dataDir: dir, now: () => T0 + 1 });
  return {
    dir,
    store,
    svc,
    done: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function oddSession(id: string): SessionBuilder {
  const b = new SessionBuilder(id, { t0: T0 + 10_000_000 });
  b.start(ENV_A);
  b.wait(100).transition("LOGIN");
  for (let i = 0; i < 4; i++) b.wait(200).click("#login-submit", "LOGIN");
  b.add("error", { workflow: "LOGIN", severity: "error", metadata: { message: "x" } });
  b.wait(400_000).click("#b", "LOGIN");
  b.end();
  return b;
}

test("run() persists validated findings; re-running replaces instead of duplicating", () => {
  const { store, svc, done } = setup();
  try {
    for (let i = 0; i < 3; i++) persist(store, mockFlow(`n${i}`, { t0: T0 + i * 1000 }));
    persist(store, oddSession("odd"));
    const s1 = svc.run(["odd"]);
    assert.equal(s1.sessions, 1);
    assert.ok(s1.findings > 0);
    assert.deepEqual(s1.warnings, []);
    const first = store.listFindings({ sessionId: "odd" });
    assert.equal(first.total, s1.findings);
    svc.run(["odd"]);
    const second = store.listFindings({ sessionId: "odd" });
    assert.equal(second.total, first.total, "idempotent");
    assert.deepEqual(second.findings.map((f) => f.finding_id).sort(), first.findings.map((f) => f.finding_id).sort());

    // Stored findings round-trip every contract field.
    const f = store.getFinding(first.findings[0]?.finding_id as string);
    assert.ok(f);
    assert.ok(f.event_ids.length > 0 && f.counter_evidence.length > 0 && f.evidence.length > 0);
    const rows = store.getEventsByIds(f.event_ids);
    assert.equal(rows.length, f.event_ids.length, "every cited event is stored");

    // Filters.
    assert.ok(store.listFindings({ severity: "warn" }).findings.every((x) => x.severity === "warn"));
    assert.equal(store.listFindings({ ruleId: "CNT-ERROR-EVENTS" }).total, 1);
    assert.equal(store.listFindings({ q: "pause" }).findings.every((x) => /pause/i.test(`${x.title} ${x.description} ${x.rule_id}`)), true);
    assert.equal(store.listFindings({ from: T0 + 20_000_000 }).total, 0);
    assert.equal(store.listFindings({ limit: 1 }).findings.length, 1);

    // run() without ids analyses the recent cohort.
    const all = svc.run();
    assert.equal(all.sessions, 4);
  } finally {
    done();
  }
});

test("analyze() returns a full, unpersisted analysis; unknown sessions → undefined", () => {
  const { store, svc, done } = setup();
  try {
    persist(store, mockFlow("a"));
    const r = svc.analyze("a");
    assert.ok(r);
    assert.equal(r.session_id, "a");
    assert.equal(store.listFindings().total, 0, "not persisted");
    assert.equal(svc.analyze("missing"), undefined);
    assert.equal(svc.compare("a", "missing"), undefined);
    assert.equal(svc.graph(["a"]).session_ids[0], "a");
  } finally {
    done();
  }
});

test("rules: custom sets are validated, persisted atomically and survive restart; reset restores defaults", () => {
  const { dir, store, svc, done } = setup();
  try {
    const defaults = svc.rulesInfo();
    assert.equal(defaults.source, "default");
    assert.equal(defaults.error, null);

    const custom = { version: 1, rules: loadDefaultRules().rules.filter((r) => r.id.startsWith("DQ-")) };
    const ok = svc.setRules(custom);
    assert.ok(ok.ok);
    const file = join(dir, "analysis-rules.json");
    assert.ok(existsSync(file));
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(svc.rulesInfo().source, "custom");
    assert.notEqual(svc.rulesInfo().version, defaults.version);

    // Invalid sets are rejected and leave the persisted set untouched.
    const before = readFileSync(file, "utf8");
    const bad = svc.setRules({ version: 1, rules: [{ ...custom.rules[0], title: "This proves enforcement." }] });
    assert.equal(bad.ok, false);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(svc.rules.rules.length, custom.rules.length);

    // Restart: custom rules are loaded.
    const again = new AnalysisService({ store, dataDir: dir });
    assert.equal(again.rulesInfo().source, "custom");
    assert.equal(again.rules.rules.length, custom.rules.length);

    svc.resetRules();
    assert.equal(existsSync(file), false);
    assert.equal(svc.rulesInfo().source, "default");
    assert.equal(svc.rulesInfo().version, defaults.version);
  } finally {
    done();
  }
});

test("rules: an invalid custom file on disk falls back to the defaults (fail closed) and reports why", () => {
  const { dir, store, done } = setup();
  try {
    writeFileSync(join(dir, "analysis-rules.json"), JSON.stringify({ version: 1, rules: [{ id: "X" }] }));
    const svc = new AnalysisService({ store, dataDir: dir });
    const info = svc.rulesInfo();
    assert.equal(info.source, "default");
    assert.match(String(info.error), /custom rules ignored \(invalid\)/);
    writeFileSync(join(dir, "analysis-rules.json"), "{not json");
    assert.match(String(new AnalysisService({ store, dataDir: dir }).rulesInfo().error), /unreadable/);
  } finally {
    done();
  }
});

test("findings table: a pre-Phase-8 database is migrated additively", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-mig-"));
  const path = join(dir, "old.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, mode TEXT NOT NULL,
        target_kind TEXT NOT NULL, target_host TEXT, metadata TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE findings (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        observed_pattern TEXT NOT NULL, evidence TEXT NOT NULL, frequency INTEGER NOT NULL DEFAULT 1,
        context TEXT NOT NULL DEFAULT '{}', possible_explanation TEXT NOT NULL DEFAULT '', first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL);
      INSERT INTO sessions(id, started_at, mode, target_kind) VALUES ('legacy', 1, 'OBSERVE', 'observe');
      INSERT INTO findings(id, session_id, observed_pattern, evidence, first_ts, last_ts) VALUES ('f-old', 'legacy', 'old pattern', '[]', 1, 2);
    `);
    old.close();

    const store = new Store(path);
    try {
      const legacy = store.getFinding("f-old");
      assert.ok(legacy, "legacy rows stay readable");
      assert.equal(legacy.title, "old pattern");
      assert.deepEqual(legacy.event_ids, []);
      persist(store, oddSession("new"));
      const svc = new AnalysisService({ store });
      assert.ok(svc.run(["new"]).findings > 0);
      assert.ok(store.listFindings({ sessionId: "new" }).total > 0);
      assert.equal(store.getMeta("schema_version"), "1", "additive migration keeps the schema version");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
