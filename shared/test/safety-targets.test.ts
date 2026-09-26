import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateReplay, isLoopbackUrl } from "../src/safety/policy.ts";

test("isLoopbackUrl accepts only exact loopback hosts", () => {
  for (const u of [
    "http://127.0.0.1:4599",
    "http://127.0.0.1:4599/",
    "http://localhost:4599/login",
    "https://localhost",
    "http://[::1]:4599/x?y=1",
    "HTTP://LOCALHOST:80",
  ]) {
    assert.ok(isLoopbackUrl(u), `${u} should be loopback`);
  }
});

test("isLoopbackUrl rejects look-alikes and authority tricks", () => {
  for (const u of [
    "https://real-extranet.example.com",
    "http://127.0.0.1.evil.example",
    "http://127.0.0.1@evil.example",
    "http://user:pass@localhost:4599",
    "http://evil.example#@127.0.0.1",
    "http://evil.example/127.0.0.1",
    "http://localhost.evil.example",
    "http://127.0.0.2",
    "ftp://127.0.0.1",
    "127.0.0.1:4599",
    "http://localhost:99999x",
    "",
  ]) {
    assert.ok(!isLoopbackUrl(u), `${u} must NOT be loopback`);
  }
});

test("regression: a real site labelled 'mock' is denied in SIMULATE", () => {
  const d = evaluateReplay("SIMULATE", { kind: "mock", baseUrl: "https://real-extranet.example.com" });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "MOCK_TARGET_NOT_LOCAL");
});

test("regression: 'mock' label cannot smuggle a real host via userinfo", () => {
  const d = evaluateReplay("AUTHORIZED_AUTOMATION", { kind: "mock", baseUrl: "http://127.0.0.1@evil.example" });
  assert.equal(d.code, "MOCK_TARGET_NOT_LOCAL");
});

test("genuine local mock remains allowed in SIMULATE", () => {
  assert.equal(evaluateReplay("SIMULATE", { kind: "mock", baseUrl: "http://127.0.0.1:4599" }).allowed, true);
});
