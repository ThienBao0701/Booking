import { test } from "node:test";
import assert from "node:assert/strict";

import { Store } from "../src/db/store.ts";
import type { LabEvent } from "../src/shared.ts";

function ev(overrides: Partial<LabEvent> = {}): LabEvent {
  return {
    id: "e" + Math.random().toString(36).slice(2),
    sessionId: "s1",
    seq: 0,
    ts: 1_750_000_000_000,
    kind: "NAVIGATION",
    category: "navigation",
    severity: "info",
    redacted: true,
    data: { urlHost: "mock-extranet.local" },
    ...overrides,
  };
}

test("create/get/list/end session", () => {
  const store = new Store(":memory:");
  store.createSession({ id: "s1", startedAt: 1, mode: "OBSERVE", targetKind: "mock", targetHost: "h" });
  const s = store.getSession("s1");
  assert.equal(s?.sessionId, "s1");
  assert.equal(s?.target.kind, "mock");
  assert.equal(store.listSessions().length, 1);
  assert.ok(store.endSession("s1", 2));
  assert.equal(store.getSession("s1")?.endedAt, 2);
  assert.ok(!store.endSession("missing", 2));
  store.close();
});

test("insertEvent stores and counts", () => {
  const store = new Store(":memory:");
  store.createSession({ id: "s1", startedAt: 1, mode: "OBSERVE", targetKind: "observe" });
  assert.equal(store.insertEvent(ev({ seq: 0 })), "stored");
  assert.equal(store.insertEvent(ev({ seq: 1 })), "stored");
  assert.equal(store.countEvents("s1"), 2);
  const rows = store.getEvents("s1");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.seq, 0);
  assert.equal(rows[0]?.redacted, 1);
  store.close();
});

test("defensive redaction masks sensitive data on write", () => {
  const store = new Store(":memory:");
  store.createSession({ id: "s1", startedAt: 1, mode: "OBSERVE", targetKind: "observe" });
  // Simulate an event that slipped through with an email in a free field.
  store.insertEvent(ev({ data: { note: "reach me at leak@example.com" } }));
  const row = store.getEvents("s1")[0];
  assert.ok(row);
  assert.ok(!row.data.includes("leak@example.com"), "email must be redacted at rest");
  assert.match(row.data, /REDACTED|quarantined/);
  store.close();
});

test("purgeSession cascades to events", () => {
  const store = new Store(":memory:");
  store.createSession({ id: "s1", startedAt: 1, mode: "OBSERVE", targetKind: "observe" });
  store.insertEvent(ev());
  store.purgeSession("s1");
  assert.equal(store.getSession("s1"), undefined);
  assert.equal(store.countEvents("s1"), 0);
  store.close();
});

test("schema version recorded in meta", () => {
  const store = new Store(":memory:");
  assert.equal(store.getMeta("schema_version"), "1");
  store.close();
});
