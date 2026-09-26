import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/db/store.ts";
import type { LabEvent } from "../src/shared.ts";

function ev(seq: number): LabEvent {
  return {
    id: "e" + seq,
    sessionId: "s1",
    seq,
    ts: 1_750_000_000_000 + seq,
    kind: "NAVIGATION",
    category: "navigation",
    severity: "info",
    redacted: true,
    data: { seq },
  };
}

test("data survives a store close/reopen on disk (WAL crash-safety proxy)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-recovery-"));
  const dbPath = join(dir, "lab.sqlite");
  try {
    // First "process": write data, then close (simulating a clean stop).
    const s1 = new Store(dbPath);
    s1.createSession({ id: "s1", startedAt: 1, mode: "OBSERVE", targetKind: "observe" });
    for (let i = 0; i < 5; i++) s1.insertEvent(ev(i));
    assert.equal(s1.countEvents("s1"), 5);
    s1.close();

    // Second "process": reopen the same file — data must be intact.
    const s2 = new Store(dbPath);
    assert.equal(s2.getSession("s1")?.sessionId, "s1");
    assert.equal(s2.countEvents("s1"), 5);
    const rows = s2.getEvents("s1");
    assert.equal(rows.length, 5);
    assert.equal(rows[4]?.seq, 4);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening without prior clean vacuum still reads committed rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-recovery2-"));
  const dbPath = join(dir, "lab.sqlite");
  try {
    const s1 = new Store(dbPath);
    s1.createSession({ id: "s1", startedAt: 1, mode: "OBSERVE", targetKind: "observe" });
    s1.insertEvent(ev(0));
    // Intentionally do NOT close cleanly first — open a second handle.
    const s2 = new Store(dbPath);
    assert.ok(s2.countEvents("s1") >= 1);
    s1.close();
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
