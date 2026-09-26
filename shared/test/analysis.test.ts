import { test } from "node:test";
import assert from "node:assert/strict";

import { validateFinding, validateRule, validateRuleSet } from "../src/analysis/validate.ts";
import { ANALYSIS_DISCLAIMER, PLATFORM_CAVEAT, findConclusiveClaims, isNonConclusive } from "../src/analysis/language.ts";
import type { Finding } from "../src/analysis/types.ts";

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "TEST-RULE",
    version: 1,
    category: "TIMING",
    severity: "info",
    title: "Pause of {{gap_s}} s",
    description: "A pause of {{gap_s}} s (threshold {{threshold_s}} s) was recorded.",
    possible_explanation: "The operator may have been reading or away.",
    recommended_next_test: "Replay the same steps against the mock and compare the pause.",
    confidence: 0.5,
    when: { type: "gap", min_ms: 1000 },
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: "fnd_0123456789abcdef0123",
    session_id: "s1",
    workflow: "LOGIN",
    event_ids: ["e1"],
    timestamp_range: { start: 1, end: 2 },
    rule_id: "TEST-RULE",
    category: "TIMING",
    severity: "info",
    title: "Pause",
    description: "A pause was recorded.",
    evidence: [{ event_id: "e1", seq: 0, timestamp: 1, kind: "CLICK", action: "click", workflow: "LOGIN", page: "/", summary: "click", role: "trigger" }],
    confidence: 0.5,
    counter_evidence: [PLATFORM_CAVEAT],
    recommended_next_test: "Replay against the mock.",
    frequency: 1,
    context: {},
    possible_explanation: "Operator pause.",
    created_at: 3,
    ...overrides,
  };
}

test("language guard: neutral diagnostic wording passes", () => {
  for (const ok of [
    "A reservation step was followed by a cancellation within 12 s.",
    "The click on #save was detected by the recorder and followed by a DOM change.",
    "The operator confirms the booking form after 3 s.",
    "Compare the pause length with a replay against the local mock.",
  ]) {
    assert.deepEqual(findConclusiveClaims(ok), [], ok);
    assert.equal(isNonConclusive(ok), true);
  }
});

test("language guard: conclusive or platform-enforcement wording is rejected", () => {
  for (const bad of [
    "This proves the automation was noticed.",
    "The account was flagged after this sequence.",
    "This pattern caused the listing ranking to drop.",
    "Pattern detected by the platform's bot detection.",
    "This confirms the account is restricted.",
    "Evidence of enforcement by the marketplace.",
    "The property will be suspended if this repeats.",
    "Booking penalized the partner.",
    "Leads to a shadow ban.",
  ]) {
    assert.ok(findConclusiveClaims(bad).length > 0, bad);
  }
});

test("caveat and disclaimer are fixed, non-empty engine texts", () => {
  assert.match(PLATFORM_CAVEAT, /cannot observe/);
  assert.match(ANALYSIS_DISCLAIMER, /do not show/);
});

test("validateRule accepts a well-formed rule", () => {
  assert.deepEqual(validateRule(rule()), []);
});

test("validateRule rejects conclusive wording in any template", () => {
  for (const field of ["title", "description", "possible_explanation", "recommended_next_test"]) {
    const errs = validateRule(rule({ [field]: "This proves enforcement." }));
    assert.ok(errs.some((e) => e.includes(field) && e.includes("non-conclusive")), `${field}: ${errs.join("; ")}`);
  }
  const errs = validateRule(rule({ counter_evidence: ["The account was banned."] }));
  assert.ok(errs.some((e) => e.includes("counter_evidence[0]")));
});

test("validateRule rejects unknown placeholders, bad ids, certainty and bad conditions", () => {
  assert.ok(validateRule(rule({ title: "{{secret}}" })).some((e) => e.includes("unknown placeholder")));
  assert.ok(validateRule(rule({ id: "lowercase" })).some((e) => e.includes(".id")));
  assert.ok(validateRule(rule({ confidence: 1 })).some((e) => e.includes("never certain")));
  assert.ok(validateRule(rule({ confidence: 0 })).length > 0);
  assert.ok(validateRule(rule({ when: { type: "nope" } })).some((e) => e.includes("when.type")));
  assert.ok(validateRule(rule({ when: { type: "gap" } })).some((e) => e.includes("min_ms")));
  assert.ok(validateRule(rule({ when: { type: "sequence", steps: [{ kind: "CLICK" }] } })).some((e) => e.includes("steps")));
  assert.ok(validateRule(rule({ when: { type: "count", match: {}, min: 1 } })).some((e) => e.includes("at least one field")));
  assert.ok(validateRule(rule({ when: { type: "count", match: { target: "(" }, min: 1 } })).some((e) => e.includes("invalid regex")));
  assert.ok(validateRule(rule({ when: { type: "count", match: { kind: "BOGUS" }, min: 1 } })).some((e) => e.includes("unknown event kind")));
  assert.ok(validateRule(rule({ when: { type: "outlier", metric: "inter_event_gap", z: 1 } })).some((e) => e.includes(".z")));
  assert.ok(validateRule(rule({ when: { type: "repeated_sequence", min_length: 1, max_length: 3, min_count: 2 } })).length > 0);
  assert.ok(validateRule(rule({ when: { type: "cross_session", pattern: "workflow_bigram", min_sessions: 2, max_share: 2 } })).length > 0);
  assert.ok(validateRule(rule({ when: { type: "duration" } })).some((e) => e.includes("min_ms or max_ms")));
  assert.ok(validateRule(rule({ when: { type: "data_quality", check: "x" } })).length > 0);
});

test("validateRuleSet fails closed on shape, duplicates and any invalid rule", () => {
  assert.equal(validateRuleSet({ rules: [] }).ok, false);
  assert.equal(validateRuleSet({ version: 2, rules: [] }).ok, false);
  assert.equal(validateRuleSet({ version: 1, rules: [rule(), rule()] }).ok, false);
  assert.equal(validateRuleSet({ version: 1, rules: [rule(), rule({ id: "OTHER", title: "proof" })] }).ok, false);
  const ok = validateRuleSet({ version: 1, rules: [rule(), rule({ id: "OTHER" })] });
  assert.equal(ok.ok, true);
});

test("validateFinding enforces traceability and wording", () => {
  assert.equal(validateFinding(finding()).ok, true);
  assert.equal(validateFinding(finding({ event_ids: [] })).ok, false);
  const missing = validateFinding(finding({ event_ids: ["e1", "e2"] }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.ok(missing.errors.some((e) => e.includes("e2")));
  assert.equal(validateFinding(finding({ counter_evidence: [] })).ok, false);
  assert.equal(validateFinding(finding({ confidence: 1 })).ok, false);
  assert.equal(validateFinding(finding({ timestamp_range: { start: 5, end: 1 } })).ok, false);
  assert.equal(validateFinding(finding({ description: "This proves the account was flagged." })).ok, false);
});
