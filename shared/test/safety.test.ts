import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SAFETY_MODES,
  DEFAULT_SAFETY_MODE,
  isSafetyMode,
  allowsReplaySideEffects,
  allowsAuthorizedTarget,
} from "../src/safety/modes.ts";
import {
  FORBIDDEN_CAPABILITIES,
  ALLOWED_CAPABILITIES,
  isCapabilityAvailable,
  assertCapabilityAllowed,
  ForbiddenCapabilityError,
} from "../src/safety/capabilities.ts";
import {
  evaluateReplay,
  assertReplayAllowed,
  ReplayNotAuthorizedError,
  type ReplayTarget,
  type AuthorizationRecord,
} from "../src/safety/policy.ts";

test("default mode is OBSERVE and modes are a closed set", () => {
  assert.equal(DEFAULT_SAFETY_MODE, "OBSERVE");
  assert.deepEqual([...SAFETY_MODES], ["OBSERVE", "SIMULATE", "AUTHORIZED_AUTOMATION"]);
  assert.ok(isSafetyMode("OBSERVE"));
  assert.ok(!isSafetyMode("YOLO"));
});

test("side effects: OBSERVE none; SIMULATE + AUTHORIZED_AUTOMATION yes", () => {
  assert.equal(allowsReplaySideEffects("OBSERVE"), false);
  assert.equal(allowsReplaySideEffects("SIMULATE"), true);
  assert.equal(allowsReplaySideEffects("AUTHORIZED_AUTOMATION"), true);
});

test("only AUTHORIZED_AUTOMATION permits an authorized target", () => {
  assert.equal(allowsAuthorizedTarget("OBSERVE"), false);
  assert.equal(allowsAuthorizedTarget("SIMULATE"), false);
  assert.equal(allowsAuthorizedTarget("AUTHORIZED_AUTOMATION"), true);
});

// ---- Forbidden capability denylist (ADR-0002) ----

test("every forbidden capability is unavailable and throws", () => {
  for (const cap of FORBIDDEN_CAPABILITIES) {
    assert.equal(isCapabilityAvailable(cap), false, `${cap} must be unavailable`);
    assert.throws(() => assertCapabilityAllowed(cap), ForbiddenCapabilityError, `${cap} must throw`);
  }
});

test("the forbidden list contains exactly the documented exclusions", () => {
  assert.deepEqual(
    [...FORBIDDEN_CAPABILITIES].sort(),
    [
      "ANTI_DETECTION",
      "BOT_DETECTION_BYPASS",
      "CAPTCHA_BYPASS",
      "FAKE_USER_BEHAVIOR",
      "FINGERPRINT_SPOOFING",
      "IP_ROTATION",
      "STEALTH_EVASION",
    ].sort(),
  );
});

test("allowed and forbidden sets are disjoint", () => {
  const allowed = new Set<string>(ALLOWED_CAPABILITIES);
  for (const f of FORBIDDEN_CAPABILITIES) {
    assert.ok(!allowed.has(f), `${f} must not also be allowed`);
  }
});

test("unknown capability is deny-by-default", () => {
  assert.equal(isCapabilityAvailable("SOMETHING_NEW"), false);
  assert.throws(() => assertCapabilityAllowed("SOMETHING_NEW"), ForbiddenCapabilityError);
});

test("allowed capabilities are available", () => {
  for (const cap of ALLOWED_CAPABILITIES) {
    assert.equal(isCapabilityAvailable(cap), true, `${cap} must be available`);
    assert.doesNotThrow(() => assertCapabilityAllowed(cap));
  }
});

// ---- Replay target guard ----

const goodAuth: AuthorizationRecord = {
  owner: "me",
  system: "staging-extranet",
  grantedBy: "self",
  acknowledgedAt: 1_750_000_000_000,
};

test("observe target never permits side effects", () => {
  const t: ReplayTarget = { kind: "observe" };
  for (const mode of SAFETY_MODES) {
    assert.equal(evaluateReplay(mode, t).allowed, false);
  }
});

test("mock target allowed in SIMULATE and AUTHORIZED_AUTOMATION, not OBSERVE", () => {
  const t: ReplayTarget = { kind: "mock", baseUrl: "http://127.0.0.1:4599" };
  assert.equal(evaluateReplay("OBSERVE", t).allowed, false);
  assert.equal(evaluateReplay("SIMULATE", t).allowed, true);
  assert.equal(evaluateReplay("AUTHORIZED_AUTOMATION", t).allowed, true);
});

test("authorized target requires AUTHORIZED_AUTOMATION + valid record", () => {
  const good: ReplayTarget = {
    kind: "authorized",
    baseUrl: "https://staging.example.test",
    authorization: goodAuth,
  };
  assert.equal(evaluateReplay("SIMULATE", good).code, "MODE_FORBIDS_AUTHORIZED_TARGET");
  assert.equal(evaluateReplay("AUTHORIZED_AUTOMATION", good).allowed, true);

  const bad: ReplayTarget = {
    kind: "authorized",
    baseUrl: "https://staging.example.test",
    authorization: { owner: "", system: "", grantedBy: "", acknowledgedAt: Number.NaN },
  };
  const d = evaluateReplay("AUTHORIZED_AUTOMATION", bad);
  assert.equal(d.allowed, false);
  assert.equal(d.code, "MISSING_AUTHORIZATION");
});

test("assertReplayAllowed throws with decision on denial", () => {
  const t: ReplayTarget = { kind: "mock", baseUrl: "http://127.0.0.1:4599" };
  assert.throws(
    () => assertReplayAllowed("OBSERVE", t),
    (err: unknown) => err instanceof ReplayNotAuthorizedError && err.decision.allowed === false,
  );
  assert.doesNotThrow(() => assertReplayAllowed("SIMULATE", t));
});
