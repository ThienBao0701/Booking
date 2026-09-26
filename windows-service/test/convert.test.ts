import { test } from "node:test";
import assert from "node:assert/strict";

import { recordingToWorkflow } from "../src/automation/convert.ts";
import type { RecordedEvent } from "../src/shared.ts";
import { startServiceHarness, authHeaders } from "./helpers.ts";

let seq = 0;
function ev(action: RecordedEvent["action"], extra: Partial<RecordedEvent> = {}): RecordedEvent {
  return {
    event_id: `E${seq}`,
    session_id: "s",
    seq: seq++,
    timestamp: 1,
    page: "/",
    workflow: "UNKNOWN",
    action,
    metadata: {},
    ...extra,
  };
}

const MOCK = { kind: "mock" as const, baseUrl: "http://127.0.0.1:4599" };

test("recording converts to a valid, replayable draft with explicit rules", () => {
  seq = 0;
  const events: RecordedEvent[] = [
    ev("session_start"),
    ev("page_state", { metadata: { view: "login" } }),
    ev("change", { target: { tag: "input", selector: "#login-username" }, metadata: { filled: true, inputType: "input" } }),
    ev("change", { target: { tag: "input", selector: "#login-username" }, metadata: { filled: true, inputType: "input" } }),
    ev("change", { target: { tag: "input", selector: "#pw", name: "password" }, metadata: { sensitive: true, inputType: "password" } }),
    ev("click", { target: { tag: "button", selector: "#login-submit" } }),
    ev("click", { target: { tag: "button", selector: 'button[data-view="rooms"]' } }),
    ev("page_state", { metadata: { view: "rooms" } }),
    ev("change", { target: { tag: "select", selector: "#room-property" }, metadata: { filled: true, inputType: "select" } }),
    ev("change", { target: { tag: "input", selector: "#agree" }, metadata: { filled: true, inputType: "checkbox" } }),
    ev("change", { target: { tag: "input", selector: "#note" }, metadata: { filled: false, inputType: "input" } }),
    ev("dom_change", { metadata: { mutations: 3 } }),
    ev("click", { target: { tag: "button", selector: "button[data-cancel]" } }),
    ev("navigate", { page: "/", metadata: { leftScope: true } }),
    ev("change", { target: { tag: "input", selector: "#search" }, metadata: { filled: true, inputType: "input" } }),
    ev("submit", { target: { tag: "form", selector: "form" } }), // Enter key: no click on a submit button
    ev("session_end"),
  ];
  const { file, params, notes } = recordingToWorkflow(events, { workflow: "draft", target: MOCK });
  assert.deepEqual(
    file.steps.map((s) => [s.action, s.target, s.value]),
    [
      ["navigate", "/", undefined],
      ["type", "#login-username", "{{login-username}}"],
      ["type", "#pw", "{{secret_pw}}"],
      ["click", "#login-submit", undefined],
      ["click", 'button[data-view="rooms"]', undefined],
      ["waitFor", '.view.active[data-view="rooms"]', undefined],
      ["select", "#room-property", "$last"],
      ["click", "#agree", undefined],
      ["click", 'button[data-cancel="$last.reservation"]', undefined],
      ["type", "#search", "{{search}}"],
    ],
  );
  assert.deepEqual(params.sort(), ["login-username", "search", "secret_pw"]);
  assert.ok(notes.some((n) => n.includes("never stored")));
  assert.ok(notes.some((n) => n.includes("rebound")));
  assert.ok(notes.some((n) => n.includes("left the recordable scope")));
  assert.ok(notes.some((n) => n.includes("implicit form submit")));
  assert.deepEqual(file.target, MOCK);
  assert.deepEqual(file.steps.map((s) => s.id), file.steps.map((_, i) => `s${i + 1}`));
});

test("GET /v1/sessions/:id/workflow returns a draft; target must be the local mock", async () => {
  const h = await startServiceHarness();
  try {
    await fetch(`${h.base}/v1/sessions`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ sessionId: "rec-1" }) });
    const events = [
      { id: "A1", sessionId: "rec-1", seq: 0, ts: 1, kind: "CLICK", category: "interaction", severity: "info", redacted: true, data: { page: "/", action: "click", target: { selector: "#login-submit" }, metadata: {} } },
    ];
    await fetch(`${h.base}/v1/events`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ events }) });

    const ok = await fetch(`${h.base}/v1/sessions/rec-1/workflow?name=my-draft`, { headers: authHeaders() });
    assert.equal(ok.status, 200);
    const draft = (await ok.json()) as { file: { workflow: string; target: unknown; steps: Array<{ action: string; target: string }> } };
    assert.equal(draft.file.workflow, "my-draft");
    assert.deepEqual(draft.file.target, { kind: "mock", baseUrl: "http://127.0.0.1:4599" });
    assert.deepEqual(draft.file.steps.map((s) => s.action), ["navigate", "click"]);

    const bad = await fetch(`${h.base}/v1/sessions/rec-1/workflow?baseUrl=${encodeURIComponent("https://real.example")}`, { headers: authHeaders() });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${h.base}/v1/sessions/nope/workflow`, { headers: authHeaders() })).status, 404);
    assert.equal((await fetch(`${h.base}/v1/sessions/rec-1/workflow`)).status, 401);
  } finally {
    await h.close();
  }
});

test("GET /v1/runs/:id returns a persisted run", async () => {
  const h = await startServiceHarness();
  try {
    h.store.saveRun({ runId: "run_x", workflow: "w", mode: "SIMULATE", startedAt: 1, status: "completed", steps: [], checkpoints: [] });
    const res = await fetch(`${h.base}/v1/runs/run_x`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { run: { status: string } }).run.status, "completed");
    assert.equal((await fetch(`${h.base}/v1/runs/none`, { headers: authHeaders() })).status, 404);
  } finally {
    await h.close();
  }
});
