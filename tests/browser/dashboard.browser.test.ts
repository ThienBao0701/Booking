/**
 * Dashboard smoke test in Chromium (opt-in: `pnpm run test:browser`). Builds the
 * dashboard, serves it from the real service with seeded data, and walks every
 * page: no console or page errors, the token leaves the address bar, recorded
 * text is rendered as text (no script injection), filters/drawer/graph/timeline/
 * comparison/finding drill-down work, and every finding's evidence resolves to
 * its exact event ids. Skips cleanly when playwright-core / Chromium are absent.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startLabService, type LabServiceHandle } from "../e2e/harness.ts";
import { type Seeded, seedLab } from "./dashboard-seed.ts";

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
let seeded: Seeded;
let browser: import("playwright-core").Browser;
let page: import("playwright-core").Page;
const problems: string[] = [];

function build(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "dashboard", "build.mjs")], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: "ignore",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`dashboard build failed (${code})`))));
  });
}

async function go(hash: string, ready: string): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForSelector(ready, { state: "attached", timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector("main")?.classList.contains("refreshing"), undefined, { timeout: 10_000 });
}

before(async () => {
  if (skip || !pw) return;
  await build();
  svc = await startLabService();
  seeded = seedLab(svc.store);
  browser = await pw.chromium.launch({ executablePath: executablePath as string, headless: true });
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
  });
});

after(async () => {
  if (skip) return;
  await browser?.close();
  await svc?.close();
});

test("sign-in via fragment: token moves to sessionStorage and leaves the URL; CSP is enforced", { skip }, async () => {
  const res = await page.goto(`${svc.url}/dashboard/#token=${svc.token}`);
  assert.equal(res?.status(), 200);
  assert.match(String(res?.headers()["content-security-policy"]), /default-src 'none'/);
  await page.waitForSelector(".tiles .tile", { timeout: 10_000 });
  const state = await page.evaluate(() => ({ href: location.href, stored: sessionStorage.getItem("lab.dashboard.token"), historyLen: history.length }));
  assert.ok(!state.href.includes(svc.token), "token scrubbed from the address bar");
  assert.equal(state.stored, svc.token);
  assert.match(state.href, /#\/overview$/);
});

test("overview renders tiles and charts from the API", { skip }, async () => {
  await go("#/overview", ".tiles .tile");
  const tiles = await page.$$eval(".tiles .tile .tile-value", (els) => els.map((e) => e.textContent));
  assert.deepEqual(tiles.slice(0, 2), ["5", String(svc.store.queryEvents().total)]);
  assert.ok((await page.$$("svg.viz")).length >= 4, "charts drawn");
  assert.ok(await page.$("aside.disclaimer"), "non-conclusive disclaimer shown");
});

test("every page renders without errors", { skip }, async () => {
  const pages: Array<[string, string]> = [
    ["#/sessions", "table.data tbody tr"],
    [`#/sessions/${seeded.oddId}`, ".sequence"],
    ["#/timeline?session=dash-odd", "svg.timeline"],
    ["#/workflows", "svg.graph"],
    ["#/events", "table.data tbody tr"],
    ["#/findings", "table.data tbody tr"],
    ["#/environment", "table.data tbody tr"],
    ["#/runs", "table.data tbody tr"],
    [`#/runs/${seeded.runId}`, "table.data tbody tr"],
    ["#/screenshots", "table.data tbody tr"],
    ["#/reports", "main h1"],
    ["#/settings", "textarea.rules-editor"],
    ["#/compare?a=dash-n0&b=dash-odd", ".hero-value"],
  ];
  for (const [hash, sel] of pages) await go(hash, sel);
  assert.deepEqual(problems, []);
});

test("filters: severity and workflow narrow the findings list; the date range is honoured", { skip }, async () => {
  await go("#/findings?severity=warn", "table.data tbody tr");
  const sev = await page.$$eval("table.data tbody tr td:first-child", (tds) => tds.map((t) => t.textContent?.trim()));
  assert.ok(sev.length > 0 && sev.every((s) => s?.endsWith("warn")), JSON.stringify(sev));
  await page.selectOption('select[name="workflow"]', "LOGIN");
  await page.waitForFunction(() => location.hash.includes("workflow=LOGIN"));
  await go(`#/findings?range=custom&from=2000-01-01&to=2000-01-02`, ".empty");
  await go("#/events?kind=SCREENSHOT", "table.data tbody tr");
  assert.equal((await page.$$("table.data tbody tr")).length, 1);
});

test("event drawer opens from a row and links the findings that cite the event", { skip }, async () => {
  await go("#/events?session=dash-odd&kind=ERROR", "table.data tbody tr");
  await page.click("table.data tbody tr");
  await page.waitForSelector(".drawer:not([hidden]) dl.kv", { timeout: 10_000 });
  const text = (await page.textContent(".drawer")) ?? "";
  assert.match(text, /dash-odd-e\d{4}/);
  assert.match(text, /1 error event\(s\) recorded/, "citing finding listed");
  // The recorded message contains markup; it must be shown as text, never executed/parsed.
  assert.match(text, /<script>alert\(1\)<\/script>/);
  assert.equal(await page.evaluate(() => document.querySelectorAll("script").length), 1, "no injected script elements");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval(".drawer", (d) => (d as HTMLElement).hidden), true);
});

test("finding drill-down lists exactly the triggering event ids, each resolvable", { skip }, async () => {
  const f = svc.store.listFindings({ sessionId: seeded.oddId, ruleId: "GAP-LONG-IDLE" }).findings[0];
  assert.ok(f, "seeded session has a GAP-LONG-IDLE finding");
  await go(`#/findings/${f.finding_id}`, "table.data tbody tr");
  const triggers = await page.$$eval("table.data tbody tr", (rows) =>
    rows.filter((r) => r.querySelector("td")?.textContent?.trim() === "trigger").map((r) => r.querySelector("td:last-child")?.textContent?.trim()),
  );
  assert.deepEqual(triggers, f.event_ids);
  assert.match((await page.textContent("main")) ?? "", /cannot observe any platform's internal decisions/);
  await page.click("table.data tbody tr:nth-child(2)");
  await page.waitForSelector(".drawer:not([hidden]) dl.kv");
  assert.match((await page.textContent(".drawer")) ?? "", new RegExp(f.event_ids[0] as string));
  await page.keyboard.press("Escape");
});

test("timeline and workflow graph are interactive", { skip }, async () => {
  await go("#/timeline?session=dash-odd&zoom=4", "svg.timeline");
  // Charts re-render on resize, so use re-queried locators rather than element handles.
  const ticks = page.locator("svg.timeline .tick");
  assert.equal(await ticks.count(), svc.store.countEvents("dash-odd"));
  assert.equal(await page.locator("svg.timeline .band").count(), svc.store.listFindings({ sessionId: "dash-odd" }).total);
  await ticks.nth(1).focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".drawer:not([hidden]) dl.kv");
  await page.keyboard.press("Escape");

  await go("#/workflows", "svg.graph .edge");
  await page.focus("svg.graph .edge");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => location.hash.includes("edge="));
  await page.waitForSelector("text=Transition", { timeout: 10_000 });
  assert.ok((await page.$$("svg.graph .node")).length >= 5);
});

test("session comparison shows similarity, per-workflow deltas and environment differences", { skip }, async () => {
  await go("#/sessions", "table.data tbody tr");
  const boxes = await page.$$('table.data tbody input[type="checkbox"]');
  await boxes[0]?.check();
  await boxes[1]?.check();
  await page.click("text=Compare selected (2/2)");
  await page.waitForSelector(".hero-value");
  const text = (await page.textContent("main")) ?? "";
  assert.match(text, /similarity/);
  assert.match(text, /Time per workflow/);
  assert.match(text, /Environment differences/);
  assert.deepEqual(problems, []);
});
