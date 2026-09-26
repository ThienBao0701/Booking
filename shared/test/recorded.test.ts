import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type RecordedEvent,
  toLabEvent,
  fromLabEvent,
  toValidLabEvent,
  validateRecordedEvent,
  kindForAction,
  RECORDED_ACTIONS,
} from "../src/events/recorded.ts";
import { validateEvent } from "../src/events/validate.ts";

function rec(overrides: Partial<RecordedEvent> = {}): RecordedEvent {
  return {
    event_id: "01J0000000000000000000000A",
    session_id: "session_x",
    seq: 3,
    timestamp: 1_750_000_000_000,
    tab_id: 7,
    page: "/reservations",
    workflow: "RESERVATION",
    action: "click",
    target: { tag: "button", selector: "#res-submit", label: "Create reservation" },
    metadata: { view: "reservations" },
    ...overrides,
  };
}

test("every recorder action maps to a valid event kind", () => {
  for (const a of RECORDED_ACTIONS) assert.ok(typeof kindForAction(a) === "string");
});

test("toLabEvent produces a contract-valid, redacted LabEvent", () => {
  const lab = toLabEvent(rec());
  assert.equal(lab.redacted, true);
  assert.equal(lab.kind, "CLICK");
  assert.equal(lab.category, "interaction");
  assert.equal(lab.tabId, 7);
  assert.equal(lab.data.page, "/reservations");
  assert.ok(validateEvent(lab).ok);
});

test("round trip LabEvent -> RecordedEvent preserves the standardized fields", () => {
  const original = rec();
  const back = fromLabEvent(toLabEvent(original));
  assert.equal(back.event_id, original.event_id);
  assert.equal(back.session_id, original.session_id);
  assert.equal(back.timestamp, original.timestamp);
  assert.equal(back.tab_id, original.tab_id);
  assert.equal(back.page, original.page);
  assert.equal(back.workflow, original.workflow);
  assert.equal(back.action, original.action);
  assert.deepEqual(back.target, original.target);
  assert.deepEqual(back.metadata, original.metadata);
});

test("toLabEvent redacts secrets in metadata/target/page by construction", () => {
  const lab = toLabEvent(
    rec({
      page: "/guest/a.b@example.com",
      target: { label: "mail leak@example.com", name: "password" },
      metadata: { password: "hunter2", note: "call +1 415 555 2671" },
    }),
  );
  const json = JSON.stringify(lab);
  assert.ok(!json.includes("a.b@example.com"));
  assert.ok(!json.includes("leak@example.com"));
  assert.ok(!json.includes("hunter2"));
  assert.ok(!json.includes("555 2671"));
});

test("ERROR actions default to error severity", () => {
  assert.equal(toLabEvent(rec({ action: "error" })).severity, "error");
});

test("validateRecordedEvent rejects bad shapes", () => {
  assert.ok(!validateRecordedEvent({ ...rec(), action: "hack" }).ok);
  assert.ok(!validateRecordedEvent({ ...rec(), workflow: "SIGNIN" }).ok);
  assert.ok(!validateRecordedEvent({ ...rec(), seq: -1 }).ok);
  assert.ok(!validateRecordedEvent({ ...rec(), metadata: null }).ok);
  assert.ok(validateRecordedEvent(rec()).ok);
});

test("toValidLabEvent validates shape then wire contract", () => {
  assert.ok(toValidLabEvent(rec()).ok);
  assert.ok(!toValidLabEvent({ ...rec(), event_id: "" }).ok);
});

test("fromLabEvent tolerates non-recorder LabEvents", () => {
  const back = fromLabEvent({
    id: "x",
    sessionId: "s",
    seq: 0,
    ts: 1,
    kind: "NAVIGATION",
    category: "navigation",
    severity: "info",
    redacted: true,
    data: {},
  });
  assert.equal(back.action, "navigate");
  assert.equal(back.workflow, "UNKNOWN");
  assert.equal(back.page, "");
});
