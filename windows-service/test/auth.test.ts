import { test } from "node:test";
import assert from "node:assert/strict";

import { generateToken, safeEqual, parseBearer, verifyToken } from "../src/auth.ts";

test("generateToken yields a long url-safe token", () => {
  const t = generateToken();
  assert.ok(t.length >= 32);
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(generateToken(), generateToken());
});

test("safeEqual compares correctly", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
});

test("parseBearer extracts the token", () => {
  assert.equal(parseBearer("Bearer xyz"), "xyz");
  assert.equal(parseBearer("bearer xyz"), "xyz");
  assert.equal(parseBearer("Basic xyz"), undefined);
  assert.equal(parseBearer(undefined), undefined);
});

test("verifyToken requires an exact match", () => {
  assert.ok(verifyToken("secrettoken123456", "secrettoken123456"));
  assert.ok(!verifyToken("wrong", "secrettoken123456"));
  assert.ok(!verifyToken(undefined, "secrettoken123456"));
});
