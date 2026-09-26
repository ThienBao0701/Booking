/**
 * Real-browser E2E (opt-in: `pnpm run test:browser`). Loads the BUILT MV3
 * extension into Chromium, drives the real mock Extranet UI with real clicks
 * and typing, and verifies what reaches the real lab service:
 *   service worker + content script + IndexedDB queue + bridge + service,
 *   privacy (typed values and secrets never leave the page), the REC badge,
 *   and that the browser-recorded session replays on the mock.
 * Skips cleanly when playwright-core / Chromium are not available.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ReplayEngine } from "../../windows-service/src/automation/engine.ts";
import { MockExtranetController } from "../../windows-service/src/automation/mock-controller.ts";
import type { WorkflowFile } from "../../shared/src/index.ts";
import { authedGet, ensureMock, startLabService, type LabServiceHandle, type MockHandle } from "../e2e/harness.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(root, "extension", "dist");

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

let mock: MockHandle;
let svc: LabServiceHandle;
let context: import("playwright-core").BrowserContext;
let worker: import("playwright-core").Worker;
let extensionId = "";
let userDataDir = "";

function build(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "extension", "build.mjs")], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: "ignore",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`extension build failed (${code})`))));
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

before(async () => {
  if (skip || !pw) return;
  await build();
  mock = await ensureMock();
  svc = await startLabService();
  userDataDir = mkdtempSync(join(tmpdir(), "lab-chromium-"));
  context = await pw.chromium.launchPersistentContext(userDataDir, {
    executablePath: executablePath as string,
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run"],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  // Pair the extension with this service (what the Options page does).
  await worker.evaluate(
    async ({ url, token }) => {
      await chrome.storage.local.set({
        "lab.config": {
          serviceUrl: url,
          token,
          safetyMode: "OBSERVE",
          targetOrigins: [],
          batchSize: 50,
          flushIntervalMs: 500,
          maxQueue: 5000,
          domDebounceMs: 200,
        },
      });
    },
    { url: svc.url, token: svc.token },
  );
});

after(async () => {
  if (skip) return;
  await context?.close();
  await svc?.close();
  await mock?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test("the built MV3 extension records a real browser session into the service", { skip }, async () => {
  // Start recording from the real popup UI.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.click("#start");
  await popup.waitForSelector("#stop:not([hidden])");
  const sessionId = (await popup.textContent("#session"))?.trim() ?? "";
  assert.match(sessionId, /^session_/);
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "REC", "visible REC badge while recording");

  // Use the mock Extranet like a person would.
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${mock.url}/`);
  await page.fill("#login-username", "browser-operator");
  await page.click("#login-submit");
  await page.waitForSelector('#actor[data-actor="browser-operator"]');

  // A sensitive field (as a real login page would have): must never be read.
  await page.evaluate(() => {
    const pw = document.createElement("input");
    pw.type = "password";
    pw.id = "pw";
    pw.name = "password";
    document.querySelector('.view[data-view="login"]')?.appendChild(pw);
  });
  await page.fill("#pw", "hunter2-SECRET");
  await page.press("#pw", "Tab");

  await page.click('#nav button[data-view="property"]');
  await page.fill("#prop-name", "Browser Villa TYPED-VALUE");
  await page.click("#prop-submit");
  await page.click('#nav button[data-view="rooms"]');
  await page.waitForSelector("#room-property option", { state: "attached" });
  await page.fill("#room-name", "Browser Suite");
  await page.click("#room-submit");
  await page.click('#nav button[data-view="reservations"]');
  await page.waitForSelector("#res-room option", { state: "attached" });
  await page.fill("#res-guest", "Guest Name PII");
  await page.click("#res-submit");
  await page.waitForSelector("#res-table button[data-cancel]");
  await page.click("#res-table button[data-cancel]");
  await page.waitForTimeout(600); // let the debounced DOM summary fire

  // Stop from the popup; the service worker flushes and ends the session.
  await popup.bringToFront();
  await popup.click("#stop");
  await popup.waitForSelector("#start:not([hidden])");
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), "", "badge cleared after stop");

  const events = await waitFor(async () => {
    const r = await authedGet<{ events: Array<{ kind: string; workflow: string | null; data: string }> }>(svc, `/v1/sessions/${sessionId}/events`);
    return r.events?.some((e) => e.data.includes('"session_end"')) ? r.events : undefined;
  }, "session events in the service");

  const kinds = new Set(events.map((e) => e.kind));
  for (const k of ["SESSION_CHANGE", "PAGE_STATE", "CLICK", "FORM_ACTIVITY", "WORKFLOW_TRANSITION", "DOM_CHANGE"]) {
    assert.ok(kinds.has(k), `expected ${k} events, got ${[...kinds].join(",")}`);
  }
  const timeline = events.filter((e) => e.kind === "WORKFLOW_TRANSITION").map((e) => e.workflow);
  for (const label of ["LOGIN", "PROPERTY_SETUP", "ROOM_SETUP", "RESERVATION", "CANCELLATION"]) {
    assert.ok(timeline.includes(label), `timeline ${timeline.join(" → ")} lacks ${label}`);
  }

  const all = JSON.stringify(events);
  for (const typed of ["hunter2-SECRET", "Browser Villa TYPED-VALUE", "Browser Suite", "Guest Name PII", "browser-operator"]) {
    assert.ok(!all.includes(typed), `typed value leaked to the service: ${typed}`);
  }
  const pwEvent = events.find((e) => e.data.includes('"#pw"'));
  assert.ok(pwEvent, "the password field interaction is recorded structurally");
  assert.match(pwEvent.data, /"sensitive":true/);

  const session = await authedGet<{ session: { endedAt?: number } }>(svc, `/v1/sessions/${sessionId}`);
  assert.ok(session.session.endedAt, "session ended on the service");
  assert.deepEqual(pageErrors, []);

  // REPRODUCE: the browser-recorded session replays on the mock.
  const draft = await authedGet<{ file: WorkflowFile; params: string[] }>(
    svc,
    `/v1/sessions/${sessionId}/workflow?baseUrl=${encodeURIComponent(mock.url)}`,
  );
  assert.ok(draft.params.includes("secret_pw"), "the sensitive field becomes a replay-time secret param");
  const params = Object.fromEntries(draft.params.map((p) => [p, p.startsWith("secret_") ? "replay-test-secret" : `replayed-${p}`]));
  const replay = (file: WorkflowFile) =>
    new ReplayEngine(file, {
      mode: "SIMULATE",
      mockOnly: true,
      controller: new MockExtranetController({ pollMs: 20 }),
      params,
      sourceSessionId: sessionId,
    }).start();

  // Faithful: #pw was injected into this browser page only; the mock UI has no such element.
  const asRecorded = await replay(draft.file);
  assert.equal(asRecorded.status, "failed");
  assert.match(asRecorded.steps.find((s) => s.status === "failed")?.error ?? "", /no element matches #pw/);

  // Operator reviews the draft and drops the step for an element the target does not have.
  const edited: WorkflowFile = { ...draft.file, steps: draft.file.steps.filter((s) => s.target !== "#pw") };
  const run = await replay(edited);
  assert.equal(run.status, "completed", JSON.stringify(run.steps.find((s) => s.status === "failed")));
});

test("a tampered off-box service URL is refused by the live extension (falls back to loopback)", { skip }, async () => {
  const original = await worker.evaluate(() => chrome.storage.local.get("lab.config"));
  await worker.evaluate(async () => {
    const c = (await chrome.storage.local.get("lab.config"))["lab.config"] as Record<string, unknown>;
    await chrome.storage.local.set({ "lab.config": { ...c, serviceUrl: "https://collector.example.com" } });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  const status = await waitFor(async () => {
    const s = (await page.evaluate(() => chrome.runtime.sendMessage({ type: "lab/ui/status" }))) as { config: { serviceUrl: string } };
    return s.config.serviceUrl !== svc.url ? s : undefined;
  }, "config reload");
  assert.equal(status.config.serviceUrl, "http://127.0.0.1:4577", "invalid URL rejected; loopback default used");
  await worker.evaluate((cfg) => chrome.storage.local.set(cfg), original);
});
