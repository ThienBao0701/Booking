import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createApiServer } from "../src/server.ts";
import { Store } from "../src/db/store.ts";
import { EventBus } from "../src/eventbus.ts";
import { Logger } from "../src/logger.ts";
import { RateLimiter } from "../src/security.ts";
import type { ServiceConfig } from "../src/config.ts";
import type { LabEvent } from "../src/shared.ts";

const TOKEN = "test-token-abcdefghijklmnop";

interface Harness {
  base: string;
  store: Store;
  bus: EventBus;
  close: () => Promise<void>;
}

async function startHarness(rateMax = 100): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "lab-srv-"));
  const store = new Store(":memory:");
  const bus = new EventBus();
  const logger = new Logger({ dir: join(dir, "logs"), level: "error", stdout: false });
  const limiter = new RateLimiter(1000, rateMax);
  const config: ServiceConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    authToken: TOKEN,
    safetyMode: "OBSERVE",
    allowedOrigins: [],
    rateLimit: { windowMs: 1000, max: rateMax },
    logLevel: "error",
  };
  const server = createApiServer({ config, store, bus, logger, limiter });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  config.port = port; // host-check reads config.port at request time
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    bus,
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          store.close();
          rmSync(dir, { recursive: true, force: true });
          r();
        }),
      ),
  };
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...extra };
}

function ev(seq: number, data: Record<string, unknown> = {}): LabEvent {
  return {
    id: "01J000000000000000000000" + String(seq).padStart(2, "0").slice(-2),
    sessionId: "will-be-set",
    seq,
    ts: 1_750_000_000_000 + seq,
    kind: "CLICK",
    category: "interaction",
    severity: "info",
    redacted: true,
    data,
  };
}

test("healthz is reachable without auth", async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.base}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; safetyMode: string };
    assert.equal(body.status, "ok");
    assert.equal(body.safetyMode, "OBSERVE");
  } finally {
    await h.close();
  }
});

test("protected route rejects missing/invalid token", async () => {
  const h = await startHarness();
  try {
    const noAuth = await fetch(`${h.base}/v1/sessions`);
    assert.equal(noAuth.status, 401);
    const badAuth = await fetch(`${h.base}/v1/sessions`, { headers: { authorization: "Bearer nope" } });
    assert.equal(badAuth.status, 401);
  } finally {
    await h.close();
  }
});

test("web Origin is rejected (CSRF/rebinding defense)", async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.base}/v1/sessions`, {
      headers: auth({ origin: "https://evil.example.com" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await h.close();
  }
});

test("session + event ingestion end-to-end, with bus fan-out", async () => {
  const h = await startHarness();
  const received: string[] = [];
  h.bus.subscribe((m) => {
    if (m.type === "event") received.push(m.payload.id);
  });
  try {
    const created = await fetch(`${h.base}/v1/sessions`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ mode: "OBSERVE", target: { kind: "observe" } }),
    });
    assert.equal(created.status, 201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    assert.ok(sessionId.startsWith("session_"));

    const events = [ev(0), ev(1, { note: "email me at x@y.com" })].map((e) => ({ ...e, sessionId }));
    const ingest = await fetch(`${h.base}/v1/events`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ events }),
    });
    assert.equal(ingest.status, 202);
    const summary = (await ingest.json()) as { stored: number; quarantined: number; invalid: number };
    assert.equal(summary.invalid, 0);
    assert.equal(summary.stored + summary.quarantined, 2);

    // Read back; the email must not be present at rest.
    const read = await fetch(`${h.base}/v1/sessions/${sessionId}/events`, { headers: auth() });
    const { events: rows } = (await read.json()) as { events: Array<{ data: string }> };
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes("x@y.com"));

    assert.equal(received.length, 2, "bus should have fanned out 2 events");
  } finally {
    await h.close();
  }
});

test("invalid (un-redacted) events are reported, not stored", async () => {
  const h = await startHarness();
  try {
    const created = await fetch(`${h.base}/v1/sessions`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({}),
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const bad = { ...ev(0), sessionId, redacted: false };
    const ingest = await fetch(`${h.base}/v1/events`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ events: [bad] }),
    });
    const summary = (await ingest.json()) as { stored: number; invalid: number };
    assert.equal(summary.stored, 0);
    assert.equal(summary.invalid, 1);
  } finally {
    await h.close();
  }
});

test("rate limiting returns 429 past the window max", async () => {
  const h = await startHarness(2);
  try {
    const hdr = auth();
    const r1 = await fetch(`${h.base}/v1/sessions`, { headers: hdr });
    const r2 = await fetch(`${h.base}/v1/sessions`, { headers: hdr });
    const r3 = await fetch(`${h.base}/v1/sessions`, { headers: hdr });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
  } finally {
    await h.close();
  }
});
