import { test } from "node:test";
import assert from "node:assert/strict";

import { validateWorkflowFile, authorizeRun } from "../src/replay/validate.ts";
import type { WorkflowFile } from "../src/replay/types.ts";

function mockFile(overrides: Partial<WorkflowFile> = {}): Record<string, unknown> {
  return {
    workflow: "reservation-test",
    version: 1,
    target: { kind: "mock", baseUrl: "http://127.0.0.1:4599" },
    defaults: { timeoutMs: 10000, retries: 1 },
    steps: [
      { id: "s1", action: "navigate", target: "/login" },
      { id: "s2", action: "type", target: "#user", value: "TEST_VALUE" },
      { id: "s3", action: "click", target: "#submit", checkpoint: true },
    ],
    ...overrides,
  };
}

test("valid mock workflow file passes", () => {
  const r = validateWorkflowFile(mockFile());
  assert.ok(r.ok);
});

test("duplicate step ids rejected", () => {
  const r = validateWorkflowFile(
    mockFile({
      steps: [
        { id: "s1", action: "navigate", target: "/a" },
        { id: "s1", action: "reload" },
      ],
    } as Partial<WorkflowFile>),
  );
  assert.ok(!r.ok);
  assert.ok((r as { errors: string[] }).errors.some((e) => e.includes("duplicate")));
});

test("navigate without target rejected", () => {
  const r = validateWorkflowFile(
    mockFile({ steps: [{ id: "s1", action: "navigate" }] } as Partial<WorkflowFile>),
  );
  assert.ok(!r.ok);
});

test("invalid target kind rejected", () => {
  const r = validateWorkflowFile(
    mockFile({ target: { kind: "production", baseUrl: "https://real" } as never }),
  );
  assert.ok(!r.ok);
});

test("authorizeRun applies the target guard", () => {
  const r = validateWorkflowFile(mockFile());
  assert.ok(r.ok);
  if (!r.ok) return;
  // mock target: denied in OBSERVE, allowed in SIMULATE.
  assert.equal(authorizeRun(r.value, "OBSERVE").allowed, false);
  assert.equal(authorizeRun(r.value, "SIMULATE").allowed, true);
});

test("authorized target needs AUTHORIZED_AUTOMATION + record", () => {
  const file = validateWorkflowFile(
    mockFile({
      target: {
        kind: "authorized",
        baseUrl: "https://staging.example.test",
        authorization: {
          owner: "me",
          system: "staging",
          grantedBy: "self",
          acknowledgedAt: 1_750_000_000_000,
        },
      },
    }),
  );
  assert.ok(file.ok);
  if (!file.ok) return;
  assert.equal(authorizeRun(file.value, "SIMULATE").allowed, false);
  assert.equal(authorizeRun(file.value, "AUTHORIZED_AUTOMATION").allowed, true);
});
