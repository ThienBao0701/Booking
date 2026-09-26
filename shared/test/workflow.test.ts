import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSessionRecord } from "../src/workflow/validate.ts";
import { WORKFLOW_LABELS, isWorkflowLabel } from "../src/workflow/types.ts";

test("workflow labels include the Extranet set + UNKNOWN", () => {
  for (const l of [
    "LOGIN",
    "PROPERTY_SETUP",
    "ROOM_SETUP",
    "RATE_SETUP",
    "RESERVATION",
    "CANCELLATION",
    "MESSAGING",
    "REVIEW",
    "PHOTO",
    "REPORTING",
    "UNKNOWN",
  ]) {
    assert.ok(isWorkflowLabel(l), `${l} should be a label`);
  }
  assert.equal(WORKFLOW_LABELS.length, 11);
});

test("valid session record passes", () => {
  const rec = {
    sessionId: "s1",
    startedAt: 1,
    mode: "OBSERVE",
    target: { kind: "mock", host: "mock-extranet.local" },
    tabs: [{ tabId: 1, openedAt: 1 }],
    timeline: [{ ts: 2, workflow: "LOGIN", eventId: "e1" }],
    metadata: {},
  };
  assert.ok(validateSessionRecord(rec).ok);
});

test("bad timeline entry rejected", () => {
  const rec = {
    sessionId: "s1",
    startedAt: 1,
    mode: "OBSERVE",
    target: { kind: "mock" },
    tabs: [],
    timeline: [{ ts: 2, workflow: "SIGNIN", eventId: "e1" }],
    metadata: {},
  };
  const r = validateSessionRecord(rec);
  assert.ok(!r.ok);
});

test("missing target rejected", () => {
  const r = validateSessionRecord({
    sessionId: "s1",
    startedAt: 1,
    mode: "OBSERVE",
    tabs: [],
    timeline: [],
    metadata: {},
  });
  assert.ok(!r.ok);
});
