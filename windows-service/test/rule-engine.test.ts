/** JSON rule engine: every condition type, matchers and cohort-based rules. */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { AnalysisRule, RuleCondition } from "../src/shared.ts";
import type { SessionData } from "../src/analysis/model.ts";
import { segmentSession, workflowSequence } from "../src/analysis/segment.ts";
import { type EvalContext, evaluateRule, matches } from "../src/analysis/rules/engine.ts";
import { SessionBuilder, mockFlow } from "./analysis-fixtures.ts";

function rule(when: RuleCondition, id = "TEST-RULE"): AnalysisRule {
  return {
    id,
    version: 1,
    category: "EVENT_SEQUENCE",
    severity: "info",
    title: "t",
    description: "d",
    possible_explanation: "p",
    recommended_next_test: "n",
    confidence: 0.5,
    when,
  };
}

function prep(d: SessionData) {
  const segments = segmentSession(d);
  return { session_id: d.session.sessionId, data: d, segments, sequence: workflowSequence(segments) };
}

function ctxOf(subject: SessionBuilder, cohort: SessionBuilder[] = []): EvalContext {
  const p = prep(subject.build());
  return { data: p.data, segments: p.segments, sequence: p.sequence, cohort: cohort.map((c) => prep(c.build())) };
}

const ids = (m: { events: Array<{ event_id: string }> }) => m.events.map((e) => e.event_id);

test("matchers: kind/action/workflow lists, target + page regex, metadata equality", () => {
  const b = new SessionBuilder("m");
  b.start();
  b.add("click", { workflow: "RESERVATION", page: "/reservations", target: { tag: "button", selector: "#res-submit", label: "Save" } });
  b.change("#pwd", "LOGIN", { filled: false, sensitive: true, inputType: "password" });
  const [, click, change] = b.build().events;
  assert.ok(click && change);
  assert.equal(matches({ kind: "CLICK" }, click), true);
  assert.equal(matches({ action: ["click", "submit"] }, click), true);
  assert.equal(matches({ workflow: "LOGIN" }, click), false);
  assert.equal(matches({ target: "submit|save" }, click), true);
  assert.equal(matches({ target: "^#cancel" }, click), false);
  assert.equal(matches({ page: "^/reserv" }, click), true);
  assert.equal(matches({ metadata: { sensitive: true } }, change), true);
  assert.equal(matches({ metadata: { sensitive: true } }, click), false);
});

test("sequence: ordered steps within a window, same tab", () => {
  const ctx = ctxOf(mockFlow("seq"));
  const steps = [
    { kind: "WORKFLOW_TRANSITION" as const, workflow: "RESERVATION" as const },
    { kind: "WORKFLOW_TRANSITION" as const, workflow: "CANCELLATION" as const },
  ];
  const hit = evaluateRule(rule({ type: "sequence", steps, within_ms: 120_000, same_tab: true }), ctx);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.events.length, 2);
  assert.equal(hit[0]?.events[0]?.workflow, "RESERVATION");
  assert.equal(hit[0]?.events[1]?.workflow, "CANCELLATION");
  // RESERVATION → CANCELLATION takes ~10 s in the fixture: a 5 s window does not match.
  assert.equal(evaluateRule(rule({ type: "sequence", steps, within_ms: 5000 }), ctx).length, 0);
  // Reverse order is not a match (CANCELLATION → RESERVATION happens, but then no later CANCELLATION).
  assert.equal(evaluateRule(rule({ type: "sequence", steps: [steps[1], steps[0], steps[1]] as typeof steps }), ctx).length, 0);
});

test("repetition: densest burst of the same control; consecutive runs break on another action", () => {
  const b = new SessionBuilder("rep");
  b.start();
  for (let i = 0; i < 4; i++) b.wait(500).click("#save", "PROPERTY_SETUP");
  b.wait(500).click("#other", "PROPERTY_SETUP");
  b.wait(500).click("#save", "PROPERTY_SETUP");
  const r = rule({ type: "repetition", match: { action: "click" }, min_count: 3, within_ms: 5000, consecutive: true });
  const hit = evaluateRule(r, ctxOf(b));
  assert.equal(hit.length, 1, "only #save repeats");
  assert.equal(hit[0]?.vars.count, 4, "the run after #other is a separate, shorter run");
  assert.equal(hit[0]?.vars.pattern, "click:#save");
  // Without `consecutive`, all five #save clicks fall in a 5 s window.
  const loose = evaluateRule(rule({ type: "repetition", match: { action: "click" }, min_count: 3, within_ms: 5000 }), ctxOf(b));
  assert.equal(loose[0]?.vars.count, 5);
  // A tight window only captures part of the burst.
  const tight = evaluateRule(rule({ type: "repetition", match: { action: "click" }, min_count: 3, within_ms: 1000, consecutive: true }), ctxOf(b));
  assert.equal(tight[0]?.vars.count, 3);
});

test("repeated_sequence: a multi-step operator loop is detected with its occurrences", () => {
  const b = new SessionBuilder("loop");
  b.start();
  for (let i = 0; i < 3; i++) {
    b.wait(1000).click('button[data-view="rooms"]', "ROOM_SETUP");
    b.wait(1000).change("#room-name", "ROOM_SETUP");
    b.wait(1000).click("#room-submit", "ROOM_SETUP");
  }
  const hit = evaluateRule(rule({ type: "repeated_sequence", min_length: 3, max_length: 4, min_count: 3 }), ctxOf(b));
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.vars.count, 3);
  assert.equal(hit[0]?.vars.length, 3);
  assert.equal(hit[0]?.events.length, 9, "every occurrence's events are cited");
  assert.equal(evaluateRule(rule({ type: "repeated_sequence", min_length: 3, max_length: 4, min_count: 4 }), ctxOf(b)).length, 0);
});

test("gap: pauses above a threshold, optionally anchored by matchers", () => {
  const b = new SessionBuilder("gap");
  b.start();
  b.wait(1000).click("#a", "LOGIN");
  b.wait(400_000).click("#b", "LOGIN");
  const hit = evaluateRule(rule({ type: "gap", min_ms: 300_000 }), ctxOf(b));
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.vars.gap_s, 400);
  assert.equal(evaluateRule(rule({ type: "gap", min_ms: 300_000, before: { target: "#c" } }), ctxOf(b)).length, 0);
});

test("duration: segments shorter / longer than bounds, honouring min_events", () => {
  const b = new SessionBuilder("dur");
  b.start();
  b.wait(100).transition("RESERVATION");
  b.click("#r1", "RESERVATION");
  b.change("#r2", "RESERVATION");
  b.wait(200).click("#r3", "RESERVATION");
  b.wait(200).transition("REPORTING", "RESERVATION");
  b.wait(700_000).click("#rep", "REPORTING");
  const ctx = ctxOf(b);
  const short = evaluateRule(rule({ type: "duration", workflow: "RESERVATION", min_ms: 1500, min_events: 4 }), ctx);
  assert.equal(short.length, 1);
  assert.equal(short[0]?.workflow, "RESERVATION");
  assert.equal(evaluateRule(rule({ type: "duration", workflow: "RESERVATION", min_ms: 1500, min_events: 10 }), ctx).length, 0);
  const long = evaluateRule(rule({ type: "duration", max_ms: 600_000 }), ctx);
  assert.equal(long.length, 1);
  assert.equal(long[0]?.workflow, "REPORTING");
});

test("count: fires only when matching events exist and bounds hold", () => {
  const b = new SessionBuilder("cnt");
  b.start();
  b.add("error", { workflow: "RESERVATION", severity: "error", metadata: { message: "boom" } });
  b.add("error", { workflow: "RESERVATION", severity: "error", metadata: { message: "boom" } });
  const ctx = ctxOf(b);
  const hit = evaluateRule(rule({ type: "count", match: { severity: "error" }, min: 1 }), ctx);
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.vars.count, 2);
  assert.equal(evaluateRule(rule({ type: "count", match: { severity: "error" }, min: 3 }), ctx).length, 0);
  assert.equal(evaluateRule(rule({ type: "count", match: { severity: "error" }, max: 1 }), ctx).length, 0);
  // `max` alone never fires on zero matches (a finding must cite events).
  assert.equal(evaluateRule(rule({ type: "count", match: { kind: "SCREENSHOT" }, max: 5 }), ctx).length, 0);
});

test("rate: densest window over a threshold", () => {
  const b = new SessionBuilder("rate");
  b.start();
  for (let i = 0; i < 9; i++) b.wait(150).click(`#c${i}`, "RATE_SETUP");
  const hit = evaluateRule(rule({ type: "rate", match: { action: "click" }, window_ms: 2000, min_count: 8 }), ctxOf(b));
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.vars.count, 9);
  assert.equal(evaluateRule(rule({ type: "rate", match: { action: "click" }, window_ms: 500, min_count: 8 }), ctxOf(b)).length, 0);
});

test("absence: expected follow-up missing, judged only when the window was observed", () => {
  const cond: RuleCondition = { type: "absence", after: { kind: "CLICK", target: "submit" }, expect: { kind: "DOM_CHANGE" }, within_ms: 5000 };
  const missing = new SessionBuilder("abs1");
  missing.start();
  const click = missing.wait(100).click("#prop-submit", "PROPERTY_SETUP");
  missing.wait(8000).click("#next", "PROPERTY_SETUP");
  const hit = evaluateRule(rule(cond), ctxOf(missing));
  assert.deepEqual(hit.map(ids), [[click]]);

  const present = new SessionBuilder("abs2");
  present.start();
  present.wait(100).click("#prop-submit", "PROPERTY_SETUP");
  present.wait(300).dom("PROPERTY_SETUP");
  present.wait(8000).click("#next", "PROPERTY_SETUP");
  assert.equal(evaluateRule(rule(cond), ctxOf(present)).length, 0);

  const truncated = new SessionBuilder("abs3");
  truncated.start();
  truncated.wait(100).click("#prop-submit", "PROPERTY_SETUP");
  truncated.wait(1000).click("#next", "PROPERTY_SETUP");
  assert.equal(evaluateRule(rule(cond), ctxOf(truncated)).length, 0, "window not fully observed → no judgement");
});

test("outlier(inter_event_gap): robust z-score with an absolute floor", () => {
  const b = new SessionBuilder("out");
  b.start();
  for (let i = 0; i < 20; i++) b.wait(1000 + (i % 3) * 200).click(`#x${i}`, "ROOM_SETUP");
  b.wait(60_000).click("#late", "ROOM_SETUP");
  const hit = evaluateRule(rule({ type: "outlier", metric: "inter_event_gap", z: 3.5, min_samples: 12, min_ms: 10_000 }), ctxOf(b));
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.vars.gap_s, 60);
  // The floor suppresses statistically unusual but short pauses.
  assert.equal(evaluateRule(rule({ type: "outlier", metric: "inter_event_gap", min_ms: 120_000 }), ctxOf(b)).length, 0);
  // Too few samples → no judgement.
  assert.equal(evaluateRule(rule({ type: "outlier", metric: "inter_event_gap", min_samples: 100 }), ctxOf(b)).length, 0);
});

test("outlier(segment_duration): compares against the same workflow in the cohort", () => {
  const cohort = [0, 1, 2, 3, 4].map((i) => mockFlow(`c${i}`, { pace: 1 + i * 0.05 }));
  const slow = mockFlow("slow", { pace: 10 });
  const hit = evaluateRule(rule({ type: "outlier", metric: "segment_duration", z: 3.5, min_samples: 4 }), ctxOf(slow, cohort));
  assert.ok(hit.length > 0);
  for (const m of hit) {
    assert.equal(m.vars.metric, "segment_duration");
    assert.ok((m.context?.baseline_samples as number) >= 4);
  }
  // Same pace as the cohort → nothing unusual.
  assert.equal(evaluateRule(rule({ type: "outlier", metric: "segment_duration" }), ctxOf(mockFlow("same"), cohort)).length, 0);
  // No cohort → no baseline → no judgement.
  assert.equal(evaluateRule(rule({ type: "outlier", metric: "segment_duration" }), ctxOf(slow)).length, 0);
});

test("data_quality: seq gaps, timestamp regressions, quarantined payloads, unterminated sessions", () => {
  const b = new SessionBuilder("dq", { ended: false });
  b.start();
  b.wait(100).click("#a", "LOGIN");
  b.skipSeq(3);
  b.wait(100).click("#b", "LOGIN");
  b.wait(-5000).click("#c", "LOGIN");
  b.raw({ kind: "FORM_ACTIVITY", category: "form", severity: "warn", redacted: true, data: { quarantined: true, reason: "sensitive" } });
  const ctx = ctxOf(b);
  const gap = evaluateRule(rule({ type: "data_quality", check: "seq_gap" }), ctx);
  assert.equal(gap[0]?.vars.count, 1);
  assert.equal(gap[0]?.context?.missing_seq_numbers, 3);
  assert.equal(evaluateRule(rule({ type: "data_quality", check: "ts_regression" }), ctx)[0]?.vars.count, 1);
  assert.equal(evaluateRule(rule({ type: "data_quality", check: "quarantined" }), ctx)[0]?.vars.count, 1);
  assert.equal(evaluateRule(rule({ type: "data_quality", check: "unterminated" }), ctx).length, 1);

  const clean = mockFlow("clean");
  for (const check of ["seq_gap", "ts_regression", "quarantined", "unterminated"] as const) {
    assert.equal(evaluateRule(rule({ type: "data_quality", check }), ctxOf(clean)).length, 0, check);
  }
});

test("cross_session: recurring transitions aggregate into one match; rare ones need a large enough cohort", () => {
  const cohort = [1, 2, 3].map((i) => mockFlow(`peer${i}`));
  const subject = mockFlow("subj");
  const recurs = evaluateRule(rule({ type: "cross_session", pattern: "workflow_bigram", min_sessions: 3, min_share: 0.5, min_cohort: 3 }), ctxOf(subject, cohort));
  assert.equal(recurs.length, 1, "aggregated into a single match");
  assert.equal(recurs[0]?.vars.sessions_total, 4);
  assert.equal(recurs[0]?.vars.sessions_with, 4);
  assert.deepEqual(
    [...(recurs[0]?.context?.related_session_ids as string[])].sort(),
    ["peer1", "peer2", "peer3"],
  );
  // Too small a cohort → no judgement.
  assert.equal(evaluateRule(rule({ type: "cross_session", pattern: "workflow_bigram", min_sessions: 2, min_cohort: 5 }), ctxOf(subject, cohort)).length, 0);

  const odd = new SessionBuilder("odd");
  odd.start();
  odd.wait(100).transition("LOGIN");
  odd.wait(100).transition("RATE_SETUP", "LOGIN");
  odd.wait(100).click("#rate", "RATE_SETUP");
  odd.end();
  const rare = evaluateRule(rule({ type: "cross_session", pattern: "workflow_bigram", min_sessions: 1, max_share: 0.25, min_cohort: 4 }), ctxOf(odd, cohort));
  assert.equal(rare.length, 1);
  assert.match(String(rare[0]?.vars.pattern), /LOGIN→RATE_SETUP \(1\/4\)/);
  assert.equal(rare[0]?.workflow, "RATE_SETUP");
});

test("cross_session(action_trigram): shared operator action triples across sessions", () => {
  const cohort = [1, 2].map((i) => mockFlow(`p${i}`));
  const hit = evaluateRule(rule({ type: "cross_session", pattern: "action_trigram", min_sessions: 3, min_share: 1 }), ctxOf(mockFlow("s"), cohort));
  assert.equal(hit.length, 1);
  assert.ok((hit[0]?.vars.count as number) > 0);
  assert.ok(hit[0]?.events.every((e) => e.session_id === "s"), "evidence is always from the analysed session");
});
