/**
 * E2E: MockExtranetController against the REAL mock Extranet on 127.0.0.1:4599
 * (reused if already running, never stopped if it was).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { MockExtranetController } from "../../windows-service/src/automation/mock-controller.ts";
import { ControllerError } from "../../windows-service/src/automation/controller.ts";
import { VIEWS, allElementIds } from "../../windows-service/src/automation/mock-page-map.ts";
import { ensureMock, type MockHandle } from "./harness.ts";

let mock: MockHandle;
before(async () => {
  mock = await ensureMock();
});
after(async () => {
  await mock.close();
});

async function eventsSince(since: number): Promise<Array<{ workflow: string; action: string; actor: string | null }>> {
  const res = await fetch(`${mock.url}/api/events?since=${since}`);
  return ((await res.json()) as { events: Array<{ workflow: string; action: string; actor: string | null }> }).events;
}
async function eventTotal(): Promise<number> {
  return ((await (await fetch(`${mock.url}/api/events?since=1000000000`)).json()) as { total: number }).total;
}

test("contract: the page map matches the HTML the running mock serves", async () => {
  const html = await (await fetch(`${mock.url}/`)).text();
  for (const id of allElementIds()) assert.ok(html.includes(`id="${id}"`), `mock UI has no element #${id}`);
  for (const v of VIEWS) {
    assert.ok(html.includes(`data-view="${v.name}"`), `mock UI has no view ${v.name}`);
    for (const a of v.actions) assert.ok(html.includes(`data-action="${a.dataAction}"`), `missing data-action ${a.dataAction}`);
    for (const f of v.fields.filter((x) => x.defaultValue !== undefined)) {
      const tag = new RegExp(`<[^>]*id="${f.id}"[^>]*>`).exec(html)?.[0] ?? "";
      assert.ok(tag.includes(`value="${f.defaultValue}"`), `#${f.id} default should be "${f.defaultValue}"`);
    }
    for (const f of v.fields) {
      const tag = new RegExp(`<(\\w+)[^>]*id="${f.id}"`).exec(html)?.[1];
      assert.equal(tag, f.tag, `#${f.id} should be a <${f.tag}>`);
    }
  }
});

test("drives every Extranet module end-to-end and the mock emits the documented workflow", async () => {
  const c = new MockExtranetController({ pollMs: 20 });
  await c.launch({ baseUrl: mock.url });
  const since = await eventTotal();
  const run = `e2e-${Date.now()}`;
  try {
    await c.navigate("/");
    await c.type("#login-username", run);
    await c.click("#login-submit");
    await c.waitFor('#actor[data-actor]:not([data-actor=""])');

    await c.click('button[data-view="property"]');
    await c.type("#prop-name", `Villa ${run}`);
    await c.type("#prop-address", "1 Test Rd");
    await c.click("#prop-submit");

    await c.click('button[data-view="rooms"]');
    await c.select("#room-property", "$last");
    await c.type("#room-name", "Deluxe");
    await c.type("#room-type", "double");
    await c.click("#room-submit");

    await c.click('button[data-view="rates"]');
    await c.select("#rate-room", "$last");
    await c.type("#rate-amount", "150");
    await c.click("#rate-submit");

    await c.click('button[data-view="reservations"]');
    await c.select("#res-property", "$last");
    await c.select("#res-room", "$last");
    await c.type("#res-guest", "Test Guest");
    await c.type("#res-in", "2026-10-01");
    await c.type("#res-out", "2026-10-03");
    await c.click("#res-submit");
    await c.waitFor('button[data-cancel="$last"]');
    await c.click('button[data-cancel="$last"]');

    await c.click('button[data-view="messages"]');
    await c.type("#msg-text", "Your booking is confirmed.");
    await c.click("#msg-submit");

    await c.click('button[data-view="reviews"]');
    await c.select("#rev-property", "$last");
    await c.type("#rev-text", "Great stay");
    await c.click("#rev-submit");

    await c.click('button[data-view="photos"]');
    await c.select("#photo-property", "$last");
    await c.click("#photo-submit");

    await c.click('button[data-view="reports"]');
    await c.select("#report-property", "$last");
    await c.click("#report-submit");
    await c.waitFor('#report-out[data-report="1"]');

    const labels = (await eventsSince(since)).filter((e) => e.actor === run).map((e) => e.workflow);
    assert.deepEqual(labels, [
      "LOGIN",
      "PROPERTY_SETUP",
      "ROOM_SETUP",
      "RATE_SETUP",
      "RESERVATION",
      "CANCELLATION",
      "MESSAGING",
      "REVIEW",
      "PHOTO",
      "REPORTING",
    ]);
    const state = await c.captureState();
    assert.equal(state.view, "reports");
    assert.ok(state.entities.property && state.entities.room && state.entities.reservation);
    assert.ok((state.server.cancelled ?? 0) >= 1);
  } finally {
    await c.close();
  }
});

test("real server validation surfaces as a step failure", async () => {
  const c = new MockExtranetController({ pollMs: 20 });
  await c.launch({ baseUrl: mock.url });
  try {
    await c.navigate("/");
    await c.type("#login-username", "validator");
    await c.click("#login-submit");
    await c.click('button[data-view="property"]');
    await c.type("#prop-name", "Rating check");
    await c.click("#prop-submit");
    await c.click('button[data-view="reviews"]');
    await c.select("#rev-property", "$last");
    await c.type("#rev-rating", "9");
    await assert.rejects(
      c.click("#rev-submit"),
      (e: unknown) => e instanceof ControllerError && e.code === "TARGET_ERROR" && /rating must be 1\.\.5/.test(e.message),
    );
  } finally {
    await c.close();
  }
});

test("the controller cannot be pointed at a non-local system", async () => {
  const c = new MockExtranetController();
  await assert.rejects(c.launch({ baseUrl: "https://admin.real-extranet.example" }), /only drives a local mock/);
  await c.launch({ baseUrl: mock.url });
  await assert.rejects(c.navigate("https://admin.real-extranet.example/"), /outside the authorized origin/);
  await c.close();
});
