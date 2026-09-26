import { test } from "node:test";
import assert from "node:assert/strict";

import { isHostAllowed, isOriginAllowed, RateLimiter } from "../src/security.ts";

test("host validation matches only bound loopback host:port (anti-rebinding)", () => {
  const base = { expectedHost: "127.0.0.1", expectedPort: 4577 };
  assert.ok(isHostAllowed({ hostHeader: "127.0.0.1:4577", ...base }));
  assert.ok(isHostAllowed({ hostHeader: "localhost:4577", ...base }));
  // A rebinding attempt: attacker domain resolving to 127.0.0.1 but Host differs.
  assert.ok(!isHostAllowed({ hostHeader: "evil.example.com:4577", ...base }));
  assert.ok(!isHostAllowed({ hostHeader: "127.0.0.1:9999", ...base }));
  assert.ok(!isHostAllowed({ hostHeader: undefined, ...base }));
});

test("origin validation rejects web origins, allows extension + none", () => {
  assert.ok(isOriginAllowed({ origin: undefined, allowedOrigins: [] }));
  assert.ok(isOriginAllowed({ origin: "chrome-extension://abcdef", allowedOrigins: [] }));
  assert.ok(!isOriginAllowed({ origin: "https://evil.example.com", allowedOrigins: [] }));
  assert.ok(!isOriginAllowed({ origin: "http://localhost:3000", allowedOrigins: [] }));
});

test("origin allow-list is enforced when configured", () => {
  const allowedOrigins = ["chrome-extension://good"];
  assert.ok(isOriginAllowed({ origin: "chrome-extension://good", allowedOrigins }));
  assert.ok(!isOriginAllowed({ origin: "chrome-extension://bad", allowedOrigins }));
});

test("rate limiter enforces a fixed window", () => {
  const rl = new RateLimiter(1000, 2);
  const now = 10_000;
  assert.ok(rl.allow("k", now));
  assert.ok(rl.allow("k", now));
  assert.ok(!rl.allow("k", now)); // 3rd in window blocked
  assert.ok(rl.allow("k", now + 1001)); // new window
});
