import { test } from "node:test";
import assert from "node:assert/strict";

import { validateEvent, validateEventBatch } from "../src/events/validate.ts";
import type { LabEvent } from "../src/events/types.ts";

function baseEvent(overrides: Partial<LabEvent> = {}): Record<string, unknown> {
  return {
    id: "01J0000000000000000000000A",
    sessionId: "sess-1",
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

test("valid event passes", () => {
  const r = validateEvent(baseEvent());
  assert.ok(r.ok);
});

test("un-redacted event is rejected (privacy invariant)", () => {
  const r = validateEvent(baseEvent({ redacted: false }));
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("redacted")));
});

test("invalid kind / category / severity rejected", () => {
  assert.ok(!validateEvent(baseEvent({ kind: "HACK" as never })).ok);
  assert.ok(!validateEvent(baseEvent({ category: "nope" as never })).ok);
  assert.ok(!validateEvent(baseEvent({ severity: "fatal" as never })).ok);
});

test("workflow label validated when present", () => {
  assert.ok(validateEvent(baseEvent({ workflow: "LOGIN" })).ok);
  assert.ok(!validateEvent(baseEvent({ workflow: "SIGNIN" as never })).ok);
});

test("missing required fields rejected", () => {
  const r = validateEvent(baseEvent({ id: "" }));
  assert.ok(!r.ok);
});

test("batch validation partitions valid/invalid", () => {
  const { valid, invalid } = validateEventBatch([
    baseEvent(),
    baseEvent({ redacted: false }),
    "not an object",
  ]);
  assert.equal(valid.length, 1);
  assert.equal(invalid.length, 2);
  assert.equal(invalid[0]?.index, 1);
});
