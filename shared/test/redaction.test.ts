import { test } from "node:test";
import assert from "node:assert/strict";

import {
  redactText,
  redactValue,
  redactFieldValue,
  looksSensitive,
} from "../src/redaction/redact.ts";
import { isSensitiveField, MASK } from "../src/redaction/rules.ts";

test("password-type fields are never read", () => {
  assert.equal(redactFieldValue({ type: "password" }, "hunter2"), undefined);
  assert.equal(redactFieldValue({ name: "user_password" }, "hunter2"), undefined);
  assert.equal(redactFieldValue({ autocomplete: "current-password" }, "x"), undefined);
});

test("sensitive field detection by name/type/autocomplete", () => {
  assert.ok(isSensitiveField({ name: "otp" }));
  assert.ok(isSensitiveField({ name: "cardNumber" }));
  assert.ok(isSensitiveField({ name: "cvv" }));
  assert.ok(isSensitiveField({ name: "api_key" }));
  assert.ok(isSensitiveField({ autocomplete: "one-time-code" }));
  assert.ok(!isSensitiveField({ name: "propertyName" }));
  assert.ok(!isSensitiveField({ name: "roomType" }));
});

test("non-sensitive field values are content-masked but kept", () => {
  assert.equal(redactFieldValue({ name: "propertyName" }, "Seaside Villa"), "Seaside Villa");
  assert.equal(
    redactFieldValue({ name: "note" }, "contact me at a@b.com"),
    `contact me at ${MASK}`,
  );
});

test("redactText masks emails, phones, long numbers, tokens, jwts", () => {
  assert.match(redactText("mail a.b+c@example.com now"), /\[REDACTED\]/);
  assert.match(redactText("card 4111 1111 1111 1111"), /\[REDACTED\]/);
  assert.match(redactText("call +1 (415) 555-2671"), /\[REDACTED\]/);
  assert.match(
    redactText("token eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4"),
    /\[REDACTED\]/,
  );
  assert.match(redactText("key ABCDEFGHIJKLMNOPQRSTUVWX1234"), /\[REDACTED\]/);
});

test("redactText leaves ordinary text intact", () => {
  const s = "Set rate to 120 for room 4";
  assert.equal(redactText(s), s);
});

test("redactValue deep-redacts objects and masks sensitive keys", () => {
  const input = {
    propertyName: "Villa",
    guestEmail: "g@h.com",
    password: "secret",
    nested: { token: "abc", note: "phone +14155552671" },
    list: ["ok", "x@y.com"],
  };
  const out = redactValue(input);
  assert.equal(out.propertyName, "Villa");
  assert.equal(out.guestEmail, MASK);
  assert.equal(out.password, MASK);
  assert.equal(out.nested.token, MASK);
  assert.match(out.nested.note, /\[REDACTED\]/);
  assert.equal(out.list[0], "ok");
  assert.equal(out.list[1], MASK);
});

test("looksSensitive detects leftover secrets", () => {
  assert.ok(looksSensitive("email a@b.com"));
  assert.ok(!looksSensitive("room 12 rate 99"));
});
