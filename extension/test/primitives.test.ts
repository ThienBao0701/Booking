import { test } from "node:test";
import assert from "node:assert/strict";

import { Debouncer } from "../src/recorder/debounce.ts";
import { Deduplicator } from "../src/recorder/dedup.ts";
import { MemoryQueue, type EventQueue } from "../src/recorder/queue.ts";
import { DomSummaryAccumulator } from "../src/recorder/dom-summary.ts";
import { detectWorkflow, ruleMatches } from "../src/recorder/workflow-rules.ts";
import { pagePath, urlHost, urlOrigin } from "../src/common/paths.ts";
import type { RecordedEvent } from "../src/shared.ts";
import { FakeTimers } from "./fakes.ts";

function ev(id: string, overrides: Partial<RecordedEvent> = {}): RecordedEvent {
  return {
    event_id: id,
    session_id: "s",
    seq: 0,
    timestamp: 1000,
    page: "/",
    workflow: "UNKNOWN",
    action: "click",
    metadata: {},
    ...overrides,
  };
}

// ---- debounce ----

test("debouncer fires once after quiet period", async () => {
  const t = new FakeTimers(0);
  let n = 0;
  const d = new Debouncer(() => (n += 1), 100, 1000, t);
  d.trigger();
  await t.advance(50);
  d.trigger();
  await t.advance(99);
  assert.equal(n, 0);
  await t.advance(1);
  assert.equal(n, 1);
});

test("debouncer max-wait bounds latency under constant activity", async () => {
  const t = new FakeTimers(0);
  let n = 0;
  const d = new Debouncer(() => (n += 1), 100, 300, t);
  for (let i = 0; i < 10; i++) {
    d.trigger();
    await t.advance(50);
  }
  assert.ok(n >= 1, "must have fired within max-wait despite continuous triggers");
});

test("debouncer cancel prevents firing", async () => {
  const t = new FakeTimers(0);
  let n = 0;
  const d = new Debouncer(() => (n += 1), 100, 500, t);
  d.trigger();
  d.cancel();
  await t.advance(1000);
  assert.equal(n, 0);
});

// ---- dedup ----

test("dedup by id and by content within the window", () => {
  const d = new Deduplicator({ windowMs: 100, maxEntries: 10 });
  assert.equal(d.isDuplicate(ev("a")), false);
  assert.equal(d.isDuplicate(ev("a")), true, "same id");
  assert.equal(d.isDuplicate(ev("b")), true, "same content, same ms");
  assert.equal(d.isDuplicate(ev("c", { timestamp: 1200 })), false, "same content outside window");
  assert.equal(d.isDuplicate(ev("d", { timestamp: 1201, workflow: "LOGIN" })), false, "different workflow");
});

test("dedup never collapses session or transition events", () => {
  const d = new Deduplicator({ windowMs: 1000 });
  assert.equal(d.isDuplicate(ev("t1", { action: "workflow_transition" })), false);
  assert.equal(d.isDuplicate(ev("t2", { action: "workflow_transition" })), false);
});

test("dedup memory is bounded", () => {
  const d = new Deduplicator({ windowMs: 10, maxEntries: 3 });
  for (let i = 0; i < 10; i++) d.isDuplicate(ev(`id${i}`, { page: `/${i}` }));
  assert.equal(d.isDuplicate(ev("id0", { page: "/0", timestamp: 5000 })), false, "evicted id is forgotten");
});

// ---- queue contract (any EventQueue implementation must pass) ----

export async function queueContract(q: EventQueue): Promise<void> {
  await q.push([ev("1"), ev("2"), ev("3")]);
  await q.push([ev("2")]); // duplicate id ignored
  assert.equal(await q.size(), 3);
  assert.deepEqual((await q.peek(2)).map((e) => e.event_id), ["1", "2"]);
  await q.ack(["1", "nope"]);
  assert.deepEqual((await q.peek(10)).map((e) => e.event_id), ["2", "3"]);
  await q.push([ev("4"), ev("5")]);
  assert.equal(await q.trim(2), 2);
  assert.deepEqual((await q.peek(10)).map((e) => e.event_id), ["4", "5"], "trim drops oldest");
  await q.clear();
  assert.equal(await q.size(), 0);
}

test("MemoryQueue satisfies the EventQueue contract", async () => {
  await queueContract(new MemoryQueue());
});

// ---- DOM summary ----

test("DOM summary aggregates counts and top targets, never values", () => {
  const acc = new DomSummaryAccumulator();
  assert.equal(acc.drain(), undefined);
  acc.add([
    { type: "childList", addedNodes: 3, removedNodes: 1, targetSelector: "#feed" },
    { type: "childList", addedNodes: 1, removedNodes: 0, targetSelector: "#feed" },
    { type: "attributes", addedNodes: 0, removedNodes: 0, attributeName: "class", targetSelector: "nav" },
    { type: "characterData", addedNodes: 0, removedNodes: 0 },
  ]);
  const s = acc.drain();
  assert.deepEqual(s, {
    mutations: 4,
    added: 4,
    removed: 1,
    attributes: 1,
    characterData: 1,
    attributeNames: ["class"],
    topTargets: ["#feed", "nav"],
  });
  assert.equal(acc.drain(), undefined, "drain resets");
});

// ---- workflow rules ----

test("mock SPA views map to workflow labels", () => {
  const cases: Array<[string, string]> = [
    ["login", "LOGIN"],
    ["property", "PROPERTY_SETUP"],
    ["rooms", "ROOM_SETUP"],
    ["rates", "RATE_SETUP"],
    ["reservations", "RESERVATION"],
    ["messages", "MESSAGING"],
    ["reviews", "REVIEW"],
    ["photos", "PHOTO"],
    ["reports", "REPORTING"],
  ];
  for (const [view, label] of cases) assert.equal(detectWorkflow({ page: "/", view }), label, view);
});

test("cancellation is detected from the target inside reservations", () => {
  assert.equal(
    detectWorkflow({ page: "/", view: "reservations", action: "click", target: { selector: "button[data-cancel]" } }),
    "CANCELLATION",
  );
  assert.equal(
    detectWorkflow({ page: "/", view: "reservations", action: "click", target: { selector: "#res-submit" } }),
    "RESERVATION",
  );
});

test("Extranet-style paths map to labels; specific beats generic", () => {
  assert.equal(detectWorkflow({ page: "/sign-in" }), "LOGIN");
  assert.equal(detectWorkflow({ page: "/property/42/rooms" }), "ROOM_SETUP");
  assert.equal(detectWorkflow({ page: "/property/42/rates" }), "RATE_SETUP");
  assert.equal(detectWorkflow({ page: "/property/42" }), "PROPERTY_SETUP");
  assert.equal(detectWorkflow({ page: "/bookings/123/cancel" }), "CANCELLATION");
  assert.equal(detectWorkflow({ page: "/inbox" }), "MESSAGING");
  assert.equal(detectWorkflow({ page: "/guest-reviews" }), "REVIEW");
  assert.equal(detectWorkflow({ page: "/analytics" }), "REPORTING");
});

test("ambiguous input is UNKNOWN, and empty rules never match", () => {
  assert.equal(detectWorkflow({ page: "/help" }), "UNKNOWN");
  assert.equal(detectWorkflow({ page: "/roomservice" }), "UNKNOWN", "word-boundary: roomservice is not rooms");
  assert.equal(ruleMatches({ workflow: "LOGIN" }, { page: "/login" }), false);
});

// ---- paths ----

test("pagePath keeps the path only and redacts", () => {
  assert.equal(pagePath("https://h.example/a/b?token=x#y"), "/a/b");
  assert.equal(pagePath("http://127.0.0.1:4599"), "/");
  assert.equal(pagePath("/x?y=1"), "/x");
  assert.equal(pagePath(undefined), "/");
  assert.equal(pagePath("/guest/me@example.com"), "/guest/[REDACTED]");
});

test("urlOrigin / urlHost", () => {
  assert.equal(urlOrigin("HTTPS://Extranet.Example:8443/x"), "https://extranet.example:8443");
  assert.equal(urlHost("http://127.0.0.1:4599/"), "127.0.0.1");
  assert.equal(urlHost("http://[::1]:4599/"), "[::1]");
  assert.equal(urlHost("not a url"), undefined);
});
