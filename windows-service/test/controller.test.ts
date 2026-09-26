import { test } from "node:test";
import assert from "node:assert/strict";

import { MockExtranetController, parseSelector } from "../src/automation/mock-controller.ts";
import { ControllerError } from "../src/automation/controller.ts";

const BASE = "http://127.0.0.1:4599";
const HTML = `<!doctype html><html data-app="mock-extranet"><head><title>Mock Extranet</title></head><body></body></html>`;

/** Minimal in-memory stand-in for the mock's HTTP surface (unit scope only). */
function stubFetch(opts: { app?: boolean; healthy?: boolean } = {}) {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const db = {
    properties: [] as Array<{ id: string; name: string }>,
    rooms: [] as Array<{ id: string; propertyId: string }>,
    reservations: [] as Array<{ id: string; status: string }>,
    events: 0,
  };
  let n = 0;
  const id = () => `ID${++n}`;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ method, path: url.pathname + url.search, body });
    const p = url.pathname;
    if (p === "/healthz") return json(opts.healthy === false ? 503 : 200, { status: opts.healthy === false ? "down" : "ok" });
    if ((p === "/" || p === "/index.html") && method === "GET") {
      return new Response(opts.app === false ? "<html>other app</html>" : HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (p === "/api/properties" && method === "GET") return json(200, { properties: db.properties });
    if (p === "/api/rooms" && method === "GET") return json(200, { rooms: db.rooms });
    if (p === "/api/reservations" && method === "GET") return json(200, { reservations: db.reservations });
    if (p === "/api/events") return json(200, { events: [], total: db.events });
    if (method === "POST") {
      db.events += 1;
      if (p === "/api/login") return json(200, { event: {} });
      if (p === "/api/properties") {
        const prop = { id: id(), name: String(body.name) };
        db.properties.push(prop);
        return json(201, { property: prop });
      }
      if (p === "/api/rooms") {
        if (!db.properties.some((x) => x.id === body.propertyId)) return json(404, { error: "property not found" });
        const room = { id: id(), propertyId: String(body.propertyId) };
        db.rooms.push(room);
        return json(201, { room });
      }
      if (p === "/api/rates") return json(201, { rate: { id: id(), ...body } });
      if (p === "/api/reservations") {
        const r = { id: id(), status: "confirmed" };
        db.reservations.push(r);
        return json(201, { reservation: r });
      }
      const cancel = /^\/api\/reservations\/([^/]+)\/cancel$/.exec(p);
      if (cancel) {
        const r = db.reservations.find((x) => x.id === cancel[1]);
        if (!r) return json(404, { error: "reservation not found" });
        if (r.status === "cancelled") return json(409, { error: "already cancelled" });
        r.status = "cancelled";
        return json(200, { reservation: r });
      }
      if (p === "/api/reviews") {
        const rating = Number(body.rating);
        if (!(rating >= 1 && rating <= 5)) return json(400, { error: "rating must be 1..5" });
        return json(201, { review: { id: id() } });
      }
      if (p === "/api/reports") return json(200, { report: { propertyId: body.propertyId } });
    }
    return json(404, { error: "not_found" });
  }) as typeof fetch;
  return { fetchImpl, requests, db };
}

async function launched(opts: { app?: boolean; healthy?: boolean } = {}) {
  const stub = stubFetch(opts);
  const c = new MockExtranetController({ fetch: stub.fetchImpl, pollMs: 5, defaultTimeoutMs: 100 });
  await c.launch({ baseUrl: BASE });
  await c.navigate("/");
  return { c, ...stub };
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof ControllerError && e.code === code, `expected ${code}`);
}

test("launch refuses non-loopback targets, unhealthy mocks and non-mock apps", async () => {
  const stub = stubFetch();
  await rejects(new MockExtranetController({ fetch: stub.fetchImpl }).launch({ baseUrl: "https://real-extranet.example.com" }), "NAVIGATION_BLOCKED");
  await rejects(new MockExtranetController({ fetch: stubFetch({ healthy: false }).fetchImpl }).launch({ baseUrl: BASE }), "TARGET_ERROR");
  await rejects(new MockExtranetController({ fetch: stubFetch({ app: false }).fetchImpl }).launch({ baseUrl: BASE }), "TARGET_ERROR");
});

test("actions before launch / navigation fail clearly", async () => {
  const c = new MockExtranetController({ fetch: stubFetch().fetchImpl });
  await rejects(c.click("#login-submit"), "NOT_LAUNCHED");
});

test("navigation is bound to the authorized origin", async () => {
  const { c } = await launched();
  await rejects(c.navigate("https://evil.example/"), "NAVIGATION_BLOCKED");
  await rejects(c.navigate("http://127.0.0.1:9999/"), "NAVIGATION_BLOCKED");
  await c.navigate("/");
  assert.equal(c.getCurrentUrl(), `${BASE}/`);
});

test("non-app pages have no app elements", async () => {
  const { c } = await launched();
  await c.navigate("/does-not-exist");
  assert.equal((await c.getPageMetadata()).status, 404);
  await rejects(c.type("#login-username", "op"), "NOT_VISIBLE");
});

test("only elements of the active view are interactable", async () => {
  const { c } = await launched();
  await rejects(c.type("#prop-name", "Villa"), "NOT_VISIBLE");
  await c.click('button[data-view="property"]');
  await c.type("#prop-name", "Villa");
  assert.equal((await c.getPageMetadata()).view, "property");
});

test("element kinds are enforced (like a browser)", async () => {
  const { c } = await launched();
  await c.click('[data-view="rooms"]');
  await rejects(c.type("#room-property", "x"), "WRONG_ELEMENT");
  await rejects(c.select("#room-name", "x"), "WRONG_ELEMENT");
  await rejects(c.click("#nope"), "ELEMENT_NOT_FOUND");
  await rejects(c.click(".something-else"), "ELEMENT_NOT_FOUND");
});

test("action requests mirror the page's client script; $last binds created entities", async () => {
  const { c, requests } = await launched();
  await c.type("#login-username", "operator");
  await c.click("#login-submit");
  assert.deepEqual(requests.at(-1), { method: "POST", path: "/api/login", body: { username: "operator" } });

  await c.click('[data-view="property"]');
  await c.type("#prop-name", "Villa");
  await c.click('[data-action="createProperty"]');
  assert.deepEqual(requests.at(-1)?.body, { name: "Villa", address: "" });

  await c.click('[data-view="rooms"]');
  await c.select("#room-property", "$last");
  await c.type("#room-name", "Deluxe");
  await c.click("#room-submit");
  const roomReq = requests.at(-1);
  assert.equal(roomReq?.path, "/api/rooms");
  assert.deepEqual(roomReq?.body, { propertyId: "ID1", name: "Deluxe", roomType: "", capacity: 2 }, "HTML default capacity=2");

  await c.click('[data-view="rates"]');
  await c.click("#rate-submit"); // untouched fields: select → first option, label/amount → HTML defaults
  assert.deepEqual(requests.at(-1)?.body, { roomId: "ID2", label: "standard", amount: 120 });

  const state = await c.captureState();
  assert.deepEqual(state.entities, { property: "ID1", room: "ID2", rate: "ID3" });
});

test("select validates options; unresolved $last references fail", async () => {
  const { c } = await launched();
  await c.click('[data-view="rooms"]');
  await rejects(c.select("#room-property", "$last"), "UNRESOLVED_REFERENCE");
  await rejects(c.select("#room-property", "NOT-AN-ID"), "OPTION_NOT_FOUND");
});

test("server-side rejection fails the step with the server's message", async () => {
  const { c } = await launched();
  await c.click('[data-view="property"]');
  await c.type("#prop-name", "P");
  await c.click("#prop-submit");
  await c.click('[data-view="reviews"]');
  await c.type("#rev-rating", "9");
  await assert.rejects(c.click("#rev-submit"), (e: unknown) => e instanceof ControllerError && e.code === "TARGET_ERROR" && /rating must be 1\.\.5/.test(e.message) && !e.retryable);
});

test("cancel rows: [data-cancel] = first row (CSS semantics), $last = the one we created", async () => {
  const { c, db } = await launched();
  db.reservations.push({ id: "OLD", status: "confirmed" });
  await c.click('[data-view="property"]');
  await c.type("#prop-name", "P");
  await c.click("#prop-submit");
  await c.click('[data-view="rooms"]');
  await c.click("#room-submit");
  await c.click('[data-view="reservations"]');
  await c.click("#res-submit");
  await c.click('button[data-cancel="$last"]');
  assert.deepEqual(db.reservations.map((r) => r.status), ["confirmed", "cancelled"]);
  await c.click("button[data-cancel]");
  assert.deepEqual(db.reservations.map((r) => r.status), ["cancelled", "cancelled"]);
  await rejects(c.click('button[data-cancel="$last"]'), "TARGET_ERROR"); // 409 already cancelled
});

test("history: back/forward walk entries; reload resets unsaved inputs", async () => {
  const { c } = await launched();
  await c.navigate("/index.html");
  await c.back();
  assert.equal(c.getCurrentUrl(), `${BASE}/`);
  await c.forward();
  assert.equal(c.getCurrentUrl(), `${BASE}/index.html`);
  await rejects(c.forward(), "NO_HISTORY");
  await c.type("#login-username", "draft");
  await c.reload();
  assert.deepEqual((await c.captureState()).fields, {}, "reload clears typed values");
  assert.equal((await c.getPageMetadata()).view, "login", "reload returns to the default view");
});

test("waitFor polls dynamic conditions and times out (retryable)", async () => {
  const { c } = await launched();
  await assert.rejects(
    c.waitFor('#actor[data-actor]:not([data-actor=""])', { timeoutMs: 30 }),
    (e: unknown) => e instanceof ControllerError && e.code === "TIMEOUT" && e.retryable,
  );
  await c.type("#login-username", "op");
  await c.click("#login-submit");
  await c.waitFor('#actor[data-actor]:not([data-actor=""])');
  await c.click('[data-view="property"]');
  await c.type("#prop-name", "P");
  await c.click("#prop-submit");
  await c.click('[data-view="reports"]');
  await rejects(c.waitFor('#report-out[data-report="1"]', { timeoutMs: 20 }), "TIMEOUT");
  await c.click("#report-submit");
  await c.waitFor('#report-out[data-report="1"]');
  await c.waitFor('.view.active[data-view="reports"]');
});

test("an aborted signal aborts the action", async () => {
  const { c } = await launched();
  const ctrl = new AbortController();
  ctrl.abort();
  await rejects(c.navigate("/", { signal: ctrl.signal }), "ABORTED");
});

test("snapshot/restore round-trips the page model (not target data)", async () => {
  const { c } = await launched();
  await c.click('[data-view="property"]');
  await c.type("#prop-name", "Before");
  const snap = await c.snapshot();
  await c.type("#prop-name", "After");
  await c.click('[data-view="rooms"]');
  await c.restore(snap);
  const s = await c.captureState();
  assert.equal(s.view, "property");
  assert.deepEqual(s.fields, { "prop-name": "Before" });
});

test("tabs, metadata and screenshots", async () => {
  const { c } = await launched();
  const t2 = await c.openTab("/");
  assert.equal((await c.getPageMetadata()).tabId, t2);
  assert.equal((await c.getPageMetadata()).title, "Mock Extranet");
  await c.closeTab();
  assert.equal((await c.getPageMetadata()).tabId, "tab-1");
  await rejects(c.closeTab("tab-99"), "NO_TAB");
  const shot = await c.captureScreenshot();
  assert.equal(shot.supported, false);
  assert.match(shot.reason ?? "", /no rendering surface/);
});

test("captureState redacts typed values", async () => {
  const { c } = await launched();
  await c.click('[data-view="messages"]');
  await c.type("#msg-text", "reach me at guest@example.com");
  assert.deepEqual((await c.captureState()).fields, { "msg-text": "reach me at [REDACTED]" });
});

test("selector dialects parse to the same targets", () => {
  assert.deepEqual(parseSelector("#login-submit"), { kind: "id", id: "login-submit" });
  assert.deepEqual(parseSelector('button[data-action="login"]'), { kind: "action", dataAction: "login" });
  assert.deepEqual(parseSelector("[data-action=login]"), { kind: "action", dataAction: "login" });
  assert.deepEqual(parseSelector('#nav button[data-view="rooms"]'), { kind: "nav", view: "rooms" });
  assert.deepEqual(parseSelector('.view.active[data-view="rooms"]'), { kind: "panel", view: "rooms" });
  assert.deepEqual(parseSelector("button[data-cancel]"), { kind: "cancel", ref: undefined });
  assert.deepEqual(parseSelector('button[data-cancel="$last"]'), { kind: "cancel", ref: "$last" });
  assert.deepEqual(parseSelector('#actor[data-actor]:not([data-actor=""])'), { kind: "id", id: "actor", attr: { name: "data-actor", op: "nonEmpty" } });
  assert.equal(parseSelector("div > span").kind, "unknown");
});
