/**
 * Phase 12 in Chromium (opt-in: `pnpm run test:browser`): with screenshot
 * storage enabled, a real PNG bound to its recorded SCREENSHOT event is shown
 * on the dashboard Screenshots page (fetched with the token, rendered from a
 * blob URL under the CSP) and can be deleted there. Skips without Chromium.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startLabService, type LabServiceHandle } from "../e2e/harness.ts";
import { SessionBuilder, persist } from "../../windows-service/test/analysis-fixtures.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

type PW = typeof import("playwright-core");
let pw: PW | undefined;
let executablePath: string | undefined;
try {
  pw = await import("playwright-core");
  const p = process.env.LAB_CHROMIUM_PATH ?? pw.chromium.executablePath();
  executablePath = existsSync(p) ? p : undefined;
} catch {
  pw = undefined;
}
const skip = !pw || !executablePath ? "playwright-core or Chromium not available" : false;

let svc: LabServiceHandle;
let browser: import("playwright-core").Browser;

function build(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "dashboard", "build.mjs")], { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`dashboard build failed (${code})`))));
  });
}

before(async () => {
  if (skip || !pw) return;
  await build();
  svc = await startLabService();
  browser = await pw.chromium.launch({ executablePath: executablePath as string, headless: true });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  await svc?.close();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(`${svc.url}${path}`, { method, headers: { authorization: `Bearer ${svc.token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

test("stored screenshots are displayed as real images and can be deleted", { skip }, async () => {
  // A real PNG, captured from a page, bound to a recorded SCREENSHOT event.
  const shooter = await browser.newPage({ viewport: { width: 320, height: 200 } });
  await shooter.setContent("<body style='background:#2a78d6'><h1 style='color:white'>lab</h1></body>");
  const png = new Uint8Array(await shooter.screenshot({ type: "png" }));
  await shooter.close();
  const sha256 = createHash("sha256").update(png).digest("hex");
  const b = new SessionBuilder("shots-session", { t0: Date.now() - 60_000 });
  b.start();
  const eventId = b.add("screenshot", { workflow: "REPORTING", metadata: { sha256, bytes: png.length, format: "png", trigger: "user" } });
  b.end();
  persist(svc.store, b);

  assert.equal((await api("PUT", "/v1/screenshots/settings", { enabled: true, retentionDays: 30, maxImageBytes: 5 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 })).status, 200);
  const up = await api("POST", "/v1/screenshots", { sessionId: b.id, eventId, sha256, dataBase64: Buffer.from(png).toString("base64") });
  assert.equal(up.status, 201);
  const shotId = ((await up.json()) as { screenshot: { id: string } }).screenshot.id;

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(`${svc.url}/dashboard/#token=${svc.token}`);
  await page.waitForSelector(".tiles .tile");
  await page.evaluate((s) => {
    location.hash = `#/screenshots?session=${s}`;
  }, b.id);
  await page.waitForSelector(`figure[data-shot="${shotId}"] img.shot-img`);
  await page.waitForFunction((id) => {
    const img = document.querySelector(`figure[data-shot="${id}"] img`) as HTMLImageElement | null;
    return !!img && img.complete && img.naturalWidth > 0;
  }, shotId);
  const dims = await page.$eval(`figure[data-shot="${shotId}"] img`, (img) => [(img as HTMLImageElement).naturalWidth, (img as HTMLImageElement).naturalHeight, (img as HTMLImageElement).src.slice(0, 5)]);
  assert.deepEqual(dims, [320, 200, "blob:"]);
  const text = (await page.textContent("main")) ?? "";
  assert.match(text, /Image storage is ON/);
  assert.match(text, new RegExp(sha256.slice(0, 12)));

  page.once("dialog", (d) => void d.accept());
  await page.click(`[data-delete="${shotId}"]`);
  await page.waitForSelector(`figure[data-shot="${shotId}"]`, { state: "detached" });
  assert.equal((await api("GET", `/v1/screenshots/${shotId}`)).status, 404);
  assert.deepEqual(problems, []);
  await page.close();
});
