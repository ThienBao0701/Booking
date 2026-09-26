/**
 * E2E: the whole lab loop against the REAL mock Extranet on 127.0.0.1:4599 and
 * the real service — OBSERVE → RECORD → REPLAY → ANALYZE → COMPARE → REPORT.
 * Two operator sessions are recorded through the extension recorder + bridge,
 * the example workflow is replayed on the mock, analysis runs over the API,
 * the sessions are compared, and a forensic report is produced whose findings
 * resolve to the exact stored events that produced them.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ReplayEngine } from "../../windows-service/src/automation/engine.ts";
import { MockExtranetController } from "../../windows-service/src/automation/mock-controller.ts";
import type { FindingDetail, ForensicReport, ReplayRunSummary, SessionComparison, WorkflowFile } from "../../shared/src/index.ts";
import { Recorder } from "../../extension/src/recorder/recorder.ts";
import { MemoryQueue } from "../../extension/src/recorder/queue.ts";
import { BridgeClient } from "../../extension/src/bridge/client.ts";
import { ensureMock, startLabService, type LabServiceHandle, type MockHandle } from "./harness.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const example = (): WorkflowFile => JSON.parse(readFileSync(`${root}examples/workflows/mock-full-flow.json`, "utf8")) as WorkflowFile;

let mock: MockHandle;
let svc: LabServiceHandle;
before(async () => {
  mock = await ensureMock();
  svc = await startLabService();
});
after(async () => {
  await svc.close();
  await mock.close();
});

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(svc.url + path, { ...init, headers: { authorization: `Bearer ${svc.token}`, "content-type": "application/json" } });
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Record one operator session through the extension recorder and bridge. */
async function recordSession(opts: { repeatSubmit: number; environment: Record<string, unknown> }): Promise<string> {
  const bridge = new BridgeClient({ serviceUrl: svc.url, token: svc.token });
  const recorder = new Recorder({ queue: new MemoryQueue(), sink: bridge, flushIntervalMs: 60_000 });
  const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "mock", host: "127.0.0.1" }, environment: opts.environment });
  bridge.declareSession(s);
  let view = "login";
  // Operator pacing: events 600 ms apart (the recorder merges identical events within 250 ms).
  let t = Date.now() - 60_000;
  const at = () => (t += 600);
  const click = (selector: string) => recorder.record({ action: "click", page: "/", tabId: 3, view, timestamp: at(), target: { tag: "button", selector } });
  const change = (selector: string) => recorder.record({ action: "change", page: "/", tabId: 3, view, timestamp: at(), target: { tag: "input", selector }, metadata: { filled: true, inputType: "input" } });
  const go = (v: string) => {
    click(`button[data-view="${v}"]`);
    view = v;
    recorder.record({ action: "page_state", page: "/", tabId: 3, view, timestamp: at(), metadata: { readyState: "complete", view } });
  };
  recorder.record({ action: "page_state", page: "/", tabId: 3, view, timestamp: at(), metadata: { readyState: "complete", view, environment: { viewport: { width: 1280, height: 720 } } } });
  change("#login-username");
  for (let i = 0; i < opts.repeatSubmit; i++) click("#login-submit");
  go("property");
  change("#prop-name");
  click("#prop-submit");
  go("reservations");
  change("#res-guest");
  click("#res-submit");
  go("reports");
  click("#report-submit");
  await recorder.endSession();
  assert.equal(recorder.stats.queueSize, 0, "everything delivered");
  await bridge.endSession(s.sessionId, Date.now());
  return s.sessionId;
}

test("OBSERVE → RECORD → REPLAY → ANALYZE → COMPARE → REPORT", async () => {
  // OBSERVE + RECORD: two sessions, the second with a repeated submit and another language.
  const env = { browser: "Chrome", browser_major: 131, platform: "Windows", language: "en-US", timezone: "Europe/Amsterdam", extension_version: "0.1.0" };
  const a = await recordSession({ repeatSubmit: 1, environment: env });
  const b = await recordSession({ repeatSubmit: 4, environment: { ...env, language: "vi-VN" } });

  // REPLAY: the example workflow on the mock, persisted with the run record.
  const run = await new ReplayEngine(example(), {
    mode: "SIMULATE",
    controller: new MockExtranetController({ pollMs: 20 }),
    params: { username: `pipeline-${Date.now()}`, propertyName: "Pipeline Villa" },
    sourceSessionId: a,
    persist: (r) => svc.store.saveRun(r),
  }).start();
  assert.equal(run.status, "completed");
  const runs = await api<{ runs: ReplayRunSummary[] }>("/v1/runs");
  assert.ok(runs.runs.some((r) => r.runId === run.runId && r.sourceSessionId === a && r.steps.failed === 0));

  // ANALYZE: persisted findings; each resolves to its exact stored events.
  const summary = await api<{ sessions: number; findings: number; warnings: string[] }>("/v1/analysis/run", { method: "POST", body: JSON.stringify({ sessionIds: [a, b] }) });
  assert.equal(summary.sessions, 2);
  assert.deepEqual(summary.warnings, []);
  const listB = await api<{ findings: Array<{ finding_id: string; rule_id: string; event_ids: string[] }> }>(`/v1/findings?session=${b}`);
  assert.ok(listB.findings.some((f) => f.rule_id === "REP-SAME-CONTROL-BURST"), "the repeated submit is observed");
  for (const f of listB.findings) {
    const d = await api<FindingDetail>(`/v1/findings/${f.finding_id}`);
    assert.deepEqual(d.missing_event_ids, []);
    const stored = new Set(d.events.map((e) => e.id));
    for (const id of f.event_ids) assert.ok(stored.has(id), `${f.rule_id}: ${id} stored`);
  }

  // COMPARE: same path, different repetition and environment.
  const cmp = await api<SessionComparison>(`/v1/analysis/compare?a=${a}&b=${b}`);
  assert.deepEqual(cmp.workflow_sequence.a, cmp.workflow_sequence.b);
  assert.equal(cmp.workflow_sequence.a[0], "LOGIN");
  assert.ok(cmp.counts.b_events > cmp.counts.a_events);
  assert.ok(cmp.environment_differences.some((d) => d.field === "language"));

  // REPORT: JSON with all sections and back-links; HTML with an anchor per cited event.
  const report = await api<ForensicReport>(`/v1/reports/sessions/${b}?format=json&compare=${a}`);
  assert.equal(report.findings_source, "stored");
  assert.equal(report.comparative_analysis.baseline_session_id, a);
  assert.equal(report.environment.language, "vi-VN");
  const rows = new Map(report.timeline.events.map((e) => [e.event_id, e]));
  for (const f of report.findings) for (const id of f.event_ids) assert.ok(rows.get(id)?.cited_by.includes(f.finding_id));
  const html = await (await fetch(`${svc.url}/v1/reports/sessions/${b}?format=html`, { headers: { authorization: `Bearer ${svc.token}` } })).text();
  for (const f of report.findings) for (const id of f.event_ids) assert.ok(html.includes(`href="#ev-${id}"`), id);
});
