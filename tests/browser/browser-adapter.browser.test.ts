/**
 * Phase 11 real-browser integration (opt-in: `pnpm run test:browser`):
 * the PlaywrightAdapter (Chromium over CDP) behind BrowserAdapterController.
 *   - the example workflow replays on the REAL mock UI at 127.0.0.1:4599;
 *   - the allowlist holds in a real browser: off-allowlist navigations,
 *     sub-resources, fetches and redirects never reach the other origin;
 *   - password fields are never read; dialogs never hang a run;
 *   - failures are classified (timeouts, blocked navigation).
 * Skips cleanly when playwright-core / Chromium are not available.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type { WorkflowFile } from "../../shared/src/index.ts";
import { ReplayEngine } from "../../windows-service/src/automation/engine.ts";
import { ControllerError } from "../../windows-service/src/automation/controller.ts";
import { BrowserAdapterController, BrowserTargetPolicy, PlaywrightAdapter } from "../../windows-service/src/automation/browser/index.ts";
import { MOCK_URL, ensureMock, type MockHandle } from "../e2e/harness.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

let executablePath: string | undefined;
try {
  const pw = await import("playwright-core");
  const p = process.env.LAB_CHROMIUM_PATH ?? pw.chromium.executablePath();
  executablePath = existsSync(p) ? p : undefined;
} catch {
  executablePath = undefined;
}
const skip = !executablePath ? "playwright-core or Chromium not available" : false;

let mock: MockHandle;
let site: Server;
let other: Server;
let siteUrl = "";
let otherUrl = "";
const otherHits: string[] = [];

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

before(async () => {
  if (skip) return;
  mock = await ensureMock();
  other = createServer((req, res) => {
    otherHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("other");
  });
  otherUrl = await listen(other);
  site = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `${otherUrl}/landing` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Adapter test page</title>
<img src="${otherUrl}/pixel.png">
<script>fetch("${otherUrl}/beacon").catch(() => {});</script>
<a id="away" href="${otherUrl}/away">away</a>
<label>User <input id="user" name="user"></label>
<label>Password <input id="pw" name="password" type="password"></label>
<button id="alert" onclick="alert('saved'); document.body.dataset.after='1'">alert</button>
<select id="pick"><option value="">choose</option><option value="a">A</option><option value="b">B</option></select>`);
  });
  siteUrl = await listen(site);
});

after(async () => {
  if (skip) return;
  await new Promise<void>((r) => site.close(() => r()));
  await new Promise<void>((r) => other.close(() => r()));
  await mock.close();
});

function controllerFor(baseUrl: string, allowlist: string[]): BrowserAdapterController {
  const p = BrowserTargetPolicy.create({ mode: "SIMULATE", target: { kind: "mock", baseUrl }, allowlist });
  if (!p.ok) throw new Error(p.reason);
  return new BrowserAdapterController({ adapter: new PlaywrightAdapter(), policy: p.policy, executablePath, defaultTimeoutMs: 10_000 });
}

test("the example workflow replays on the real mock UI in Chromium", { skip }, async () => {
  const wf = JSON.parse(readFileSync(`${root}examples/workflows/mock-full-flow.json`, "utf8")) as WorkflowFile;
  const username = `browser-${Date.now()}`;
  const since = ((await (await fetch(`${MOCK_URL}/api/events?since=1000000000`)).json()) as { total: number }).total;
  const c = controllerFor(MOCK_URL, [MOCK_URL]);
  const run = await new ReplayEngine(wf, { mode: "SIMULATE", controller: c, params: { username, propertyName: "Browser Villa" } }).start();
  assert.equal(run.status, "completed", JSON.stringify(run.steps.find((s) => s.status === "failed")));
  const body = (await (await fetch(`${MOCK_URL}/api/events?since=${since}`)).json()) as { events: Array<{ workflow: string; actor: string | null }> };
  const labels: string[] = [];
  for (const e of body.events.filter((x) => x.actor === username)) if (labels.at(-1) !== e.workflow) labels.push(e.workflow);
  assert.deepEqual(labels, ["LOGIN", "PROPERTY_SETUP", "ROOM_SETUP", "RATE_SETUP", "RESERVATION", "CANCELLATION", "MESSAGING", "REVIEW", "PHOTO", "REPORTING"]);
});

test("the allowlist holds in a real browser: nothing reaches another origin", { skip }, async () => {
  const c = controllerFor(siteUrl, [siteUrl]);
  await c.launch({ baseUrl: siteUrl });
  try {
    await c.navigate("/");
    assert.equal((await c.getPageMetadata()).title, "Adapter test page");
    await assert.rejects(c.click("#away"), (e: unknown) => e instanceof ControllerError && e.code === "NAVIGATION_BLOCKED");
    assert.ok(c.getCurrentUrl() === "about:blank" || new URL(c.getCurrentUrl()).origin === siteUrl, "never on the other origin");
    await c.navigate("/");
    await assert.rejects(c.navigate(`${otherUrl}/direct`), (e: unknown) => e instanceof ControllerError && e.code === "NAVIGATION_BLOCKED");
    await assert.rejects(c.navigate("/redirect"), (e: unknown) => e instanceof ControllerError && e.code === "NAVIGATION_BLOCKED");
    assert.equal(c.getCurrentUrl(), "about:blank", "never left on an off-allowlist page");
    // Logged URLs are origin + path, redacted (IP addresses are masked by the privacy rules).
    const kinds = c.session!.blocked.map((b) => `${b.resourceType}:${/:\d+(\/[^?#]*)$/.exec(b.url)?.[1] ?? b.url}`);
    for (const expected of ["image:/pixel.png", "fetch:/beacon", "document:/away"]) assert.ok(kinds.includes(expected), `${expected} in ${kinds.join(", ")}`);
    assert.deepEqual(otherHits, [], `the other origin received: ${otherHits.join(", ")}`);
  } finally {
    await c.close();
  }
});

test("password fields are never read; dialogs are dismissed; selects and timeouts behave", { skip }, async () => {
  const c = controllerFor(siteUrl, [siteUrl]);
  await c.launch({ baseUrl: siteUrl });
  try {
    await c.navigate("/");
    await c.type("#user", "operator");
    await c.type("#pw", "hunter2-secret");
    await c.select("#pick", "$last");
    const state = await c.captureState();
    assert.equal(state.fields.user, "operator");
    assert.equal(state.fields.pick, "b");
    assert.ok(!JSON.stringify(state).includes("hunter2"), "password never captured");
    await c.click("#alert");
    await c.waitFor('body[data-after="1"]');
    assert.ok(c.log.some((e) => e.type === "dialog.dismissed"));
    const shot = await c.captureScreenshot();
    assert.deepEqual([...(shot.data ?? []).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.match(shot.sha256 ?? "", /^[0-9a-f]{64}$/);
    await assert.rejects(c.waitFor("#does-not-exist", { timeoutMs: 300 }), (e: unknown) => e instanceof ControllerError && e.code === "TIMEOUT" && e.retryable);
    const second = await c.openTab("/");
    assert.equal(second, "tab-2");
    await c.closeTab(second);
    assert.equal(c.session!.activeTabId, "tab-1");
  } finally {
    await c.close();
  }
});
