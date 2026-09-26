/** Analyzer: segmentation, timing, sequences, graph, environment, findings contract. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type AnalysisResult,
  type Finding,
  PLATFORM_CAVEAT,
  findConclusiveClaims,
  validateFinding,
  validateRuleSet,
} from "../src/shared.ts";
import { analyzeCohort, analyzeSession, cohortGraph, rulesVersion } from "../src/analysis/analyzer.ts";
import { loadDefaultRules } from "../src/analysis/service.ts";
import { MAX_MATCHES_PER_RULE } from "../src/analysis/rules/engine.ts";
import { findingId, render } from "../src/analysis/findings.ts";
import { ENV_A, SessionBuilder, T0, mockFlow } from "./analysis-fixtures.ts";

const NOW = () => T0 + 86_400_000;
const rules = loadDefaultRules();

/** Every finding honours the contract: required fields, traceability, wording, caveat. */
function assertFindingContract(r: AnalysisResult, events: ReadonlySet<string>): void {
  for (const f of r.findings) {
    const v = validateFinding(f);
    assert.ok(v.ok, `${f.rule_id}: ${v.ok ? "" : v.errors.join("; ")}`);
    for (const k of [
      "finding_id",
      "session_id",
      "workflow",
      "event_ids",
      "timestamp_range",
      "rule_id",
      "description",
      "evidence",
      "confidence",
      "counter_evidence",
      "recommended_next_test",
    ] as const) {
      assert.ok(f[k] !== undefined && f[k] !== null, `${f.rule_id}: ${k} present`);
    }
    assert.equal(f.session_id, r.session_id);
    assert.ok(f.event_ids.length > 0);
    for (const id of f.event_ids) assert.ok(events.has(id), `${f.rule_id}: cites existing event ${id}`);
    for (const e of f.evidence) assert.ok(events.has(e.event_id), `${f.rule_id}: evidence ${e.event_id} exists`);
    const triggers = f.evidence.filter((e) => e.role === "trigger").map((e) => e.event_id);
    assert.deepEqual(triggers, f.event_ids, "trigger evidence == event_ids, in order");
    assert.ok(f.timestamp_range.start <= f.timestamp_range.end);
    assert.ok(f.confidence >= 0.05 && f.confidence <= 0.95);
    assert.equal(f.counter_evidence[f.counter_evidence.length - 1], PLATFORM_CAVEAT, "platform caveat is last");
    for (const text of [f.title, f.description, f.possible_explanation, f.recommended_next_test, ...f.counter_evidence.slice(0, -1)]) {
      assert.deepEqual(findConclusiveClaims(text), [], `${f.rule_id}: "${text}"`);
    }
    assert.match(f.finding_id, /^fnd_[0-9a-f]{20}$/);
    assert.equal(f.finding_id, findingId(f.rule_id, f.session_id, f.event_ids));
  }
}

function eventIds(b: SessionBuilder): Set<string> {
  return new Set(b.labEvents.map((e) => e.id));
}

test("the built-in rule set validates and uses neutral wording", () => {
  const v = validateRuleSet(rules);
  assert.ok(v.ok);
  assert.ok(rules.rules.length >= 20);
  const types = new Set(rules.rules.map((r) => r.when.type));
  for (const t of ["sequence", "repetition", "repeated_sequence", "gap", "duration", "count", "rate", "absence", "outlier", "data_quality", "cross_session"]) {
    assert.ok(types.has(t as never), `a default rule uses ${t}`);
  }
});

test("segmentation + workflow sequence follow the recorded transitions", () => {
  const b = mockFlow("seg");
  const r = analyzeSession(b.build(), [], { rules, now: NOW });
  assert.deepEqual(r.workflow_sequence, ["LOGIN", "PROPERTY_SETUP", "ROOM_SETUP", "RESERVATION", "CANCELLATION", "RESERVATION", "REPORTING"]);
  const segIds = r.segments.flatMap((s) => s.event_ids);
  assert.equal(new Set(segIds).size, segIds.length, "no event in two segments");
  // All tab events are segmented; tab-less lifecycle events (start/end) are not.
  assert.equal(segIds.length, b.labEvents.filter((e) => e.tabId !== undefined).length);
  for (const s of r.segments) {
    assert.ok(s.duration_ms >= 0);
    assert.ok(s.first_seq <= s.last_seq);
  }
  assert.equal(r.event_count, b.labEvents.length);
});

test("timing summary: duration, gap distribution, longest gaps cite events", () => {
  const b = mockFlow("tim", { pace: 2 });
  const r = analyzeSession(b.build(), [], { rules, now: NOW });
  assert.equal(r.timing.event_count, b.labEvents.length);
  assert.equal(r.timing.session_duration_ms, b.now - T0);
  assert.ok(r.timing.inter_event_gap_ms.max >= r.timing.inter_event_gap_ms.p50);
  const ids = eventIds(b);
  for (const g of r.timing.longest_gaps) {
    assert.ok(ids.has(g.before_event_id) && ids.has(g.after_event_id));
  }
  assert.equal(r.timing.longest_gaps[0]?.ms, 10_000, "the 5 s × pace 2 pause before CANCELLATION");
  assert.ok((r.timing.workflow_duration_ms.RESERVATION ?? 0) > 0);
});

test("repeated sequences are reported with the exact occurrence event ids", () => {
  const b = new SessionBuilder("rs");
  b.start();
  const occ: string[][] = [];
  for (let i = 0; i < 3; i++) {
    occ.push([b.wait(500).click("#a", "RATE_SETUP"), b.wait(500).click("#b", "RATE_SETUP")]);
  }
  b.end();
  const r = analyzeSession(b.build(), [], { rules, now: NOW });
  const ab = r.repeated_sequences.find((x) => x.tokens.join() === "click:#a,click:#b");
  assert.ok(ab);
  assert.equal(ab.count, 3);
  assert.deepEqual(ab.occurrences, occ);
});

test("workflow graph: nodes, edges and edge samples that point at real events", () => {
  const sessions = [mockFlow("g1"), mockFlow("g2")];
  const g = cohortGraph(sessions.map((s) => s.build()));
  assert.deepEqual(g.session_ids, ["g1", "g2"]);
  const edge = g.edges.find((e) => e.from === "RESERVATION" && e.to === "CANCELLATION");
  assert.ok(edge);
  assert.equal(edge.count, 2);
  const all = new Set(sessions.flatMap((s) => [...eventIds(s)]));
  for (const e of g.edges) for (const s of e.samples) assert.ok(all.has(s.event_id));
  const res = g.nodes.find((n) => n.id === "RESERVATION");
  assert.equal(res?.sessions, 2);
  assert.equal(res?.segments, 4, "RESERVATION is visited twice per session");
});

test("environment report reads only recorded facts and cites its source events", () => {
  const b = new SessionBuilder("env");
  const start = b.start(ENV_A);
  b.wait(100).transition("LOGIN");
  const ps = b.add("page_state", {
    workflow: "LOGIN",
    metadata: { view: "login", environment: { viewport: { width: 1280, height: 720 }, screen: { width: 1920, height: 1080 }, device_pixel_ratio: 1.5, color_scheme: "dark" } },
  });
  b.end();
  const r = analyzeSession(b.build(), [], { rules, now: NOW });
  assert.equal(r.environment.captured, true);
  assert.equal(r.environment.browser, "Chrome");
  assert.equal(r.environment.timezone, "Europe/Amsterdam");
  assert.deepEqual(r.environment.viewport, { width: 1280, height: 720 });
  assert.equal(r.environment.color_scheme, "dark");
  assert.deepEqual(r.environment.source_event_ids, [start, ps]);

  const none = analyzeSession(mockFlow("noenv").build(), [], { rules, now: NOW });
  assert.equal(none.environment.captured, false);
  assert.equal(none.environment.browser, undefined);
});

test("findings honour the contract across a mixed cohort", () => {
  const normal = [0, 1, 2, 3].map((i) => mockFlow(`n${i}`, { t0: T0 + i * 3_600_000, pace: 1 + i * 0.1, env: ENV_A }));
  const odd = new SessionBuilder("odd", { ended: false, t0: T0 + 5 * 3_600_000 });
  odd.start(ENV_A);
  odd.wait(1000).transition("LOGIN");
  for (let i = 0; i < 5; i++) odd.wait(300).click("#login-submit", "LOGIN");
  odd.skipSeq(2);
  odd.wait(400_000).transition("RATE_SETUP", "LOGIN");
  odd.add("error", { workflow: "RATE_SETUP", severity: "error", metadata: { message: "save failed" } });
  odd.raw({ kind: "FORM_ACTIVITY", category: "form", severity: "warn", redacted: true, data: { quarantined: true, reason: "sensitive" } });
  odd.wait(1000).click("#rate-submit", "RATE_SETUP");
  odd.wait(9000).transition("RESERVATION", "RATE_SETUP");
  odd.wait(1000).click("#res-submit", "RESERVATION");

  const all = [...normal, odd];
  const results = analyzeCohort(all.map((b) => b.build()), { rules, now: NOW });
  for (const b of all) assertFindingContract(results.get(b.id) as AnalysisResult, eventIds(b));

  const oddRes = results.get("odd") as AnalysisResult;
  const fired = new Set(oddRes.findings.map((f) => f.rule_id));
  for (const id of ["REP-SAME-CONTROL-BURST", "GAP-LONG-IDLE", "CNT-ERROR-EVENTS", "DQ-SEQ-GAP", "DQ-QUARANTINED", "DQ-UNTERMINATED", "SEQ-RATE-BEFORE-RESERVATION", "CORR-RARE-TRANSITION"]) {
    assert.ok(fired.has(id), `${id} fired (got ${[...fired].join(", ")})`);
  }
  assert.deepEqual(oddRes.data_quality, { quarantined: 1, seq_gaps: 1, ts_regressions: 0, terminated: false });
  assert.deepEqual(oddRes.warnings, []);

  // A finding whose range spans quarantined events / seq gaps is less confident than its rule's base.
  const rateSeq = oddRes.findings.find((f) => f.rule_id === "SEQ-RATE-BEFORE-RESERVATION") as Finding;
  const base = rules.rules.find((r) => r.id === "SEQ-RATE-BEFORE-RESERVATION")?.confidence as number;
  assert.ok(rateSeq.confidence < base, `${rateSeq.confidence} < ${base}`);
  assert.ok(rateSeq.counter_evidence.some((c) => /quarantined/.test(c)));

  // Normal sessions in a consistent cohort produce no warn/error findings.
  for (const b of normal) {
    const r = results.get(b.id) as AnalysisResult;
    assert.equal(r.findings.filter((f) => f.severity !== "info").length, 0, `${b.id}: ${r.findings.map((f) => f.rule_id).join(",")}`);
    assert.ok(r.findings.length <= 4, `${b.id}: low noise (${r.findings.map((f) => f.rule_id).join(",")})`);
  }
});

test("analysis is deterministic: same data + rules + clock → identical result", () => {
  const mk = () => [mockFlow("d1"), mockFlow("d2", { pace: 3 }), mockFlow("d3", { pace: 0.5 })].map((b) => b.build());
  const a = analyzeCohort(mk(), { rules, now: NOW });
  const b = analyzeCohort(mk(), { rules, now: NOW });
  assert.deepEqual([...a.entries()], [...b.entries()]);
  assert.equal(a.get("d1")?.rules_version, rulesVersion(rules));
});

test("disabled rules never fire; per-rule matches are capped with a warning", () => {
  const b = new SessionBuilder("cap");
  b.start();
  for (let i = 0; i < MAX_MATCHES_PER_RULE + 5; i++) b.wait(400_000).click(`#x${i}`, "REPORTING");
  b.end();
  const gapOnly = { version: 1 as const, rules: rules.rules.filter((r) => r.id === "GAP-LONG-IDLE") };
  const r = analyzeSession(b.build(), [], { rules: gapOnly, now: NOW });
  assert.equal(r.findings.length, MAX_MATCHES_PER_RULE);
  assert.ok(r.warnings.some((w) => w.startsWith("GAP-LONG-IDLE:")));
  assert.equal(r.findings[0]?.frequency, MAX_MATCHES_PER_RULE + 5);

  const disabled = { version: 1 as const, rules: gapOnly.rules.map((x) => ({ ...x, enabled: false })) };
  assert.equal(analyzeSession(b.build(), [], { rules: disabled, now: NOW }).findings.length, 0);
});

test("a single session is analysed without a baseline and says so", () => {
  const b = new SessionBuilder("solo");
  b.start();
  b.wait(100).click("#a", "LOGIN");
  b.wait(400_000).click("#b", "LOGIN");
  b.end();
  const r = analyzeSession(b.build(), [], { rules, now: NOW });
  const f = r.findings.find((x) => x.rule_id === "GAP-LONG-IDLE") as Finding;
  assert.ok(f);
  assert.ok(f.counter_evidence.some((c) => /no baseline/.test(c)));
  assert.ok(f.counter_evidence.some((c) => /fewer|only \d+ events/.test(c)));
  assert.deepEqual(r.cohort_session_ids, ["solo"]);
});

test("render: known placeholders substituted, unknown become n/a", () => {
  assert.equal(render("{{count}} in {{ workflow }} / {{nope}}", { count: 3, workflow: "LOGIN" }), "3 in LOGIN / n/a");
});
