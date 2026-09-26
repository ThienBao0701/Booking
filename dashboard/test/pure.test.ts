/** Dashboard pure modules: formatting, routing, token handling, data prep. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { eventSummary, fmtBytes, fmtCompact, fmtDuration, fmtInt, fmtPct, label, parseData, shortId } from "../src/format.ts";
import { apiQuery, buildHash, parseRoute, resolveRange } from "../src/route.ts";
import { isPlausibleToken, takeToken } from "../src/token.ts";
import { fillDays, modeOf, ranked } from "../src/data.ts";
import { safeHref } from "../src/dom.ts";

test("durations, numbers and labels format for humans", () => {
  assert.equal(fmtDuration(350), "350 ms");
  assert.equal(fmtDuration(12_340), "12 s");
  assert.equal(fmtDuration(4_300), "4.3 s");
  assert.equal(fmtDuration(245_000), "4 min 5 s");
  assert.equal(fmtDuration(120_000), "2 min");
  assert.equal(fmtDuration(7_380_000), "2 h 3 min");
  assert.equal(fmtDuration(-9_300), "−9.3 s");
  assert.equal(fmtDuration(null), "—");
  assert.equal(fmtInt(12345), "12,345");
  assert.equal(fmtCompact(1284), "1,284");
  assert.equal(fmtCompact(12_900), "12.9K");
  assert.equal(fmtCompact(4_200_000), "4.2M");
  assert.equal(fmtPct(0.456), "46%");
  assert.equal(fmtBytes(48_213), "47.1 KiB");
  assert.equal(label("RATE_SETUP"), "Rate setup");
  assert.equal(label(undefined), "—");
  assert.equal(shortId("session_01ABCDEFGHIJKLMNOPQRSTUV", 6), "sessio…STUV");
  assert.equal(shortId("short"), "short");
});

test("event payloads parse defensively and summarise without raw values", () => {
  assert.deepEqual(parseData("{not json"), { unparsable: true });
  assert.deepEqual(parseData("[1]"), { value: [1] });
  assert.equal(eventSummary("WORKFLOW_TRANSITION", { metadata: { from: "LOGIN", to: "RESERVATION" } }), "LOGIN → RESERVATION");
  assert.equal(eventSummary("CLICK", { action: "click", target: { selector: "#save" } }), "click #save");
  assert.equal(eventSummary("FORM_ACTIVITY", { quarantined: true }), "payload quarantined (sensitive content)");
  assert.equal(eventSummary("ERROR", { metadata: { message: "boom" } }), "boom");
});

test("hash routes round-trip with sorted, non-empty parameters", () => {
  assert.deepEqual(parseRoute("#/findings/fnd_123?severity=warn&q=pause"), { page: "findings", id: "fnd_123", params: { severity: "warn", q: "pause" } });
  assert.deepEqual(parseRoute(""), { page: "overview", params: {} });
  assert.deepEqual(parseRoute("#/nope/x"), { page: "overview", params: {} });
  const h = buildHash("events", { session: "s 1", kind: "CLICK", empty: "", nothing: undefined });
  assert.equal(h, "#/events?kind=CLICK&session=s+1");
  assert.deepEqual(parseRoute(h).params, { kind: "CLICK", session: "s 1" });
  assert.equal(buildHash("sessions", {}, "a/b"), "#/sessions/a%2Fb");
  assert.equal(parseRoute("#/sessions/a%2Fb").id, "a/b");
  assert.equal(apiQuery({ a: 1, b: "", c: undefined, d: "x y" }), "?a=1&d=x+y");
  assert.equal(apiQuery({}), "");
});

test("date ranges resolve presets and custom local-day bounds", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.deepEqual(resolveRange({}, now), {});
  assert.deepEqual(resolveRange({ range: "all" }, now), {});
  assert.deepEqual(resolveRange({ range: "7d" }, now), { from: now - 7 * 86_400_000 });
  const c = resolveRange({ range: "custom", from: "2026-09-01", to: "2026-09-02" }, now);
  assert.equal(c.from, Date.parse("2026-09-01T00:00:00"));
  assert.equal(c.to, Date.parse("2026-09-02T23:59:59.999"));
  assert.deepEqual(resolveRange({ range: "custom", from: "garbage" }, now), {});
});

test("token: taken only from #token=…, validated, and never kept in the route", () => {
  const tok = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_";
  assert.deepEqual(takeToken(`#token=${tok}`), { token: tok, rest: "#/overview" });
  assert.deepEqual(takeToken(`#token=${tok}&next=${encodeURIComponent("#/findings?severity=warn")}`), { token: tok, rest: "#/findings?severity=warn" });
  assert.deepEqual(takeToken(`#token=${tok}&next=https://evil.example`), { token: tok, rest: "#/overview" }, "next must be an in-app route");
  assert.deepEqual(takeToken("#token=<script>"), { rest: "#/overview" }, "implausible tokens are dropped, and the fragment still scrubbed");
  assert.deepEqual(takeToken("#/events"), { rest: "#/events" });
  assert.equal(isPlausibleToken("short"), false);
  assert.equal(isPlausibleToken("a".repeat(300)), false);
});

test("hrefs: only in-app routes and same-origin API/dashboard paths are rendered", () => {
  assert.equal(safeHref("#/findings/fnd_1"), "#/findings/fnd_1");
  assert.equal(safeHref("/v1/reports/sessions/s1?format=html"), "/v1/reports/sessions/s1?format=html");
  assert.equal(safeHref("javascript:alert(1)"), "#/overview");
  assert.equal(safeHref("https://evil.example"), "#/overview");
  assert.equal(safeHref("//evil.example/x"), "#/overview");
  assert.equal(safeHref("data:text/html,x"), "#/overview");
});

test("data prep: day gaps filled, mode of values, ranked counts", () => {
  assert.deepEqual(fillDays([{ day: "2026-09-01", count: 3 }, { day: "2026-09-04", count: 1 }]), [
    { day: "2026-09-01", count: 3 },
    { day: "2026-09-02", count: 0 },
    { day: "2026-09-03", count: 0 },
    { day: "2026-09-04", count: 1 },
  ]);
  assert.deepEqual(fillDays([]), []);
  assert.equal(modeOf([{ v: { w: 1 } }, { v: { w: 2 } }, { v: { w: 1 } }, { v: undefined }], (r) => r.v), JSON.stringify({ w: 1 }));
  assert.equal(modeOf([], () => 1), undefined);
  assert.deepEqual(ranked({ a: 1, b: 5, c: 5, d: 2 }, 3), [["b", 5], ["c", 5], ["d", 2]]);
});
