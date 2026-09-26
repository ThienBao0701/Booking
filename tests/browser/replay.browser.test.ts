/**
 * Phase 13 in Chromium (opt-in: `pnpm run test:browser`): the dashboard Replay
 * page plans the bundled example as a dry run, shows target / authorization /
 * workflow / step count / risk notice, keeps Start disabled until the operator
 * acknowledges, then runs it against the real mock with live progress and
 * logs. A plan above the service's safety mode can never be started.
 * Skips without Chromium.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureMock, startLabService, type LabServiceHandle, type MockHandle } from "../e2e/harness.ts";

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
let mock: MockHandle;
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
  mock = await ensureMock();
  svc = await startLabService({ safetyMode: "SIMULATE" });
  browser = await pw.chromium.launch({ executablePath: executablePath as string, headless: true });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  await svc?.close();
  await mock?.close();
});

async function mockTotal(): Promise<number> {
  return ((await (await fetch(`${mock.url}/api/events?since=1000000000`)).json()) as { total: number }).total;
}

test("Replay page: review before start, explicit acknowledgement, live run to completion", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(`${svc.url}/dashboard/#token=${svc.token}`);
  await page.waitForSelector(".tiles .tile");
  await page.click('nav a[data-page="replay"]');
  await page.waitForSelector("#replay-workflow");
  assert.equal(await page.inputValue("#replay-workflow"), "examples:mock-full-flow");
  // The origin allowlist belongs to the real-browser controller only.
  assert.equal(await page.isVisible("#replay-allow"), false);
  await page.selectOption("#replay-controller", "browser");
  assert.equal(await page.isVisible("#replay-allow"), true);
  await page.selectOption("#replay-controller", "mock");
  assert.equal(await page.isVisible("#replay-allow"), false);

  // A plan above the service ceiling shows its blockers and cannot be acknowledged.
  const sideEffectsBefore = await mockTotal();
  await page.selectOption("#replay-mode", "AUTHORIZED_AUTOMATION");
  await page.click("text=Load example parameters");
  await page.waitForSelector("#param-username");
  await page.click("text=Plan (dry run)");
  await page.waitForSelector("#replay-blockers");
  assert.match((await page.textContent("#replay-blockers")) ?? "", /SIMULATE mode/);
  assert.equal(await page.isDisabled("#replay-ack"), true);
  assert.equal(await page.isDisabled("#replay-start"), true);

  // The real plan: SIMULATE on the mock.
  const username = `ui-${Date.now()}`;
  await page.selectOption("#replay-mode", "SIMULATE");
  await page.fill("#param-username", username);
  await page.click("text=Plan (dry run)");
  await page.waitForFunction(() => !document.getElementById("replay-blockers") && !!document.getElementById("replay-ack"));
  const review = (await page.textContent(".replay-review")) ?? "";
  for (const needle of ["Target", "http://127.0.0.1:4599", "Authorization", "Workflow", "mock-full-flow", "Step count", "Risk notice", "local mock Extranet only"]) {
    assert.ok(review.includes(needle), `review shows ${needle}`);
  }
  const stepCount = Number(await page.textContent("#replay-step-count"));
  assert.ok(stepCount > 10);
  assert.equal(await page.isDisabled("#replay-start"), true, "Start is disabled until acknowledged");
  assert.equal(await mockTotal(), sideEffectsBefore, "planning never touches the mock");

  await page.check("#replay-ack");
  assert.equal(await page.isDisabled("#replay-start"), false);
  await page.click("#replay-start");
  await page.waitForURL(/#\/replay\/[^/?]+$/);
  await page.waitForSelector("#replay-result .card", { timeout: 60_000 });
  await page.waitForFunction(() => /completed/.test(document.querySelector("#replay-result")?.textContent ?? ""), null, { timeout: 60_000 });
  const [value, max] = await page.$eval("#replay-progress", (p) => [(p as HTMLProgressElement).value, (p as HTMLProgressElement).max]);
  assert.equal(value, stepCount);
  assert.equal(max, stepCount);
  const log = (await page.textContent("#replay-log")) ?? "";
  assert.match(log, /run\.started/);
  assert.match(log, /run\.completed/);
  assert.ok(!log.includes(username), "parameter values are not logged");
  assert.ok((await mockTotal()) > sideEffectsBefore, "the run acted on the mock");
  assert.equal(await page.isDisabled('[data-action="stop"]'), true, "finished runs cannot be stopped");
  assert.deepEqual(problems, []);
  await page.close();
});
