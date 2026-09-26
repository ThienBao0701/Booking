/** Phase 12: screenshot storage — privacy defaults, binding to events, limits, retention, deletion, API. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/db/store.ts";
import { ScreenshotService } from "../src/screenshots/service.ts";
import { inspectPng } from "../src/screenshots/png.ts";
import { DEFAULT_SCREENSHOT_SETTINGS, loadScreenshotSettings, validateScreenshotSettings } from "../src/screenshots/settings.ts";
import { ReplayEngine } from "../src/automation/engine.ts";
import { DASHBOARD_CSP } from "../src/routes/dashboard.ts";
import type { ScreenshotRecord, WorkflowFile } from "../src/shared.ts";
import { authHeaders, startServiceHarness } from "./helpers.ts";
import { SessionBuilder, T0, persist } from "./analysis-fixtures.ts";
import { FakeAdapter } from "./fake-browser.ts";
import { BrowserAdapterController, BrowserTargetPolicy } from "../src/automation/browser/index.ts";

const DAY = 86_400_000;

/** A structurally valid PNG header (signature + IHDR + IEND) with a payload to vary the hash. */
export function png(width: number, height: number, payload = "x", extra = 0): Uint8Array {
  const buf = Buffer.alloc(8 + 25 + payload.length + extra + 12);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt8(8, 24);
  buf.writeUInt8(6, 25);
  buf.write(payload, 33, "ascii");
  buf.write("IEND", buf.length - 8, "ascii");
  return new Uint8Array(buf);
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function seedShot(store: Store, id: string, image: Uint8Array, t0 = T0): { sessionId: string; eventId: string } {
  const b = new SessionBuilder(id, { t0 });
  b.start();
  const eventId = b.add("screenshot", { workflow: "REPORTING", metadata: { sha256: sha(image), bytes: image.length, format: "png", trigger: "user" } });
  b.end();
  persist(store, b);
  return { sessionId: id, eventId };
}

function setup(now = () => T0 + DAY): { dir: string; store: Store; svc: ScreenshotService; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lab-shots-"));
  const store = new Store(":memory:");
  return { dir, store, svc: new ScreenshotService({ store, dataDir: dir, now }), done: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}

function enable(svc: ScreenshotService, overrides: Partial<typeof DEFAULT_SCREENSHOT_SETTINGS> = {}): void {
  svc.updateSettings({ ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true, ...overrides });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return "no error";
}

test("PNG inspection: signature, IHDR and plausible dimensions", () => {
  assert.deepEqual(inspectPng(png(1280, 720)), { ok: true, width: 1280, height: 720 });
  assert.equal(inspectPng(new TextEncoder().encode("<svg onload=alert(1)></svg>".padEnd(40))).ok, false);
  const noIhdr = png(10, 10);
  noIhdr.set([0x41, 0x42, 0x43, 0x44], 12);
  assert.equal(inspectPng(noIhdr).ok, false);
  assert.equal(inspectPng(png(0, 10)).ok, false);
  assert.equal(inspectPng(png(30_000, 10)).ok, false);
  assert.equal(inspectPng(new Uint8Array(10)).ok, false);
});

test("settings: disabled by default, validated, persisted 0600; an invalid file keeps storage disabled", () => {
  assert.equal(DEFAULT_SCREENSHOT_SETTINGS.enabled, false);
  assert.equal(validateScreenshotSettings({ ...DEFAULT_SCREENSHOT_SETTINGS, retentionDays: 0 }).ok, false);
  assert.equal(validateScreenshotSettings({ ...DEFAULT_SCREENSHOT_SETTINGS, maxImageBytes: 999_999_999 }).ok, false);
  assert.equal(validateScreenshotSettings({ ...DEFAULT_SCREENSHOT_SETTINGS, enabled: "yes" }).ok, false);
  assert.equal(validateScreenshotSettings({ ...DEFAULT_SCREENSHOT_SETTINGS, extra: 1 }).ok, false);
  assert.equal(validateScreenshotSettings({ ...DEFAULT_SCREENSHOT_SETTINGS, maxImageBytes: 2 * 1024 * 1024, maxTotalBytes: 1024 * 1024 }).ok, false);
  const { dir, svc, done } = setup();
  try {
    assert.equal(svc.settings.enabled, false);
    enable(svc, { retentionDays: 7 });
    const file = join(dir, "screenshot-settings.json");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadScreenshotSettings(dir).settings.retentionDays, 7);
    writeFileSync(file, JSON.stringify({ enabled: true, retentionDays: 9999 }));
    const reloaded = loadScreenshotSettings(dir);
    assert.equal(reloaded.settings.enabled, false, "fail closed");
    assert.match(String(reloaded.error), /storage stays disabled/);
    writeFileSync(file, "{not json");
    assert.equal(loadScreenshotSettings(dir).settings.enabled, false);
  } finally {
    done();
  }
});

test("while disabled nothing is stored or written", () => {
  const { dir, store, svc, done } = setup();
  try {
    const img = png(100, 50);
    const { sessionId, eventId } = seedShot(store, "s1", img);
    assert.equal(code(() => svc.storeExtension({ sessionId, eventId, sha256: sha(img), data: img })), "screenshots_disabled");
    assert.equal(svc.storeReplay({ runId: "r", stepId: "s", data: img }), undefined);
    assert.equal(existsSync(join(dir, "screenshots")), false);
    assert.equal(store.screenshotUsage().count, 0);
  } finally {
    done();
  }
});

test("an image is stored only for its own recorded SCREENSHOT event, with matching hash", () => {
  const { dir, store, svc, done } = setup();
  try {
    enable(svc);
    const img = png(100, 50);
    const { sessionId, eventId } = seedShot(store, "s1", img);
    const other = png(100, 50, "other-longer-payload");
    assert.equal(code(() => svc.storeExtension({ sessionId, eventId, sha256: sha(other), data: img })), "sha256_mismatch");
    assert.equal(code(() => svc.storeExtension({ sessionId, eventId, sha256: sha(other), data: other })), "event_size_mismatch");
    assert.equal(code(() => svc.storeExtension({ sessionId: "nope", eventId, sha256: sha(img), data: img })), "event_not_found");
    assert.equal(code(() => svc.storeExtension({ sessionId, eventId: "s1-e0000", sha256: sha(img), data: img })), "not_a_screenshot_event");
    assert.equal(code(() => svc.storeExtension({ sessionId, eventId, sha256: sha(img), data: new TextEncoder().encode("GIF89a".padEnd(40)) })), "invalid_image");
    // The event's own hash field is masked at rest (privacy redaction); the service stores the digest.
    assert.equal(JSON.parse(store.getStoredEvent(eventId)!.data).metadata.sha256, "[REDACTED]");
    const rec = svc.storeExtension({ sessionId, eventId, sha256: sha(img), data: img });
    assert.deepEqual([rec.session_id, rec.event_id, rec.source, rec.width, rec.height, rec.mime, rec.workflow], [sessionId, eventId, "extension", 100, 50, "image/png", "REPORTING"]);
    const file = join(dir, "screenshots", `${sha(img)}.png`);
    assert.deepEqual(new Uint8Array(readFileSync(file)), img);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(svc.storeExtension({ sessionId, eventId, sha256: sha(img), data: img }).id, rec.id, "idempotent retry");
    assert.deepEqual(new Uint8Array(svc.image(rec.id)!.data), img);
  } finally {
    done();
  }
});

test("size limit, non-PNG and storage budget are enforced", () => {
  const { store, svc, done } = setup();
  try {
    enable(svc, { maxImageBytes: 64 * 1024, maxTotalBytes: 1024 * 1024 });
    const big = png(10, 10, "b", 70 * 1024);
    const s1 = seedShot(store, "big", big);
    assert.equal(code(() => svc.storeExtension({ ...s1, sha256: sha(big), data: big })), "image_too_large");
    const notPng = new Uint8Array(100).fill(7);
    const s2 = seedShot(store, "bad", notPng);
    assert.equal(code(() => svc.storeExtension({ ...s2, sha256: sha(notPng), data: notPng })), "invalid_image");
    // Budget: 1 MiB total, images of ~60 KiB → the 18th distinct image does not fit.
    let refused = "";
    for (let i = 0; i < 20 && !refused; i++) {
      const img = png(10, 10, `n${i}`, 60 * 1024);
      const s = seedShot(store, `q${i}`, img);
      refused = code(() => svc.storeExtension({ ...s, sha256: sha(img), data: img }));
      if (refused === "no error") refused = "";
    }
    assert.equal(refused, "storage_quota_exceeded");
    assert.ok(store.screenshotUsage().bytes <= 1024 * 1024);
  } finally {
    done();
  }
});

test("identical images share one file; deleting releases the file only when unreferenced", () => {
  const { dir, store, svc, done } = setup();
  try {
    enable(svc);
    const img = png(20, 20);
    const a = svc.storeExtension({ ...seedShot(store, "a", img), sha256: sha(img), data: img });
    const b = svc.storeExtension({ ...seedShot(store, "b", img), sha256: sha(img), data: img });
    assert.deepEqual([store.screenshotUsage().count, store.screenshotUsage().files], [2, 1]);
    const file = join(dir, "screenshots", `${sha(img)}.png`);
    assert.equal(svc.delete(a.id), true);
    assert.ok(existsSync(file), "still referenced by b");
    assert.equal(svc.delete(a.id), false);
    assert.equal(svc.deleteSession("b"), 1);
    assert.equal(existsSync(file), false);
    assert.equal(b.session_id, "b");
  } finally {
    done();
  }
});

test("retention deletes expired images; purged sessions leave no orphaned files", () => {
  let now = T0 + DAY;
  const { dir, store, svc, done } = setup(() => now);
  try {
    enable(svc, { retentionDays: 2 });
    const old = png(10, 10, "old");
    const fresh = png(10, 10, "fresh");
    svc.storeExtension({ ...seedShot(store, "old", old, T0), sha256: sha(old), data: old });
    svc.storeExtension({ ...seedShot(store, "fresh", fresh, T0 + 2 * DAY), sha256: sha(fresh), data: fresh });
    now = T0 + 3 * DAY;
    assert.deepEqual(svc.applyRetention(), { deleted: 1, orphans: 0 });
    assert.deepEqual(readdirSync(join(dir, "screenshots")), [`${sha(fresh)}.png`]);
    store.purgeSession("fresh"); // rows cascade; the file is collected
    writeFileSync(join(dir, "screenshots", "stale.1234.tmp"), "x");
    assert.equal(svc.collectGarbage(), 2);
    assert.deepEqual(readdirSync(join(dir, "screenshots")), []);
  } finally {
    done();
  }
});

test("replay screenshots are stored through the engine hook when enabled; a failing sink never fails the step", async () => {
  const { store, svc, done } = setup();
  try {
    const MOCK = "http://127.0.0.1:4599";
    const wf: WorkflowFile = { workflow: "shots", version: 1, target: { kind: "mock", baseUrl: MOCK }, steps: [{ id: "open", action: "navigate", target: "/" }, { id: "shot", action: "captureScreenshot" }] };
    const policy = BrowserTargetPolicy.create({ mode: "SIMULATE", target: { kind: "mock", baseUrl: MOCK }, allowlist: [MOCK] });
    assert.ok(policy.ok);
    const controller = () => new BrowserAdapterController({ adapter: new FakeAdapter({ pages: { [`${MOCK}/`]: { title: "x" } } }), policy: policy.policy, settleMs: 0, egressProxy: false });
    // The fake adapter's screenshot is a PNG signature only: store it via a real PNG to exercise the path.
    const stored: ScreenshotRecord[] = [];
    enable(svc);
    const run = await new ReplayEngine(wf, {
      mode: "SIMULATE",
      controller: controller(),
      onScreenshot: (s) => {
        const r = svc.storeReplay({ runId: s.runId, stepId: s.stepId, data: png(64, 48, s.stepId) });
        if (r) stored.push(r);
      },
    }).start();
    assert.equal(run.status, "completed");
    assert.deepEqual(stored.map((r) => [r.source, r.run_id, r.step_id, r.event_id]), [["replay", run.runId, "shot", null]]);
    assert.equal(store.listScreenshots({ runId: run.runId }).total, 1);
    const events: string[] = [];
    const failing = await new ReplayEngine(wf, { mode: "SIMULATE", controller: controller(), onEvent: (e) => events.push(e.type), onScreenshot: () => { throw new Error("disk full"); } }).start();
    assert.equal(failing.status, "completed");
    assert.ok(events.includes("step.warning"));
  } finally {
    done();
  }
});

// -------------------------------------------------------------------- API

test("API: settings, upload, list, image, delete — with auth, validation and privacy defaults", async () => {
  const h = await startServiceHarness();
  try {
    const get = (p: string, extra: Record<string, string> = {}) => fetch(`${h.base}${p}`, { headers: authHeaders(extra) });
    const send = (method: string, p: string, body: unknown) => fetch(`${h.base}${p}`, { method, headers: authHeaders(), body: JSON.stringify(body) });
    const img = png(320, 200);
    const { sessionId, eventId } = seedShot(h.store, "api", img);
    const upload = { sessionId, eventId, sha256: sha(img), dataBase64: Buffer.from(img).toString("base64") };

    const s0 = (await (await get("/v1/screenshots/settings")).json()) as { settings: { enabled: boolean } };
    assert.equal(s0.settings.enabled, false);
    assert.equal(((await (await get("/v1/bridge/handshake")).json()) as { screenshots: { enabled: boolean } }).screenshots.enabled, false);
    assert.equal((await send("POST", "/v1/screenshots", upload)).status, 409, "refused while disabled");

    assert.equal((await send("PUT", "/v1/screenshots/settings", { enabled: true })).status, 400);
    assert.equal((await send("PUT", "/v1/screenshots/settings", { ...DEFAULT_SCREENSHOT_SETTINGS, enabled: true })).status, 200);
    assert.equal(((await (await get("/v1/bridge/handshake")).json()) as { screenshots: { enabled: boolean } }).screenshots.enabled, true);

    assert.equal((await send("POST", "/v1/screenshots", { ...upload, dataBase64: "@@not base64@@" })).status, 400);
    assert.equal((await send("POST", "/v1/screenshots", { ...upload, eventId: "api-e9999" })).status, 404);
    const created = await send("POST", "/v1/screenshots", upload);
    assert.equal(created.status, 201);
    const rec = ((await created.json()) as { screenshot: ScreenshotRecord }).screenshot;

    const list = (await (await get(`/v1/screenshots?session=${sessionId}`)).json()) as { total: number; screenshots: ScreenshotRecord[] };
    assert.equal(list.total, 1);
    const image = await get(`/v1/screenshots/${rec.id}/image`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(String(image.headers.get("content-security-policy")), /sandbox/);
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), img);

    assert.equal((await fetch(`${h.base}/v1/screenshots/${rec.id}/image`)).status, 401, "images need the token");
    assert.equal((await get(`/v1/screenshots/${rec.id}/image`, { origin: "http://127.0.0.1:4599" })).status, 403);

    assert.equal((await send("DELETE", `/v1/screenshots/${rec.id}`, {})).status, 200);
    assert.equal((await get(`/v1/screenshots/${rec.id}/image`)).status, 404);
    assert.equal((await send("DELETE", `/v1/screenshots/${rec.id}`, {})).status, 404);
    assert.equal((await send("POST", "/v1/screenshots", upload)).status, 201);
    const del = (await (await send("DELETE", `/v1/sessions/${sessionId}/screenshots`, {})).json()) as { deleted: number };
    assert.equal(del.deleted, 1);
    assert.equal(((await (await send("POST", "/v1/screenshots/retention", {})).json()) as { deleted: number }).deleted, 0);
  } finally {
    await h.close();
  }
});

test("dashboard CSP allows blob: images only (never blob: scripts)", () => {
  const directives = Object.fromEntries(DASHBOARD_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.ok(directives["img-src"].includes("blob:"));
  assert.deepEqual(directives["script-src"], ["'self'"]);
  assert.deepEqual(directives["default-src"], ["'none'"]);
  assert.ok(!directives["connect-src"].includes("blob:"));
});
