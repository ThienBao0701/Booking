/** Analysis API integration: ingestion over HTTP → analysis → findings → evidence events. */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalysisResult, Finding, SessionComparison, WorkflowGraph } from "../src/shared.ts";
import { AnalysisService, loadDefaultRules } from "../src/analysis/service.ts";
import { EventBus } from "../src/eventbus.ts";
import { Logger } from "../src/logger.ts";
import { Store } from "../src/db/store.ts";
import { autoAnalyzeOnSessionEnd } from "../src/index.ts";
import { type ServiceHarness, authHeaders, startServiceHarness } from "./helpers.ts";
import { ENV_A, SessionBuilder, T0, mockFlow, persist } from "./analysis-fixtures.ts";

async function api<T = Record<string, unknown>>(h: ServiceHarness, method: string, path: string, body?: unknown, headers = authHeaders()): Promise<{ status: number; json: T }> {
  const res = await fetch(`${h.base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json()) as T };
}

/** Ingest a fixture session through the public API (session → events → end). */
async function ingest(h: ServiceHarness, b: SessionBuilder): Promise<void> {
  const s = b.session;
  assert.equal((await api(h, "POST", "/v1/sessions", { sessionId: s.sessionId, startedAt: s.startedAt, mode: s.mode, target: s.target })).status, 201);
  const r = await api<{ stored: number; invalid: number }>(h, "POST", "/v1/events", { events: b.labEvents });
  assert.equal(r.status, 202);
  assert.equal(r.json.invalid, 0);
  assert.equal((await api(h, "POST", `/v1/sessions/${s.sessionId}/end`, { endedAt: s.endedAt })).status, 200);
}

function odd(id: string): SessionBuilder {
  const b = new SessionBuilder(id, { t0: T0 + 7_200_000 });
  b.start(ENV_A);
  b.wait(100).transition("LOGIN");
  for (let i = 0; i < 4; i++) b.wait(200).click("#login-submit", "LOGIN");
  b.add("error", { workflow: "LOGIN", severity: "error", metadata: { message: "x" } });
  b.wait(400_000).click("#b", "LOGIN");
  b.end();
  return b;
}

test("analysis endpoints require auth and reject web origins", async () => {
  const h = await startServiceHarness();
  try {
    for (const [m, p] of [
      ["GET", "/v1/findings"],
      ["POST", "/v1/analysis/run"],
      ["GET", "/v1/analysis/rules"],
      ["PUT", "/v1/analysis/rules"],
      ["GET", "/v1/analysis/graph"],
    ] as const) {
      const noAuth = await fetch(`${h.base}${p}`, { method: m });
      assert.equal(noAuth.status, 401, `${m} ${p}`);
      const web = await fetch(`${h.base}${p}`, { method: m, headers: authHeaders({ origin: "http://evil.example" }) });
      assert.equal(web.status, 403, `${m} ${p} origin`);
    }
  } finally {
    await h.close();
  }
});

test("end-to-end: ingest → run → list/filter findings → finding detail with its exact events", async () => {
  const h = await startServiceHarness();
  try {
    for (let i = 0; i < 3; i++) await ingest(h, mockFlow(`n${i}`, { t0: T0 + i * 60_000 }));
    const o = odd("odd");
    await ingest(h, o);

    const run = await api<{ sessions: number; findings: number; rules_version: string; warnings: string[] }>(h, "POST", "/v1/analysis/run", { sessionIds: ["odd", "n0", "n1", "n2"] });
    assert.equal(run.status, 200);
    assert.equal(run.json.sessions, 4);
    assert.ok(run.json.findings > 0);
    assert.deepEqual(run.json.warnings, []);

    const list = await api<{ total: number; findings: Finding[] }>(h, "GET", "/v1/findings?session=odd");
    assert.equal(list.status, 200);
    assert.ok(list.json.total > 0);
    assert.ok(list.json.findings.every((f) => f.session_id === "odd"));
    const warn = await api<{ findings: Finding[] }>(h, "GET", "/v1/findings?severity=warn");
    assert.ok(warn.json.findings.length > 0 && warn.json.findings.every((f) => f.severity === "warn"));
    const byRule = await api<{ total: number }>(h, "GET", "/v1/findings?rule=GAP-LONG-IDLE&workflow=LOGIN");
    assert.equal(byRule.json.total, 1);
    const paged = await api<{ total: number; findings: Finding[] }>(h, "GET", "/v1/findings?limit=1&offset=1");
    assert.equal(paged.json.findings.length, 1);

    // Detail: every cited event id resolves to a stored event of that session.
    const ids = new Set(o.labEvents.map((e) => e.id));
    for (const f of list.json.findings) {
      const d = await api<{ finding: Finding; events: Array<{ id: string; session_id: string }>; missing_event_ids: string[] }>(h, "GET", `/v1/findings/${f.finding_id}`);
      assert.equal(d.status, 200);
      assert.deepEqual(d.json.missing_event_ids, []);
      const got = new Set(d.json.events.map((e) => e.id));
      for (const id of d.json.finding.event_ids) {
        assert.ok(got.has(id), `${f.rule_id}: event ${id} returned`);
        assert.ok(ids.has(id));
      }
      assert.ok(d.json.events.every((e) => e.session_id === "odd"));
    }
    assert.equal((await api(h, "GET", "/v1/findings/fnd_nope")).status, 404);
  } finally {
    await h.close();
  }
});

test("session analysis, comparison and graph endpoints", async () => {
  const h = await startServiceHarness();
  try {
    await ingest(h, mockFlow("a", { env: ENV_A }));
    await ingest(h, mockFlow("b", { pace: 2, env: ENV_A }));

    const an = await api<AnalysisResult>(h, "GET", "/v1/sessions/a/analysis");
    assert.equal(an.status, 200);
    assert.equal(an.json.session_id, "a");
    assert.ok(an.json.segments.length > 0);
    assert.equal(an.json.environment.browser, "Chrome");
    assert.deepEqual(an.json.cohort_session_ids.sort(), ["a", "b"]);
    assert.equal((await api(h, "GET", "/v1/findings")).json.total, 0, "GET analysis does not persist");
    assert.equal((await api(h, "GET", "/v1/sessions/zzz/analysis")).status, 404);

    const cmp = await api<SessionComparison>(h, "GET", "/v1/analysis/compare?a=a&b=b");
    assert.equal(cmp.status, 200);
    assert.equal(cmp.json.a, "a");
    assert.ok(cmp.json.workflows.some((w) => (w.delta_ms ?? 0) > 0));
    assert.equal((await api(h, "GET", "/v1/analysis/compare?a=a")).status, 400);
    assert.equal((await api(h, "GET", "/v1/analysis/compare?a=a&b=nope")).status, 404);

    const g = await api<WorkflowGraph>(h, "GET", "/v1/analysis/graph?sessions=a,b");
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.session_ids, ["a", "b"]);
    assert.ok(g.json.edges.length > 0);
    const gAll = await api<WorkflowGraph>(h, "GET", "/v1/analysis/graph");
    assert.equal(gAll.json.session_ids.length, 2);
  } finally {
    await h.close();
  }
});

test("request validation: bad ids, enums and numbers are 400, never 500", async () => {
  const h = await startServiceHarness();
  try {
    for (const q of ["severity=critical", "category=NOPE", "workflow=NOPE", "limit=-1", "from=abc", "session=a%20b", `q=${"x".repeat(201)}`]) {
      assert.equal((await api(h, "GET", `/v1/findings?${q}`)).status, 400, q);
    }
    assert.equal((await api(h, "POST", "/v1/analysis/run", { sessionIds: "x" })).status, 200, "comma list accepted");
    assert.equal((await api(h, "POST", "/v1/analysis/run", { sessionIds: [1] })).status, 400);
    assert.equal((await api(h, "POST", "/v1/analysis/run", { sessionIds: Array.from({ length: 201 }, (_, i) => `s${i}`) })).status, 400);
    assert.equal((await api(h, "GET", "/v1/analysis/graph?sessions=a/b")).status, 400);
  } finally {
    await h.close();
  }
});

test("rule configuration over the API: get, reject invalid/conclusive, replace, reset", async () => {
  const h = await startServiceHarness();
  try {
    const info = await api<{ source: string; version: string; rules: { rules: unknown[] } }>(h, "GET", "/v1/analysis/rules");
    assert.equal(info.json.source, "default");
    assert.equal(info.json.rules.rules.length, loadDefaultRules().rules.length);

    const conclusive = await api<{ error: string; errors: string[] }>(h, "PUT", "/v1/analysis/rules", {
      version: 1,
      rules: [{ ...loadDefaultRules().rules[0], description: "This proves the account was flagged by the platform." }],
    });
    assert.equal(conclusive.status, 400);
    assert.equal(conclusive.json.error, "invalid_rules");
    assert.ok(conclusive.json.errors.some((e) => e.includes("non-conclusive")));
    assert.equal((await api(h, "PUT", "/v1/analysis/rules", { rules: [] })).status, 400);

    const subset = { version: 1, rules: loadDefaultRules().rules.slice(0, 3) };
    const put = await api<{ source: string; rules: number }>(h, "PUT", "/v1/analysis/rules", subset);
    assert.equal(put.status, 200);
    assert.deepEqual([put.json.source, put.json.rules], ["custom", 3]);
    assert.equal((await api<{ source: string }>(h, "GET", "/v1/analysis/rules")).json.source, "custom");

    const reset = await api<{ source: string; version: string }>(h, "DELETE", "/v1/analysis/rules");
    assert.equal(reset.json.source, "default");
    assert.equal(reset.json.version, info.json.version);
  } finally {
    await h.close();
  }
});

test("session end triggers background analysis (coalesced, off the request path)", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const store = new Store(":memory:");
  const logDir = mkdtempSync(join(tmpdir(), "lab-auto-"));
  try {
    persist(store, odd("auto1"));
    persist(store, odd("auto2"));
    const bus = new EventBus();
    const logger = new Logger({ dir: logDir, level: "error", stdout: false });
    const svc = new AnalysisService({ store });
    const calls: string[][] = [];
    const run = svc.run.bind(svc);
    svc.run = (ids) => {
      calls.push([...(ids ?? [])]);
      return run(ids);
    };
    const stop = autoAnalyzeOnSessionEnd(bus, svc, logger);
    bus.publish({ type: "session.end", payload: { sessionId: "auto1" } });
    bus.publish({ type: "session.end", payload: { sessionId: "auto2" } });
    bus.publish({ type: "session.start", payload: { sessionId: "other" } });
    assert.equal(calls.length, 0, "deferred");
    mock.timers.tick(1500);
    assert.deepEqual(calls, [["auto1", "auto2"]], "coalesced into one run");
    assert.ok(store.listFindings({ sessionId: "auto1" }).total > 0);
    stop();
    bus.publish({ type: "session.end", payload: { sessionId: "auto1" } });
    mock.timers.tick(5000);
    assert.equal(calls.length, 1, "unsubscribed");
  } finally {
    mock.timers.reset();
    store.close();
    rmSync(logDir, { recursive: true, force: true });
  }
});
