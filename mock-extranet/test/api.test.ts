import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createMockServer } from "../src/api.ts";

async function start(): Promise<{ base: string; close: () => Promise<void> }> {
  const { server } = createMockServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const post = (base: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const get = (base: string, path: string) => fetch(base + path);

test("serves the UI at /", async () => {
  const h = await start();
  try {
    const res = await get(h.base, "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /Mock Extranet/);
    assert.match(html, /data-action="login"/);
  } finally {
    await h.close();
  }
});

test("actions before login are rejected 401", async () => {
  const h = await start();
  try {
    const res = await post(h.base, "/api/properties", { name: "X" });
    assert.equal(res.status, 401);
  } finally {
    await h.close();
  }
});

test("full workflow over HTTP produces an event feed", async () => {
  const h = await start();
  try {
    await post(h.base, "/api/login", { username: "operator" });
    const prop = (await (await post(h.base, "/api/properties", { name: "Seaside", address: "1 Rd" })).json()) as {
      property: { id: string };
    };
    const pid = prop.property.id;
    await post(h.base, `/api/properties/${pid}/activate`);
    const room = (await (await post(h.base, "/api/rooms", { propertyId: pid, name: "Deluxe", roomType: "double", capacity: 2 })).json()) as {
      room: { id: string };
    };
    await post(h.base, "/api/rates", { roomId: room.room.id, label: "std", amount: 150 });
    const res = (await (await post(h.base, "/api/reservations", { propertyId: pid, roomId: room.room.id, guestName: "G", checkIn: "2026-10-01", checkOut: "2026-10-03" })).json()) as {
      reservation: { id: string };
    };
    await post(h.base, `/api/reservations/${res.reservation.id}/cancel`);
    await post(h.base, "/api/messages", { reservationId: res.reservation.id, text: "hi" });
    await post(h.base, "/api/reviews", { propertyId: pid, rating: 5, text: "good" });
    await post(h.base, "/api/photos", { propertyId: pid, filename: "a.jpg", sizeBytes: 100 });
    const report = (await (await post(h.base, "/api/reports", { propertyId: pid })).json()) as { report: { reservations: number } };
    assert.equal(report.report.reservations, 1);

    const feed = (await (await get(h.base, "/api/events")).json()) as { events: Array<{ workflow: string }> };
    const labels = feed.events.map((e) => e.workflow);
    assert.ok(labels.includes("LOGIN"));
    assert.ok(labels.includes("RESERVATION"));
    assert.ok(labels.includes("CANCELLATION"));
    assert.ok(labels.includes("REPORTING"));

    const since = (await (await get(h.base, "/api/events?since=100")).json()) as { events: unknown[]; total: number };
    assert.ok(since.total >= 11);
  } finally {
    await h.close();
  }
});

test("validation errors surface as 4xx", async () => {
  const h = await start();
  try {
    await post(h.base, "/api/login", { username: "op" });
    const badRating = await post(h.base, "/api/reviews", { propertyId: "nope", rating: 9 });
    assert.equal(badRating.status, 404); // property not found checked first
  } finally {
    await h.close();
  }
});
