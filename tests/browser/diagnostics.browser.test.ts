/**
 * Diagnostics in Chromium (opt-in: `pnpm run test:browser`): after the rule
 * set changes, the Findings page flags stale findings and one click
 * re-analyses exactly those sessions; the finding drill-down shows the rule
 * version and analysis status and links each evidence event to the timeline;
 * the Compare page exports the comparison as a real CSV download.
 * Skips without Chromium.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startLabService, type LabServiceHandle } from "../e2e/harness.ts";
import { type Seeded, seedLab } from "./dashboard-seed.ts";
import { loadDefaultRules } from "../../windows-service/src/analysis/service.ts";

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
let seeded: Seeded;

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
  seeded = seedLab(svc.store);
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

test("stale findings are flagged and re-analysed; provenance and evidence drill-down; comparison CSV export", { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(`${svc.url}/dashboard/#token=${svc.token}`);
  await page.waitForSelector(".tiles .tile");

  // Everything seeded was analysed with the built-in rules: nothing is stale.
  await page.evaluate(() => {
    location.hash = "#/findings";
  });
  await page.waitForSelector("#rules-version");
  assert.equal(await page.$("#stale-banner"), null);
  const oldVersion = (await page.textContent("#rules-version"))?.trim();

  // A new rule set makes every analysed session stale.
  const rules = structuredClone(loadDefaultRules());
  (rules.rules[0] as { confidence: number }).confidence = 0.42;
  assert.equal((await api("PUT", "/v1/analysis/rules", rules)).status, 200);
  const stale = ((await (await api("GET", "/v1/analysis/status")).json()) as { stale: number }).stale;
  assert.ok(stale >= 2);
  await page.evaluate(() => {
    location.hash = "#/findings?t=1";
  });
  await page.waitForSelector("#stale-banner");
  assert.match((await page.textContent("#stale-banner")) ?? "", new RegExp(`${stale} session\\(s\\) have stale findings`));
  assert.notEqual((await page.textContent("#rules-version"))?.trim(), oldVersion);
  await page.click("#stale-banner button");
  await page.waitForSelector("#stale-banner", { state: "detached" });
  assert.equal(((await (await api("GET", "/v1/analysis/status")).json()) as { stale: number }).stale, 0);

  // Drill-down: provenance + evidence → timeline.
  const f = svc.store.listFindings({ sessionId: seeded.oddId }).findings[0];
  assert.ok(f);
  await page.evaluate((id) => {
    location.hash = `#/findings/${id}`;
  }, f.finding_id);
  await page.waitForSelector("#finding-analysis");
  assert.match((await page.textContent("#finding-analysis")) ?? "", /current/);
  const version = ((await (await api("GET", "/v1/analysis/status")).json()) as { current_rules_version: string }).current_rules_version;
  assert.equal((await page.textContent("#finding-rules-version"))?.trim(), version);
  const ev = f.event_ids[0] as string;
  await page.click(`[data-evidence-timeline="${ev}"]`);
  await page.waitForURL(/#\/timeline\?/);
  assert.match(page.url(), new RegExp(`focus=${ev}`));
  await page.waitForSelector(".drawer");

  // Comparison export as a real download.
  const [a, b] = seeded.sessionIds;
  await page.evaluate(([x, y]) => {
    location.hash = `#/compare?a=${x}&b=${y}`;
  }, [a, b] as [string, string]);
  await page.waitForSelector('[data-export="csv"] button');
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-export="csv"] button')]);
  assert.equal(download.suggestedFilename(), `lab-compare-${a}-vs-${b}.csv`);
  const file = readFileSync(await download.path());
  assert.deepEqual([...file.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(file.toString("utf8"), /"section","item","a","b","delta_b_minus_a","detail"/);
  assert.deepEqual(problems, []);
  await page.close();
});
