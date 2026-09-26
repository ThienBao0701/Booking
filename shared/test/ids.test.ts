import { test } from "node:test";
import assert from "node:assert/strict";

import { newId, newPrefixedId, isId, type IdEnv } from "../src/ids.ts";
import { SequenceCounter, formatClock } from "../src/time.ts";

test("newId produces 26-char sortable ids", () => {
  const a = newId();
  assert.equal(a.length, 26);
  assert.ok(isId(a));
});

test("ids are time-sortable", () => {
  let t = 1_000;
  const env: IdEnv = {
    now: () => (t += 1000),
    randomBytes: (n) => new Uint8Array(n), // zeros: isolate time component
  };
  const first = newId(env);
  const second = newId(env);
  assert.ok(first < second, `${first} should sort before ${second}`);
});

test("prefixed ids carry the prefix and a valid id", () => {
  const id = newPrefixedId("session");
  assert.match(id, /^session_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("isId rejects malformed ids", () => {
  assert.ok(!isId("short"));
  assert.ok(!isId(""));
  assert.ok(!isId(123 as unknown));
});

test("SequenceCounter is strictly increasing", () => {
  const c = new SequenceCounter();
  assert.equal(c.next(), 0);
  assert.equal(c.next(), 1);
  assert.equal(c.peek(), 2);
  assert.equal(c.next(), 2);
});

test("formatClock renders HH:MM:SS in UTC", () => {
  // 1970-01-01T10:21:03Z
  const ts = (10 * 3600 + 21 * 60 + 3) * 1000;
  assert.equal(formatClock(ts), "10:21:03");
});
