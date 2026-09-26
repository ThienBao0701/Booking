/** Native Messaging contract (Phase 14): schema validation, negotiation, relay route allowlist. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTRACT_VERSION,
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL,
  helloMessage,
  isRelayableRoute,
  negotiateProtocol,
  validateExtensionMessage,
  validateHostMessage,
} from "../src/index.ts";

test("host name follows Chrome's naming rule", () => {
  assert.match(NATIVE_HOST_NAME, /^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
});

test("hello is valid and carries the protocol range and contract version", () => {
  const h = helloMessage("0.1.0");
  assert.deepEqual(h, { type: "hello", protocol: { ...NATIVE_PROTOCOL }, extensionVersion: "0.1.0", contractVersion: CONTRACT_VERSION });
  assert.equal(validateExtensionMessage(h).ok, true);
});

test("extension messages are validated fail-closed", () => {
  const bad: unknown[] = [
    null,
    [],
    { type: "nope" },
    { type: "hello", protocol: { min: 2, max: 1 }, extensionVersion: "1", contractVersion: 1 },
    { type: "hello", protocol: { min: 1, max: 1 }, extensionVersion: "1", contractVersion: 1, extra: true },
    { type: "request", id: "r1", method: "DELETE", path: "/v1/events", headers: {} },
    { type: "request", id: "r1", method: "POST", path: "v1/events", headers: {} },
    { type: "request", id: "has space", method: "POST", path: "/v1/events", headers: {} },
    { type: "request", id: "r1", method: "POST", path: "/v1/events", headers: { cookie: "a=b" } },
    { type: "request", id: "r1", method: "POST", path: "/v1/events", headers: { authorization: "Bearer x\r\nX-Evil: 1" } },
    { type: "request", id: "r1", method: "GET", path: "/healthz", headers: {}, body: "x" },
    { type: "request", id: "r1", method: "POST", path: "/v1/events", headers: {}, body: 42 },
    { type: "ping" },
  ];
  for (const m of bad) assert.equal(validateExtensionMessage(m).ok, false, JSON.stringify(m));
  assert.equal(validateExtensionMessage({ type: "request", id: "r-1_a", method: "POST", path: "/v1/events", headers: { authorization: "Bearer t", "content-type": "application/json", accept: "application/json" }, body: "{}" }).ok, true);
  assert.equal(validateExtensionMessage({ type: "ping", id: "p1" }).ok, true);
});

test("host messages are validated fail-closed", () => {
  assert.equal(validateHostMessage({ type: "welcome", protocol: 1, hostVersion: "0.1.0", contractVersion: 1, service: { url: "http://127.0.0.1:4577", reachable: true, safetyMode: "OBSERVE" } }).ok, true);
  assert.equal(validateHostMessage({ type: "response", id: "r1", status: 200, body: { ok: true } }).ok, true);
  assert.equal(validateHostMessage({ type: "error", code: "origin_not_allowed", message: "no", retryable: false, fatal: true }).ok, true);
  assert.equal(validateHostMessage({ type: "pong", id: "p1" }).ok, true);
  for (const m of [
    { type: "welcome", protocol: 1, hostVersion: "x", contractVersion: 1, service: { url: "u" } },
    { type: "response", id: "r1", status: 700 },
    { type: "error", code: "made_up", message: "", retryable: false, fatal: false },
    { type: "error", code: "timeout", message: "", retryable: "yes", fatal: false },
    { type: "response", id: "r1", status: 200, script: "x" },
  ]) {
    assert.equal(validateHostMessage(m).ok, false, JSON.stringify(m));
  }
});

test("protocol negotiation picks the highest common version or none", () => {
  assert.equal(negotiateProtocol({ min: 1, max: 1 }), 1);
  assert.equal(negotiateProtocol({ min: 1, max: 5 }), 1);
  assert.equal(negotiateProtocol({ min: 2, max: 3 }), undefined);
  assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
});

test("only the bridge's routes are relayable", () => {
  for (const [m, p] of [
    ["GET", "/healthz"],
    ["GET", "/v1/bridge/handshake"],
    ["POST", "/v1/sessions"],
    ["POST", "/v1/sessions/session_01ABC/end"],
    ["POST", "/v1/events"],
    ["POST", "/v1/screenshots"],
  ] as const) {
    assert.equal(isRelayableRoute(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [
    ["POST", "/healthz"],
    ["GET", "/v1/sessions"],
    ["GET", "/v1/events"],
    ["POST", "/v1/replay/prepare"],
    ["POST", "/v1/replay/runs/x/start"],
    ["GET", "/v1/screenshots/abc/image"],
    ["PUT", "/v1/analysis/rules"],
    ["GET", "/dashboard/"],
    ["POST", "/v1/sessions/../end"],
    ["POST", "/v1/sessions/a%2Fb/end"],
    ["POST", "/v1/events?x=1"],
    ["POST", "/v1/sessions/a/b/end"],
  ] as const) {
    assert.equal(isRelayableRoute(m, p), false, `${m} ${p}`);
  }
});
