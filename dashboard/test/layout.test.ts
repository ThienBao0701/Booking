/** Chart geometry: ticks, arc diagram, timeline packing. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { arcLayout, niceTicks, textWidth, timeTicks, timelineLayout } from "../src/layout.ts";
import { colPath, hbarPath } from "../src/components/charts.ts";
import type { WorkflowGraph } from "../src/shared.ts";

test("nice ticks cover the maximum with 1/2/5 steps", () => {
  assert.deepEqual(niceTicks(143), [0, 50, 100, 150]);
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(0), [0, 1]);
  for (const max of [1, 3, 17, 999, 12_345]) {
    const t = niceTicks(max);
    assert.ok((t[t.length - 1] as number) >= max, String(max));
    assert.ok(t.length <= 7);
  }
});

test("time ticks are aligned to round steps and fit the width", () => {
  const t0 = Date.UTC(2026, 8, 26, 10, 0, 7);
  const ticks = timeTicks(t0, t0 + 10 * 60_000, 900);
  assert.ok(ticks.length >= 2 && ticks.length <= 10);
  const step = (ticks[1] as number) - (ticks[0] as number);
  assert.ok([60_000, 120_000, 300_000].includes(step), String(step));
  for (const t of ticks) assert.equal(t % step, 0);
});

test("bar paths: rounded data-end, square baseline", () => {
  assert.equal(hbarPath(10, 0, 100, 14), "M 10 0 H 106 Q 110 0 110 4 V 10 Q 110 14 106 14 H 10 Z");
  assert.match(colPath(0, 100, 20, 50), /^M 0 100 V 54 Q 0 50 4 50 H 16 Q 20 50 20 54 V 100 Z$/);
  assert.equal(textWidth("RESERVATION", 10), 66);
});

const graph: WorkflowGraph = {
  session_ids: ["a", "b"],
  nodes: [
    { id: "RESERVATION", segments: 4, total_ms: 40_000, sessions: 2 },
    { id: "LOGIN", segments: 2, total_ms: 10_000, sessions: 2 },
    { id: "CANCELLATION", segments: 2, total_ms: 5_000, sessions: 2 },
  ],
  edges: [
    { from: "LOGIN", to: "RESERVATION", count: 2, avg_ms: 5000, samples: [{ session_id: "a", event_id: "e1" }] },
    { from: "RESERVATION", to: "CANCELLATION", count: 2, avg_ms: 9000, samples: [] },
    { from: "CANCELLATION", to: "RESERVATION", count: 1, avg_ms: 2000, samples: [] },
  ],
};

test("arc diagram: canonical order, forward arcs above, returns below, thickness by count", () => {
  const L = arcLayout(graph, 800);
  assert.deepEqual(L.nodes.map((n) => n.id), ["LOGIN", "RESERVATION", "CANCELLATION"]);
  assert.ok((L.nodes[0] as { x: number }).x < (L.nodes[2] as { x: number }).x);
  const fwd = L.edges.find((e) => e.from === "RESERVATION" && e.to === "CANCELLATION");
  const back = L.edges.find((e) => e.from === "CANCELLATION" && e.to === "RESERVATION");
  assert.ok(fwd?.above && back && !back.above);
  assert.ok(fwd.labelY < L.baseline && back.labelY > L.baseline);
  assert.ok(fwd.width > back.width);
  assert.equal(L.nodes.find((n) => n.id === "RESERVATION")?.r, 16, "largest node gets the largest radius");
  for (const e of L.edges) assert.match(e.d, /^M \d+ \d+ C /);
  assert.ok(L.height > L.baseline);
  assert.deepEqual(arcLayout(graph, 800), L, "deterministic");
});

test("timeline: lanes per tab, ticks inside lanes, overlapping findings packed into rows", () => {
  const t0 = 1_000_000;
  const L = timelineLayout(
    {
      t0,
      t1: t0 + 60_000,
      segments: [
        { segment_id: "s#0", tab_id: 1, workflow: "LOGIN", start_ts: t0, duration_ms: 30_000, end_ts: t0 + 29_000, event_count: 3 },
        { segment_id: "s#1", tab_id: 1, workflow: "RESERVATION", start_ts: t0 + 30_000, duration_ms: 30_000, end_ts: t0 + 60_000, event_count: 2 },
      ],
      events: [
        { id: "e0", ts: t0, tab_id: null, kind: "SESSION_CHANGE", severity: "info" },
        { id: "e1", ts: t0 + 1000, tab_id: 1, kind: "CLICK", severity: "info" },
        { id: "e2", ts: t0 + 59_000, tab_id: 2, kind: "ERROR", severity: "error" },
      ],
      findings: [
        { finding_id: "f1", title: "a", severity: "info", timestamp_range: { start: t0, end: t0 + 50_000 } },
        { finding_id: "f2", title: "b", severity: "warn", timestamp_range: { start: t0 + 10_000, end: t0 + 20_000 } },
        { finding_id: "f3", title: "c", severity: "info", timestamp_range: { start: t0 + 55_000, end: t0 + 56_000 } },
      ],
    },
    1000,
  );
  assert.deepEqual(L.lanes.map((l) => l.label), ["tab 1", "tab 2", "session"]);
  for (const t of L.ticks) {
    const lane = L.lanes.find((l) => t.y1 >= l.y && t.y2 <= l.y + l.h);
    assert.ok(lane, `tick ${t.id} inside a lane`);
  }
  const rows = new Map(L.findingBands.map((b) => [b.id, b.y]));
  assert.notEqual(rows.get("f1"), rows.get("f2"), "overlapping findings do not share a row");
  assert.equal(rows.get("f3"), rows.get("f1"), "non-overlapping findings reuse the first row");
  const [a, b] = L.segments;
  assert.ok(a && b && a.x + a.w <= b.x, "2px surface gap between touching segments");
  assert.ok(L.axis.length >= 2);
  assert.ok(L.axisY > L.findingsY);
});
