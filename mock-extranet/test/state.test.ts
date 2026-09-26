import { test } from "node:test";
import assert from "node:assert/strict";

import { MockExtranet, MockError } from "../src/state.ts";
import type { IdEnv } from "../src/shared.ts";

/** Deterministic id/clock for reproducible tests. */
function deterministic(): { idEnv: IdEnv; clock: () => number } {
  let n = 0;
  let t = 1_750_000_000_000;
  return {
    idEnv: { now: () => 1000, randomBytes: () => { n += 1; return new Uint8Array([n, n, n, n, n, n, n, n, n, n, n, n, n, n, n, n]); } },
    clock: () => (t += 1000),
  };
}

test("actions require login", () => {
  const m = new MockExtranet();
  assert.throws(() => m.createProperty("X", "Y"), MockError);
});

test("login stores username only and emits LOGIN", () => {
  const m = new MockExtranet();
  const ev = m.login("operator");
  assert.equal(m.actor, "operator");
  assert.equal(ev.workflow, "LOGIN");
  // No password concept exists on the API at all.
  assert.ok(!("password" in ev.detail));
});

test("full workflow sequence emits the documented labels in order", () => {
  const d = deterministic();
  const m = new MockExtranet({ idEnv: d.idEnv, clock: d.clock });
  m.login("operator");
  const p = m.createProperty("Seaside Villa", "1 Ocean Rd");
  m.activateProperty(p.id);
  const room = m.createRoom(p.id, "Deluxe King", "double", 2);
  m.setRate(room.id, "standard", 120);
  const res = m.createReservation(p.id, room.id, "Test Guest", "2026-10-01", "2026-10-03");
  m.cancelReservation(res.id);
  m.sendMessage(res.id, "hello");
  m.addReview(p.id, 5, "great");
  m.uploadPhoto(p.id, "room.jpg", 2048);
  m.generateReport(p.id);

  const labels = m.events.map((e) => e.workflow);
  assert.deepEqual(labels, [
    "LOGIN",
    "PROPERTY_SETUP",
    "PROPERTY_SETUP",
    "ROOM_SETUP",
    "RATE_SETUP",
    "RESERVATION",
    "CANCELLATION",
    "MESSAGING",
    "REVIEW",
    "PHOTO",
    "REPORTING",
  ]);
});

test("messaging emits length only, not message text (privacy)", () => {
  const m = new MockExtranet();
  m.login("op");
  const ev = m.events.at(-1);
  m.sendMessage(null, "secret guest note");
  const sendEv = m.events.at(-1);
  assert.notEqual(sendEv, ev);
  assert.equal(sendEv?.detail.length, "secret guest note".length);
  assert.ok(!JSON.stringify(sendEv?.detail).includes("secret guest note"));
});

test("cancellation guards double-cancel", () => {
  const m = new MockExtranet();
  m.login("op");
  const p = m.createProperty("P", "");
  const r = m.createRoom(p.id, "R", "single", 1);
  const res = m.createReservation(p.id, r.id, "G", "a", "b");
  m.cancelReservation(res.id);
  assert.throws(() => m.cancelReservation(res.id), /already cancelled/);
});

test("rate validation rejects non-positive amounts", () => {
  const m = new MockExtranet();
  m.login("op");
  const p = m.createProperty("P", "");
  const r = m.createRoom(p.id, "R", "single", 1);
  assert.throws(() => m.setRate(r.id, "x", 0), MockError);
});

test("report aggregates reservations", () => {
  const m = new MockExtranet();
  m.login("op");
  const p = m.createProperty("P", "");
  const r = m.createRoom(p.id, "R", "single", 1);
  const a = m.createReservation(p.id, r.id, "G", "a", "b");
  m.createReservation(p.id, r.id, "H", "c", "d");
  m.cancelReservation(a.id);
  const rep = m.generateReport(p.id) as { reservations: number; confirmed: number; cancelled: number };
  assert.equal(rep.reservations, 2);
  assert.equal(rep.confirmed, 1);
  assert.equal(rep.cancelled, 1);
});
