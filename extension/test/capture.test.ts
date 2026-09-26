import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type ElementLike,
  buildSelector,
  describeElement,
  describeField,
  elementLabel,
  findInteractive,
  isSensitiveElement,
} from "../src/content/capture.ts";

function el(tag: string, attrs: Record<string, string> = {}, text?: string, parent?: ElementLike): ElementLike {
  return {
    tagName: tag.toUpperCase(),
    id: attrs.id ?? "",
    getAttribute: (n) => (n in attrs ? (attrs[n] as string) : null),
    parentElement: parent ?? null,
    textContent: text ?? null,
  };
}

test("findInteractive climbs to the closest actionable element", () => {
  const button = el("button", { id: "res-submit" }, "Create reservation");
  const span = el("span", {}, "Create", button);
  assert.equal(findInteractive(span), button);
  const div = el("div", { "data-action": "login" });
  assert.equal(findInteractive(el("i", {}, "", div)), div);
  assert.equal(findInteractive(el("div")), null);
});

test("selectors prefer stable ids and data attributes", () => {
  assert.equal(buildSelector(el("button", { id: "login-submit" })), "#login-submit");
  assert.equal(buildSelector(el("button", { "data-view": "rooms" })), 'button[data-view="rooms"]');
  assert.equal(buildSelector(el("input", { name: "guestName" })), 'input[name="guestName"]');
});

test("selectors never embed entity ids or generated ids", () => {
  assert.equal(buildSelector(el("button", { "data-cancel": "01M3DZYSTT8V5MZARM6JDP680Q" })), "button[data-cancel]");
  assert.equal(buildSelector(el("div", { id: "row-1234567" })), "div", "long digit runs are not stable");
  assert.equal(buildSelector(el("div", { id: "x9f8a7b6c5d4e3f2a1b0c9d8e7f6" })), "div", "opaque tokens are not stable");
});

test("labels: button captions yes, link text no (may contain guest names)", () => {
  assert.equal(elementLabel(el("button", {}, "  Create\n reservation ")), "Create reservation");
  assert.equal(elementLabel(el("a", {}, "John Smith")), undefined);
  assert.equal(elementLabel(el("a", { "aria-label": "Open reservation" }, "John Smith")), "Open reservation");
  assert.equal(elementLabel(el("input", { type: "submit", value: "Save" })), "Save");
  assert.equal(elementLabel(el("input", { type: "text", value: "secret" })), undefined, "never read text input values");
  assert.equal(elementLabel(el("button", {}, "Mail me@x.com")), "Mail [REDACTED]");
});

test("describeElement returns structure only", () => {
  const d = describeElement(el("button", { id: "rate-submit", role: "button" }, "Save rate"));
  assert.deepEqual(d, { tag: "button", selector: "#rate-submit", label: "Save rate", role: "button" });
});

test("sensitive fields are flagged and carry no 'filled' bit", () => {
  const pw = el("input", { type: "password", name: "pw" });
  assert.equal(isSensitiveElement(pw), true);
  assert.deepEqual(describeField(pw, true).metadata, { sensitive: true, inputType: "password" });
  const otp = el("input", { autocomplete: "one-time-code", name: "code" });
  assert.equal(isSensitiveElement(otp), true);
  const card = el("input", { name: "cardNumber" });
  assert.equal(describeField(card, true).metadata.sensitive, true);
});

test("non-sensitive fields record only whether they are filled", () => {
  const f = describeField(el("input", { id: "prop-name", name: "name" }), true);
  assert.deepEqual(f.metadata, { filled: true, inputType: "input" });
  assert.equal(f.target.selector, "#prop-name");
});
