/** Session comparison + cross-session inputs. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { compare } from "../src/analysis/analyzer.ts";
import { environmentDifferences, lcs } from "../src/analysis/compare.ts";
import { ENV_A, SessionBuilder, mockFlow } from "./analysis-fixtures.ts";

test("lcs: longest common subsequence of workflow labels", () => {
  assert.deepEqual(lcs(["A", "B", "C", "D"], ["A", "C", "D"]), ["A", "C", "D"]);
  assert.deepEqual(lcs(["A", "B"], ["C", "D"]), []);
  assert.deepEqual(lcs([], ["A"]), []);
  assert.deepEqual(lcs(["X", "A", "Y", "B"], ["A", "B", "X"]), ["A", "B"]);
});

test("identical recordings compare as fully similar", () => {
  const c = compare(mockFlow("a", { env: ENV_A }).build(), mockFlow("b", { env: ENV_A }).build());
  assert.equal(c.a, "a");
  assert.equal(c.b, "b");
  assert.equal(c.similarity, 1);
  assert.deepEqual(c.workflow_sequence.only_a, []);
  assert.deepEqual(c.workflow_sequence.only_b, []);
  assert.deepEqual(c.workflow_sequence.common, c.workflow_sequence.a);
  assert.equal(c.actions.jaccard, 1);
  assert.deepEqual(c.environment_differences, []);
  for (const w of c.workflows) assert.equal(w.delta_ms, 0, w.workflow);
});

test("different pacing shows as per-workflow deltas and ratios, not as a sequence change", () => {
  const c = compare(mockFlow("fast").build(), mockFlow("slow", { pace: 2 }).build());
  assert.equal(c.workflow_sequence.common.length, c.workflow_sequence.a.length);
  const res = c.workflows.find((w) => w.workflow === "PROPERTY_SETUP");
  assert.ok(res && res.a_ms !== null && res.b_ms !== null);
  assert.ok((res.delta_ms as number) > 0);
  assert.ok((res.ratio as number) > 1.5);
  assert.ok(c.timing.b_median_gap_ms >= c.timing.a_median_gap_ms);
  assert.ok(c.notes.some((n) => /Environment was not captured/.test(n)));
});

test("different paths: common subsequence, only_a / only_b, action differences", () => {
  const b = new SessionBuilder("short");
  b.start(ENV_A);
  b.wait(1000).transition("LOGIN");
  b.wait(1000).click("#login-submit", "LOGIN");
  b.wait(1000).click('button[data-view="rates"]', "LOGIN");
  b.transition("RATE_SETUP", "LOGIN");
  b.wait(1000).click("#rate-submit", "RATE_SETUP");
  b.end();
  const c = compare(mockFlow("full", { env: ENV_A }).build(), b.build());
  assert.deepEqual(c.workflow_sequence.common, ["LOGIN"]);
  assert.ok(c.workflow_sequence.only_a.includes("RESERVATION"));
  assert.deepEqual(c.workflow_sequence.only_b, ["RATE_SETUP"]);
  assert.ok(c.actions.only_b.includes("click:#rate-submit"));
  assert.ok(c.actions.only_a.includes("click:#res-submit"));
  assert.ok(c.similarity > 0 && c.similarity < 0.5, String(c.similarity));
  assert.ok(c.notes.some((n) => /fewer than 10 events/.test(n)));
  const rate = c.workflows.find((w) => w.workflow === "RATE_SETUP");
  assert.equal(rate?.a_ms, null);
  assert.equal(rate?.delta_ms, null);
});

test("environment differences are listed field by field; target-kind mismatch is noted", () => {
  const mk = (id: string, viewport: { width: number; height: number }, tz: string, target: "mock" | "observe") => {
    const b = new SessionBuilder(id, { target });
    b.start({ ...ENV_A, timezone: tz });
    b.wait(100).transition("LOGIN");
    b.add("page_state", { workflow: "LOGIN", metadata: { environment: { viewport } } });
    b.end();
    return b.build();
  };
  const c = compare(mk("x", { width: 1280, height: 720 }, "Europe/Amsterdam", "mock"), mk("y", { width: 800, height: 600 }, "Asia/Ho_Chi_Minh", "observe"));
  const fields = c.environment_differences.map((d) => d.field).sort();
  assert.deepEqual(fields, ["timezone", "viewport"]);
  const vp = c.environment_differences.find((d) => d.field === "viewport");
  assert.deepEqual(vp?.b, { width: 800, height: 600 });
  assert.ok(c.notes.some((n) => /different target kinds \(mock vs observe\)/.test(n)));
  assert.deepEqual(
    environmentDifferences({ session_id: "p", captured: false, session_duration_ms: 0, source_event_ids: [] }, { session_id: "q", captured: false, session_duration_ms: 0, source_event_ids: [] }),
    [],
  );
});

test("error counts are compared", () => {
  const b = mockFlow("err");
  b.add("error", { workflow: "REPORTING", severity: "error", metadata: { message: "x" } });
  const c = compare(mockFlow("ok").build(), b.build());
  assert.equal(c.counts.a_errors, 0);
  assert.equal(c.counts.b_errors, 1);
});
