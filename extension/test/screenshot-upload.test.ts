/** Phase 12: the bridge reads the service's screenshot setting and uploads images only through the authenticated API. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BridgeClient, type TransportRequest } from "../src/bridge/client.ts";
import { FakeTimers } from "./fakes.ts";

const TOKEN = "bridge-test-token-0123456789";
const URL_ = "http://127.0.0.1:4577";

function client(reply: (req: TransportRequest) => { status: number; body: unknown }) {
  const requests: TransportRequest[] = [];
  const bridge = new BridgeClient({
    serviceUrl: URL_,
    token: TOKEN,
    timers: new FakeTimers(),
    transport: async (req) => {
      requests.push(req);
      const r = reply(req);
      return { status: r.status, json: async () => r.body };
    },
  });
  return { bridge, requests };
}

const HANDSHAKE = { service: "lab-service", contractVersion: 1, labVersion: "0.1.0", safetyMode: "OBSERVE", maxBatchEvents: 500 };

test("handshake exposes the screenshot storage switch (absent → disabled)", async () => {
  const off = client(() => ({ status: 200, body: HANDSHAKE }));
  assert.deepEqual((await off.bridge.handshake()).screenshots, { enabled: false, maxImageBytes: 0 });
  const on = client(() => ({ status: 200, body: { ...HANDSHAKE, screenshots: { enabled: true, maxImageBytes: 5_000_000 } } }));
  assert.deepEqual((await on.bridge.handshake()).screenshots, { enabled: true, maxImageBytes: 5_000_000 });
});

test("uploadScreenshot posts to the loopback API with the token and reports why an image was not stored", async () => {
  let status = 201;
  let body: unknown = { screenshot: { id: "shot_1" } };
  const { bridge, requests } = client(() => ({ status, body }));
  const upload = { sessionId: "s1", eventId: "e1", sha256: "a".repeat(64), dataBase64: "iVBORw0KGgo=" };
  assert.deepEqual(await bridge.uploadScreenshot(upload), { stored: true });
  const req = requests[0] as TransportRequest;
  assert.equal(req.method, "POST");
  assert.equal(req.url, `${URL_}/v1/screenshots`);
  assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(req.body as string), upload);
  status = 409;
  body = { error: "screenshots_disabled" };
  assert.deepEqual(await bridge.uploadScreenshot(upload), { stored: false, reason: "screenshots_disabled" });
  const unpaired = new BridgeClient({ serviceUrl: URL_, token: "", timers: new FakeTimers(), transport: async () => ({ status: 500, json: async () => ({}) }) });
  assert.deepEqual(await unpaired.uploadScreenshot(upload), { stored: false, reason: "unpaired" });
});
