/** Phase 11: BrowserTargetPolicy, error classification, BrowserSession/Controller over a fake adapter, engine integration. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { AuthorizationRecord, ReplayTarget, SafetyMode, WorkflowFile } from "../src/shared.ts";
import { ReplayEngine } from "../src/automation/engine.ts";
import {
  BrowserAdapterController,
  BrowserError,
  BrowserTargetPolicy,
  PlaywrightAdapter,
  classifyError,
  normalizeOrigin,
  resolveSelector,
} from "../src/automation/browser/index.ts";
import { ControllerError } from "../src/automation/controller.ts";
import { FakeAdapter, type FakeWorld, PNG_BYTES } from "./fake-browser.ts";

const MOCK = "http://127.0.0.1:4599";
const STAGING = "https://staging.example.test";
const AUTH: AuthorizationRecord = { owner: "me", system: "staging-extranet", grantedBy: "team-lead", acknowledgedAt: 1 };

function policy(opts: { mode?: SafetyMode; target?: ReplayTarget; allowlist?: string[]; resourceOrigins?: string[] } = {}): BrowserTargetPolicy {
  const r = BrowserTargetPolicy.create({
    mode: opts.mode ?? "SIMULATE",
    target: opts.target ?? { kind: "mock", baseUrl: MOCK },
    allowlist: opts.allowlist ?? [MOCK],
    ...(opts.resourceOrigins ? { resourceOrigins: opts.resourceOrigins } : {}),
  });
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.policy;
}

function world(): FakeWorld {
  return {
    pages: {
      [`${MOCK}/`]: {
        title: "Mock Extranet",
        requests: [`${MOCK}/app.js`],
        elements: {
          "#login-username": [{ field: { key: "login-username", tag: "input", type: "text", id: "login-username" } }],
          "#login-password": [{ field: { key: "login-password", tag: "input", type: "password", id: "login-password" } }],
          "#api-token": [{ field: { key: "api_token", tag: "input", type: "text", name: "api_token" } }],
          "#note": [{ field: { key: "note", tag: "textarea", type: "textarea", id: "note" } }],
          "#login-submit": [{ requests: [`${MOCK}/api/login`] }],
          "#room-property": [{ options: ["", "p1", "p2", "p3"] }],
          "button[data-cancel]": [{}, {}, {}],
          ".dup": [{}, {}],
          "#hidden": [{ visible: false }],
          "#ext-link": [{ navigatesTo: "https://evil.example/steal?token=abc" }],
          "#cdn": [{ requests: ["https://cdn.example.test/lib.js?token=abc"] }],
          "#alert": [{ dialog: "Saved for jane@example.com" }],
          "#to-page2": [{ navigatesTo: `${MOCK}/page2` }],
        },
      },
      [`${MOCK}/page2`]: { title: "Page 2", elements: { "#p2": [{}] } },
      [`${MOCK}/redirect`]: { redirectTo: "https://evil.example/landing" },
      "https://evil.example/landing": { title: "elsewhere" },
    },
  };
}

async function launched(w = world(), p = policy()): Promise<{ adapter: FakeAdapter; c: BrowserAdapterController }> {
  const adapter = new FakeAdapter(w);
  const c = new BrowserAdapterController({ adapter, policy: p, settleMs: 0, defaultTimeoutMs: 1000 });
  await c.launch({ baseUrl: MOCK });
  return { adapter, c };
}

async function rejects(p: Promise<unknown>, code: string, category?: string): Promise<BrowserError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ControllerError, String(err));
    assert.equal(err.code, code, err.message);
    if (category) assert.equal((err as BrowserError).category, category, err.message);
    return err as BrowserError;
  }
  assert.fail(`expected ${code}`);
}

// ------------------------------------------------------------------ policy

test("allowlist entries: exact origins only; https for remote, http for loopback", () => {
  assert.deepEqual(normalizeOrigin("https://Staging.Example.test:443"), { origin: "https://staging.example.test" });
  assert.deepEqual(normalizeOrigin("http://127.0.0.1:4599/"), { origin: MOCK });
  assert.deepEqual(normalizeOrigin("http://localhost:8080"), { origin: "http://localhost:8080" });
  for (const bad of ["http://staging.example.test", "https://*.example.test", "https://example.test/app", "https://user@example.test", "ftp://example.test", "", "https://example.test/?q=1", "javascript:alert(1)", "not a url"]) {
    assert.ok("error" in normalizeOrigin(bad), bad);
  }
});

test("policy creation runs the shared authorization first and requires the target in the explicit allowlist", () => {
  const c = (mode: SafetyMode, target: ReplayTarget, allowlist: string[]) => BrowserTargetPolicy.create({ mode, target, allowlist });
  assert.equal(c("SIMULATE", { kind: "mock", baseUrl: MOCK }, [MOCK]).ok, true);
  const observeMode = c("OBSERVE", { kind: "mock", baseUrl: MOCK }, [MOCK]);
  assert.ok(!observeMode.ok && observeMode.code === "NOT_AUTHORIZED" && observeMode.replayDecision?.code === "MODE_FORBIDS_SIDE_EFFECTS");
  const authInSimulate = c("SIMULATE", { kind: "authorized", baseUrl: STAGING, authorization: AUTH }, [STAGING]);
  assert.ok(!authInSimulate.ok && authInSimulate.replayDecision?.code === "MODE_FORBIDS_AUTHORIZED_TARGET");
  const noRecord = c("AUTHORIZED_AUTOMATION", { kind: "authorized", baseUrl: STAGING } as unknown as ReplayTarget, [STAGING]);
  assert.ok(!noRecord.ok && noRecord.replayDecision?.code === "MISSING_AUTHORIZATION");
  const fakeMock = c("SIMULATE", { kind: "mock", baseUrl: STAGING }, [STAGING]);
  assert.ok(!fakeMock.ok && fakeMock.replayDecision?.code === "MOCK_TARGET_NOT_LOCAL");
  const notListed = c("AUTHORIZED_AUTOMATION", { kind: "authorized", baseUrl: STAGING, authorization: AUTH }, []);
  assert.ok(!notListed.ok && notListed.code === "TARGET_NOT_ALLOWLISTED", "authorization alone is not enough");
  const badEntry = c("SIMULATE", { kind: "mock", baseUrl: MOCK }, [MOCK, "https://*.example.test"]);
  assert.ok(!badEntry.ok && badEntry.code === "INVALID_ALLOWLIST_ENTRY");
  assert.equal(c("AUTHORIZED_AUTOMATION", { kind: "authorized", baseUrl: `${STAGING}/extranet/`, authorization: AUTH }, [STAGING]).ok, true);
  const tooMany = BrowserTargetPolicy.create({ mode: "SIMULATE", target: { kind: "mock", baseUrl: MOCK }, allowlist: Array.from({ length: 51 }, (_, i) => `http://127.0.0.1:${4000 + i}`) });
  assert.ok(!tooMany.ok && tooMany.code === "INVALID_ALLOWLIST_ENTRY");
});

test("navigation and request checks: listed origins only; resource origins never widen navigation", () => {
  const p = policy({ resourceOrigins: ["https://cdn.example.test"] });
  assert.equal(p.checkNavigation(`${MOCK}/x`).allowed, true);
  assert.equal(p.checkNavigation("about:blank").allowed, true);
  for (const bad of ["http://127.0.0.1:4600/", "https://evil.example/", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", `http://127.0.0.1:4599@evil.example/`]) {
    assert.equal(p.checkNavigation(bad).allowed, false, bad);
  }
  assert.equal(p.checkRequest("https://cdn.example.test/lib.js", false).allowed, true);
  assert.equal(p.checkRequest("https://cdn.example.test/", true).allowed, false, "resource origin is not a navigation origin");
  assert.equal(p.checkRequest("https://tracker.example/pixel", false).allowed, false);
  assert.equal(p.checkRequest("data:image/png;base64,AAAA", false).allowed, true);
  assert.equal(p.checkRequest("ws://127.0.0.1:4599/socket", false).allowed, false);
  assert.equal(p.resolve("/rooms"), `${MOCK}/rooms`);
  assert.deepEqual(p.describe().navigationOrigins, [MOCK]);
});

// ---------------------------------------------------------- classification

test("error classification maps browser failures to stable codes and categories", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["TimeoutError: locator.click: Timeout 5000ms exceeded.", "TIMEOUT", "timeout", true],
    ["locator.click: Error: strict mode violation: locator('.x') resolved to 2 elements", "WRONG_ELEMENT", "ambiguous_selector", false],
    ["locator.selectOption: did not find some options", "OPTION_NOT_FOUND", "option_missing", true],
    ["element is not visible", "NOT_VISIBLE", "element_hidden", true],
    ["Element is not attached to the DOM", "ELEMENT_NOT_FOUND", "element_missing", true],
    ["page.goto: net::ERR_BLOCKED_BY_CLIENT at https://evil.example/", "NAVIGATION_BLOCKED", "request_blocked", false],
    ["page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4599/", "TARGET_ERROR", "network", true],
    ["Target page, context or browser has been closed", "TARGET_ERROR", "browser_closed", false],
    ["Page crashed", "TARGET_ERROR", "page_crashed", false],
    ["browserType.launch: Executable doesn't exist at /nope", "TARGET_ERROR", "launch_failed", false],
    ["something odd", "TARGET_ERROR", "unknown", false],
  ];
  for (const [msg, code, category, retryable] of cases) {
    const e = classifyError(new Error(msg));
    assert.deepEqual([e.code, e.category, e.retryable], [code, category, retryable], msg);
  }
  const kept = classifyError(new ControllerError("NAVIGATION_BLOCKED", "x"));
  assert.deepEqual([kept.code, kept.category], ["NAVIGATION_BLOCKED", "navigation_blocked"]);
  assert.ok(classifyError("plain string") instanceof BrowserError);
});

// -------------------------------------------------------------- controller

test("launch: only for the policy's target, before any browser starts; context refuses downloads", async () => {
  const adapter = new FakeAdapter(world());
  const c = new BrowserAdapterController({ adapter, policy: policy(), settleMs: 0 });
  await rejects(c.launch({ baseUrl: "http://127.0.0.1:4600" }), "NAVIGATION_BLOCKED", "navigation_blocked");
  await rejects(c.launch({ baseUrl: "https://evil.example" }), "NAVIGATION_BLOCKED");
  assert.equal(adapter.launches.length, 0, "no browser was launched for a non-authorized URL");
  await c.launch({ baseUrl: `${MOCK}/` });
  assert.deepEqual(adapter.launches.map((l) => l.headless), [true]);
  assert.ok(adapter.calls.includes("newContext:acceptDownloads=false"));
  assert.equal(c.session?.activeTabId, "tab-1");
  assert.equal(c.getCurrentUrl(), "about:blank");
  await rejects(new BrowserAdapterController({ adapter, policy: policy() }).click("#x"), "NOT_LAUNCHED");
});

test("navigation: relative URLs resolve to the target; blocked origins are refused before any request", async () => {
  const { adapter, c } = await launched();
  await c.navigate("/");
  assert.equal(c.getCurrentUrl(), `${MOCK}/`);
  assert.equal((await c.getPageMetadata()).title, "Mock Extranet");
  assert.equal((await c.getPageMetadata()).status, 200);
  const gotos = adapter.calls.filter((x) => x === "goto").length;
  await rejects(c.navigate("https://evil.example/"), "NAVIGATION_BLOCKED", "navigation_blocked");
  await rejects(c.navigate("http://127.0.0.1:4600/"), "NAVIGATION_BLOCKED");
  await rejects(c.navigate("javascript:alert(1)"), "NAVIGATION_BLOCKED");
  assert.equal(adapter.calls.filter((x) => x === "goto").length, gotos, "the browser never received the blocked navigations");
  // A redirect that lands elsewhere is caught after the fact and left immediately.
  await rejects(c.navigate("/redirect"), "NAVIGATION_BLOCKED", "navigation_blocked");
  assert.equal(c.getCurrentUrl(), "about:blank");
  await c.close();
});

test("in-page requests: off-allowlist navigations and sub-resources are aborted and logged without query strings", async () => {
  const { adapter, c } = await launched();
  await c.navigate("/");
  await rejects(c.click("#ext-link"), "NAVIGATION_BLOCKED", "navigation_blocked");
  assert.equal(c.getCurrentUrl(), `${MOCK}/`, "the link to another origin did not navigate");
  await c.click("#cdn");
  const s = c.session!;
  assert.equal(s.blockedCount, 2);
  assert.deepEqual(s.blocked.map((b) => [b.url, b.isNavigation]), [["https://evil.example/steal", true], ["https://cdn.example.test/lib.js", false]]);
  assert.ok(!JSON.stringify(s.log).includes("token=abc"), "query strings never logged");
  assert.ok(adapter.context.requests.some((r) => r.url === `${MOCK}/app.js` && r.allowed));
  await c.close();

  const withCdn = await launched(world(), policy({ resourceOrigins: ["https://cdn.example.test"] }));
  await withCdn.c.navigate("/");
  await withCdn.c.click("#cdn");
  assert.equal(withCdn.c.session!.blockedCount, 0, "explicit resource origin is allowed");
  await withCdn.c.close();
});

test("selectors: $last binds to the last match / option; ambiguous, missing and hidden elements are classified", async () => {
  assert.deepEqual(resolveSelector('button[data-cancel="$last"]'), { css: "button[data-cancel]", pick: "last" });
  assert.deepEqual(resolveSelector("button[data-cancel='$last.reservation']"), { css: "button[data-cancel]", pick: "last" });
  assert.deepEqual(resolveSelector("#login-submit"), { css: "#login-submit", pick: "only" });
  const { adapter, c } = await launched();
  await c.navigate("/");
  await c.type("#login-username", "operator");
  await c.click("#login-submit");
  await c.click('button[data-cancel="$last"]');
  assert.deepEqual(adapter.clicked.slice(-2), ["#login-submit", "button[data-cancel]:last"]);
  await c.select("#room-property", "$last");
  await c.select("#room-property", "p1");
  await rejects(c.select("#room-property", "nope"), "OPTION_NOT_FOUND", "option_missing");
  await rejects(c.click(".dup"), "WRONG_ELEMENT", "ambiguous_selector");
  const missing = await rejects(c.waitFor("#absent"), "TIMEOUT", "timeout");
  assert.equal(missing.retryable, true);
  await rejects(c.click("#hidden"), "NOT_VISIBLE", "element_hidden");
  await c.close();
});

test("tabs, history and page lifecycle", async () => {
  const { c } = await launched();
  await c.navigate("/");
  const t2 = await c.openTab("/page2");
  assert.equal(t2, "tab-2");
  assert.equal(c.getCurrentUrl(), `${MOCK}/page2`);
  await c.closeTab();
  assert.equal(c.session!.activeTabId, "tab-1");
  assert.equal(c.getCurrentUrl(), `${MOCK}/`);
  await rejects(c.closeTab("tab-9"), "NO_TAB");
  await c.click("#to-page2");
  assert.equal(c.getCurrentUrl(), `${MOCK}/page2`);
  await c.back();
  assert.equal(c.getCurrentUrl(), `${MOCK}/`);
  await c.forward();
  assert.equal(c.getCurrentUrl(), `${MOCK}/page2`);
  await rejects(c.forward(), "NO_HISTORY");
  const snap = await c.snapshot();
  await c.navigate("/");
  await c.restore(snap);
  assert.equal(c.getCurrentUrl(), `${MOCK}/page2`, "rollback returns to the checkpoint URL");
  await c.openTab();
  await rejects(c.reload(), "NO_HISTORY");
  await c.close();
});

test("dialogs are dismissed and logged (redacted); crashes and disconnects are classified", async () => {
  const { adapter, c } = await launched();
  await c.navigate("/");
  await c.click("#alert");
  const d = c.log.find((e) => e.type === "dialog.dismissed");
  assert.ok(d && !d.detail?.includes("jane@example.com"), JSON.stringify(d));
  (adapter.context.pages[0] as unknown as { crash(): void }).crash();
  await rejects(c.click("#login-submit"), "TARGET_ERROR", "page_crashed");
  adapter.browser!.disconnect();
  await rejects(c.openTab(), "TARGET_ERROR", "browser_closed");
  await c.close();
  assert.equal(adapter.browser!.closedCalls, 1);
  await rejects(c.click("#x"), "NOT_LAUNCHED", "browser_closed");
});

test("timeouts and cancellation", async () => {
  const w = world();
  const { c } = await launched(w);
  await c.navigate("/");
  const pre = new AbortController();
  pre.abort();
  await rejects(c.click("#login-submit", { signal: pre.signal }), "ABORTED", "aborted");
  w.delayMs = 300;
  const ctrl = new AbortController();
  const started = Date.now();
  setTimeout(() => ctrl.abort(), 30);
  await rejects(c.click("#login-submit", { signal: ctrl.signal }), "ABORTED");
  assert.ok(Date.now() - started < 250, "abort returns promptly");
  w.delayMs = 0;
  w.failNext = { click: new Error("TimeoutError: locator.click: Timeout 40ms exceeded.") };
  const t = await rejects(c.click("#login-submit", { timeoutMs: 40 }), "TIMEOUT", "timeout");
  assert.equal(t.retryable, true);
  await c.close();
});

test("state capture never reads password or sensitive fields and redacts the rest; screenshots are PNG + sha256", async () => {
  const { c } = await launched();
  await c.navigate("/");
  await c.type("#login-username", "operator");
  await c.type("#login-password", "hunter2");
  await c.type("#api-token", "sk_live_abcdefghijklmnop");
  await c.type("#note", "mail jane@example.com");
  const state = await c.captureState();
  assert.equal(state.fields["login-username"], "operator");
  assert.equal("login-password" in state.fields, false);
  assert.equal("api_token" in state.fields, false);
  assert.ok(!(state.fields.note ?? "").includes("jane@example.com"));
  assert.ok(!JSON.stringify(state).includes("hunter2"));
  assert.equal(state.tabId, "tab-1");
  const shot = await c.captureScreenshot();
  assert.deepEqual([shot.supported, shot.mimeType, shot.sha256], [true, "image/png", createHash("sha256").update(PNG_BYTES).digest("hex")]);
  await c.close();
});

test("launch failures are classified; a missing playwright-core is UNSUPPORTED", async () => {
  const w = world();
  w.failNext = { launch: new Error("browserType.launch: Executable doesn't exist at /nope/chrome") };
  const c = new BrowserAdapterController({ adapter: new FakeAdapter(w), policy: policy(), settleMs: 0 });
  await rejects(c.launch({ baseUrl: MOCK }), "TARGET_ERROR", "launch_failed");
  const pw = new BrowserAdapterController({ adapter: new PlaywrightAdapter({ load: () => Promise.reject(new Error("Cannot find package")) }), policy: policy(), settleMs: 0 });
  await rejects(pw.launch({ baseUrl: MOCK }), "UNSUPPORTED", "unsupported");
});

// ------------------------------------------------------ engine integration

const FLOW: WorkflowFile = {
  workflow: "fake-flow",
  version: 1,
  target: { kind: "mock", baseUrl: MOCK },
  steps: [
    { id: "open", action: "navigate", target: "/" },
    { id: "user", action: "type", target: "#login-username", value: "{{user}}" },
    { id: "login", action: "click", target: "#login-submit", checkpoint: true },
    { id: "pick", action: "select", target: "#room-property", value: "$last" },
    { id: "cancel", action: "click", target: 'button[data-cancel="$last"]' },
    { id: "state", action: "captureState" },
    { id: "shot", action: "captureScreenshot" },
  ],
};

test("replay engine drives the browser controller end to end; screenshots count as executed steps", async () => {
  const adapter = new FakeAdapter(world());
  const c = new BrowserAdapterController({ adapter, policy: policy(), settleMs: 0 });
  const run = await new ReplayEngine(FLOW, { mode: "SIMULATE", controller: c, params: { user: "operator" } }).start();
  assert.equal(run.status, "completed", JSON.stringify(run.steps));
  assert.ok(run.steps.every((s) => s.status === "ok"));
  assert.equal(adapter.browser!.closedCalls, 1, "browser closed at the end of the run");
});

test("an unauthorized run never launches a browser", async () => {
  const adapter = new FakeAdapter(world());
  const c = new BrowserAdapterController({ adapter, policy: policy(), settleMs: 0 });
  await assert.rejects(new ReplayEngine(FLOW, { mode: "OBSERVE", controller: c, params: { user: "x" } }).start(), /not authorized/i);
  const elsewhere: WorkflowFile = { ...FLOW, target: { kind: "mock", baseUrl: "http://127.0.0.1:4600" } };
  const run = new ReplayEngine(elsewhere, { mode: "SIMULATE", controller: c, params: { user: "x" } });
  await assert.rejects(run.start(), /not the authorized target/);
  assert.equal(adapter.launches.length, 0);
});

test("CLI: --controller browser is denied (exit 2, no browser) unless the target origin is explicitly allowlisted", async () => {
  const { main } = await import("../src/automation/cli.ts");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const wf = `${root}examples/workflows/mock-full-flow.json`;
  const params = `${root}examples/workflows/mock-full-flow.params.json`;
  const out: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stderr.write;
  try {
    assert.equal(await main([wf, "--controller", "browser", "--dry-run", "--params-file", params]), 2);
    assert.match(out.join(""), /TARGET_NOT_ALLOWLISTED/);
    assert.equal(await main([wf, "--controller", "browser", "--allow-origin", "https://*.example.test", "--dry-run", "--params-file", params]), 2);
    assert.equal(await main([wf, "--controller", "browser", "--mode", "OBSERVE", "--allow-origin", MOCK, "--dry-run", "--params-file", params]), 2);
    assert.match(out.join(""), /MODE_FORBIDS_SIDE_EFFECTS/);
    assert.equal(await main([wf, "--controller", "browser", "--allow-origin", MOCK, "--dry-run", "--params-file", params]), 0, "dry run plans without launching");
  } finally {
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
});
