/**
 * Diagnostics: analysis provenance (rule version + analysis time per session),
 * stale-finding detection (rules changed, new events, no record), stale-only
 * re-analysis, provenance on the finding drill-down, and the session
 * comparison export (JSON / CSV, download headers, formula-injection guard).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { AnalysisStatusReport, FindingDetail, RuleSet, SessionComparison } from "../src/shared.ts";
import { AnalysisService, loadDefaultRules } from "../src/analysis/service.ts";
import { comparisonCsv, comparisonJson } from "../src/analysis/compare-export.ts";
import { Store } from "../src/db/store.ts";
import { ENV_A, SessionBuilder, T0, mockFlow, persist } from "./analysis-fixtures.ts";
import { type ServiceHarness, authHeaders, startServiceHarness } from "./helpers.ts";

function irregular(id: string): SessionBuilder {
  const b = new SessionBuilder(id, { t0: T0 + 7_200_000 });
  b.start(ENV_A);
  b.wait(100).transition("LOGIN");
  for (let i = 0; i < 4; i++) b.wait(200).click("#login-submit", "LOGIN");
  b.add("error", { workflow: "LOGIN", severity: "error", metadata: { message: "x" } });
  b.wait(400_000).click("#b", "LOGIN");
  b.end();
  return b;
}

/** Same rules, one confidence changed → a different rule-set version. */
function tweakedRules(): RuleSet {
  const r = structuredClone(loadDefaultRules());
  const first = r.rules[0] as { confidence: number };
  first.confidence = first.confidence >= 0.9 ? 0.5 : Math.round((first.confidence + 0.05) * 100) / 100;
  return r;
}

test("provenance and stale detection: rules changed, new events, missing record; stale-only re-analysis", () => {
  const store = new Store(":memory:");
  let clock = T0 + 10_000_000;
  const svc = new AnalysisService({ store, now: () => clock });
  for (const b of [mockFlow("s1"), irregular("s2"), mockFlow("s3", { t0: T0 + 20_000_000 })]) persist(store, b);

  let st = svc.status();
  assert.ok(st.sessions.every((s) => s.state === "not_analyzed"));

  const run = svc.run(["s1", "s2"]);
  assert.equal(run.analyzed_at, clock);
  assert.deepEqual(run.session_ids, ["s1", "s2"]);
  st = svc.status(["s1", "s2", "s3"]);
  const s1 = st.sessions.find((s) => s.session_id === "s1");
  assert.equal(s1?.state, "current");
  assert.equal(s1?.analyzed_at, clock);
  assert.equal(s1?.rules_version, st.current_rules_version);
  assert.equal(s1?.event_count_at_analysis, store.countEvents("s1"));
  assert.equal(st.sessions.find((s) => s.session_id === "s2")?.finding_count, store.listFindings({ sessionId: "s2" }).total);
  assert.ok((st.sessions.find((s) => s.session_id === "s2")?.finding_count ?? 0) > 0, "fixture produces findings");
  assert.equal(st.sessions.find((s) => s.session_id === "s3")?.state, "not_analyzed");
  assert.equal(st.stale, 0);

  // Late events for s1 → stale (new_events).
  const late = new SessionBuilder("s1", { t0: T0 + 5_000_000 });
  late.skipSeq(10_000);
  late.click("#late", "LOGIN");
  for (const ev of late.labEvents) store.insertEvent(ev);
  st = svc.status(["s1", "s2"]);
  assert.deepEqual(st.sessions.find((s) => s.session_id === "s1")?.reasons, ["new_events"]);
  assert.equal(st.sessions.find((s) => s.session_id === "s2")?.state, "current");

  // New rule set → everything analysed is stale (rules_changed).
  assert.equal(svc.setRules(tweakedRules()).ok, true);
  st = svc.status(["s1", "s2"]);
  assert.deepEqual(st.sessions.find((s) => s.session_id === "s1")?.reasons, ["rules_changed", "new_events"]);
  assert.deepEqual(st.sessions.find((s) => s.session_id === "s2")?.reasons, ["rules_changed"]);
  assert.equal(st.stale, 2);

  // Findings without a provenance record (pre-diagnostics database) are stale too.
  const legacy = { ...(store.listFindings({ sessionId: "s2" }).findings[0] as NonNullable<ReturnType<Store["listFindings"]>["findings"][0]>), finding_id: "legacy-1", session_id: "s3" };
  store.saveFindings(["s3"], [legacy]);
  assert.deepEqual(svc.status(["s3"]).sessions[0]?.reasons, ["no_analysis_record"]);

  clock += 60_000;
  const again = svc.runStale();
  assert.deepEqual([...(again.session_ids ?? [])].sort(), ["s1", "s2", "s3"]);
  st = svc.status(["s1", "s2", "s3"]);
  assert.ok(st.sessions.every((s) => s.state === "current" && s.analyzed_at === clock && s.rules_version === st.current_rules_version));
  assert.equal(svc.runStale().sessions, 0, "nothing stale → nothing re-run");
  store.close();
});

async function api<T>(h: ServiceHarness, method: string, path: string, body?: unknown, headers: Record<string, string> = authHeaders()): Promise<{ status: number; json: T; res: Response; text: string }> {
  const res = await fetch(`${h.base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    json = undefined;
  }
  return { status: res.status, json: json as T, res, text };
}

test("API: status, stale re-run, provenance on the finding detail; validation and auth", async () => {
  const h = await startServiceHarness();
  try {
    for (const b of [mockFlow("a1"), irregular("a2")]) persist(h.store, b);
    assert.equal((await api(h, "GET", "/v1/analysis/status", undefined, {})).status, 401);
    assert.equal((await api(h, "POST", "/v1/analysis/run", { sessionIds: ["a1", "a2"] })).status, 200);
    const st = await api<AnalysisStatusReport>(h, "GET", "/v1/analysis/status?sessions=a1,a2");
    assert.equal(st.status, 200);
    assert.ok(st.json.sessions.every((s) => s.state === "current"));

    const fid = h.store.listFindings({ sessionId: "a2" }).findings[0]?.finding_id as string;
    const d = await api<FindingDetail>(h, "GET", `/v1/findings/${fid}`);
    assert.equal(d.json.analysis?.rules_version, st.json.current_rules_version);
    assert.equal(d.json.analysis?.state, "current");

    assert.equal((await api(h, "PUT", "/v1/analysis/rules", tweakedRules())).status, 200);
    assert.equal((await api<AnalysisStatusReport>(h, "GET", "/v1/analysis/status")).json.stale, 2);
    assert.equal((await api(h, "POST", "/v1/analysis/run", { stale: "yes" })).status, 400);
    assert.equal((await api(h, "POST", "/v1/analysis/run", { stale: true, sessionIds: ["a1"] })).status, 400);
    const rerun = await api<{ sessions: number; session_ids: string[] }>(h, "POST", "/v1/analysis/run", { stale: true });
    assert.equal(rerun.json.sessions, 2);
    assert.equal((await api<AnalysisStatusReport>(h, "GET", "/v1/analysis/status")).json.stale, 0);
    assert.equal((await api(h, "GET", "/v1/analysis/status?sessions=bad id")).status, 400);
  } finally {
    await h.close();
  }
});

test("comparison export: JSON with provenance, CSV with BOM and formula guard, download headers", async () => {
  const h = await startServiceHarness();
  try {
    for (const b of [mockFlow("c1"), irregular("c2")]) persist(h.store, b);
    const plain = await api<SessionComparison>(h, "GET", "/v1/analysis/compare?a=c1&b=c2");
    assert.equal(plain.json.a, "c1", "no format: the comparison itself (unchanged contract)");
    assert.equal(plain.res.headers.get("content-disposition"), null);

    const j = await api<{ kind: string; format_version: number; comparison: SessionComparison }>(h, "GET", "/v1/analysis/compare?a=c1&b=c2&format=json&download=1");
    assert.equal(j.status, 200);
    assert.equal(j.res.headers.get("content-disposition"), 'attachment; filename="lab-compare-c1-vs-c2.json"');
    assert.equal(j.json.kind, "lab-session-comparison");
    assert.deepEqual(j.json.comparison, plain.json);

    const c = await api(h, "GET", "/v1/analysis/compare?a=c1&b=c2&format=csv&download=1");
    assert.equal(c.res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(c.res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(c.res.headers.get("content-disposition"), 'attachment; filename="lab-compare-c1-vs-c2.csv"');
    const bytes = new Uint8Array(await (await fetch(`${h.base}/v1/analysis/compare?a=c1&b=c2&format=csv`, { headers: authHeaders() })).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM for spreadsheet apps");
    const lines = c.text.replace(/^﻿/, "").trimEnd().split("\r\n");
    assert.equal(lines[0], '"section","item","a","b","delta_b_minus_a","detail"');
    assert.ok(lines.some((l) => l.startsWith('"summary","similarity"')));
    assert.ok(lines.some((l) => l.startsWith('"workflow_time_ms","LOGIN"')));

    assert.equal((await api(h, "GET", "/v1/analysis/compare?a=c1&b=c2&format=xml")).status, 400);
    assert.equal((await api(h, "GET", "/v1/analysis/compare?a=c1&b=nope&format=csv")).status, 404);
    assert.equal((await api(h, "GET", "/v1/analysis/compare?a=c1&b=c2&format=csv", undefined, {})).status, 401);
  } finally {
    await h.close();
  }
});

test("comparison CSV neutralises spreadsheet formulas in recorded values", () => {
  const cmp: SessionComparison = {
    a: "=A1",
    b: "b",
    similarity: 0.5,
    workflow_sequence: { a: ["LOGIN"], b: ["LOGIN"], common: ["LOGIN"], only_a: [], only_b: [] },
    workflows: [{ workflow: "LOGIN", a_ms: 10, b_ms: 20, delta_ms: 10, ratio: 2 }],
    counts: { a_events: 1, b_events: 2, a_errors: 0, b_errors: 0 },
    timing: { a_median_gap_ms: 5, b_median_gap_ms: 6 },
    actions: { jaccard: 0.5, only_a: ["+cmd|' /C calc'!A0"], only_b: ["@SUM(1)"] },
    environment_differences: [{ field: "language", a: "-2+3", b: "en-US" }],
    notes: ["=HYPERLINK(\"http://x\")"],
  };
  const csv = comparisonCsv(cmp);
  for (const bad of ["=A1", "+cmd", "@SUM", "-2+3", "=HYPERLINK"]) {
    assert.ok(!new RegExp(`(^|,)"${bad.replace(/[+()|]/g, "\\$&")}`, "m").test(csv), `${bad} is guarded`);
  }
  assert.ok(csv.includes(`"'=A1"`));
  assert.equal(comparisonJson(cmp, 0).exported_at, "1970-01-01T00:00:00.000Z");
});
