/**
 * Phase 14 in Chromium (opt-in: `pnpm run test:browser`): the BUILT extension
 * delivers a real recorded session through Chrome's Native Messaging to the
 * installed native host, which relays it to the lab service. The host is
 * registered for this Chromium profile only (`<user-data-dir>/NativeMessagingHosts`).
 * After uninstall, "auto" falls back to HTTP loopback. Skips without Chromium.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyInstall, applyUninstall, planInstall, planUninstall } from "../../windows-service/src/native/install.ts";
import { extensionServiceWorker } from "./extension-worker.ts";
import { authedGet, ensureMock, startLabService, type LabServiceHandle, type MockHandle } from "../e2e/harness.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(root, "extension", "dist");
const HOST_ENTRY = join(root, "windows-service", "src", "native", "main.ts");

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
const skip = !pw || !executablePath ? "playwright-core or Chromium not available" : process.platform === "win32" ? "profile-scoped host registration is POSIX-only (Windows uses the registry)" : false;

let mock: MockHandle;
let svc: LabServiceHandle;
let context: import("playwright-core").BrowserContext;
let worker: import("playwright-core").Worker;
let extensionId = "";
let userDataDir = "";
let dir = "";

function build(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "extension", "build.mjs")], { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: "ignore" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`extension build failed (${code})`))));
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function pair(transport: "native" | "auto" | "http"): Promise<void> {
  await worker.evaluate(
    async ({ url, token, transport }) => {
      await chrome.storage.local.set({ "lab.config": { serviceUrl: url, token, safetyMode: "OBSERVE", targetOrigins: [], batchSize: 50, flushIntervalMs: 500, maxQueue: 5000, domDebounceMs: 200, transport } });
    },
    { url: svc.url, token: svc.token, transport },
  );
}

before(async () => {
  if (skip || !pw) return;
  await build();
  mock = await ensureMock();
  svc = await startLabService();
  dir = mkdtempSync(join(tmpdir(), "lab-native-browser-"));
  userDataDir = join(dir, "profile");
  context = await pw.chromium.launchPersistentContext(userDataDir, {
    executablePath: executablePath as string,
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run"],
  });
  worker = await extensionServiceWorker(context);
  extensionId = new URL(worker.url()).host;
});

after(async () => {
  if (skip) return;
  await context?.close();
  await svc?.close();
  await mock?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("the extension delivers a recorded session through the native host; uninstall falls back to HTTP", { skip }, async () => {
  const logDir = join(dir, "logs");
  const target = { platform: "linux" as const, installDir: join(dir, "native-host"), browsers: [] as const, userDataDirs: [userDataDir] };
  const plan = planInstall({ ...target, browsers: [], extensionIds: [extensionId], serviceUrl: svc.url, nodePath: process.execPath, hostEntry: HOST_ENTRY, logDir });
  applyInstall(plan);
  await pair("native");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForFunction(() => /native host/.test(document.getElementById("transport")?.textContent ?? ""), null, { timeout: 15_000 });
  await popup.click("#start");
  await popup.waitForSelector("#stop:not([hidden])");
  const sessionId = (await popup.textContent("#session"))?.trim() ?? "";
  assert.match(sessionId, /^session_/);

  const page = await context.newPage();
  await page.goto(`${mock.url}/`);
  await page.fill("#login-username", "native-operator");
  await page.click("#login-submit");
  await page.waitForSelector('#actor[data-actor="native-operator"]');
  await page.click('#nav button[data-view="property"]');
  await page.waitForTimeout(400);

  await popup.bringToFront();
  await popup.click("#stop");
  await popup.waitForSelector("#start:not([hidden])");
  const events = await waitFor(async () => {
    const r = await authedGet<{ events: Array<{ kind: string; data: string }> }>(svc, `/v1/sessions/${sessionId}/events`);
    return r.events?.some((e) => e.data.includes('"session_end"')) ? r.events : undefined;
  }, "session events delivered via the native host");
  assert.ok(events.some((e) => e.kind === "CLICK"));
  assert.ok(!JSON.stringify(events).includes("native-operator"), "typed values never leave the page");

  const log = readFileSync(join(logDir, "native-host.log"), "utf8");
  assert.match(log, new RegExp(`"origin":"chrome-extension://${extensionId}/"`), "Chrome launched the host for this extension");
  assert.match(log, /"msg":"relayed","method":"POST","path":"\/v1\/events","status":20[02]/);
  assert.ok(!log.includes(svc.token), "the host never logs the token");
  const status = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "lab/ui/status" }));
  assert.equal((status as { transport: { active: string; native: string } }).transport.active, "native");

  // Uninstall the host; "auto" keeps working over HTTP loopback.
  const un = applyUninstall(planUninstall(target));
  assert.ok(un.removed.includes(join(userDataDir, "NativeMessagingHosts", "com.automation_lab.bridge.json")));
  await pair("auto");
  await popup.reload();
  await popup.waitForFunction(() => /HTTP \(fallback\)/.test(document.getElementById("transport")?.textContent ?? ""), null, { timeout: 15_000 });
  await popup.click("#start");
  await popup.waitForSelector("#stop:not([hidden])");
  const second = (await popup.textContent("#session"))?.trim() ?? "";
  await popup.click("#stop");
  await popup.waitForSelector("#start:not([hidden])");
  await waitFor(async () => {
    const r = await authedGet<{ events: Array<{ data: string }> }>(svc, `/v1/sessions/${second}/events`);
    return r.events?.some((e) => e.data.includes('"session_end"')) ? true : undefined;
  }, "session delivered over the HTTP fallback");
  await popup.close();
  await page.close();
});
