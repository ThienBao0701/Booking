/** Dashboard hosting (ADR-0006) and the read-only query API it uses. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LabStats, ReplayRunSummary, SessionSummary, StoredEventRow } from "../src/shared.ts";
import { isOriginAllowed } from "../src/security.ts";
import { DASHBOARD_CSP, resolveDashboardFile } from "../src/routes/dashboard.ts";
import { AnalysisService } from "../src/analysis/service.ts";
import { type ServiceHarness, authHeaders, startServiceHarness } from "./helpers.ts";
import { ENV_A, SessionBuilder, T0, mockFlow, persist } from "./analysis-fixtures.ts";

function fixtureDashboard(): string {
  const dir = mkdtempSync(join(tmpdir(), "lab-dash-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  writeFileSync(join(dir, "styles.css"), "body{}");
  writeFileSync(join(dir, ".hidden.js"), "secret");
  return dir;
}

/** Raw request so paths are sent exactly as written (fetch would normalise them). */
function raw(h: ServiceHarness, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: h.port, method, path, headers: { host: `127.0.0.1:${h.port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function get<T>(h: ServiceHarness, path: string, headers = authHeaders()): Promise<{ status: number; json: T }> {
  const res = await fetch(`${h.base}${path}`, { headers });
  return { status: res.status, json: (await res.json()) as T };
}

test("origin: exactly the service's own origin is accepted; other local origins stay rejected", () => {
  const selfOrigin = "http://127.0.0.1:4577";
  assert.ok(isOriginAllowed({ origin: "http://127.0.0.1:4577", allowedOrigins: [], selfOrigin }));
  assert.ok(isOriginAllowed({ origin: "HTTP://127.0.0.1:4577", allowedOrigins: [], selfOrigin }));
  for (const o of ["http://127.0.0.1:4599", "http://localhost:4577", "https://127.0.0.1:4577", "http://127.0.0.1:45770", "http://evil.example:4577"]) {
    assert.equal(isOriginAllowed({ origin: o, allowedOrigins: [], selfOrigin }), false, o);
  }
  assert.equal(isOriginAllowed({ origin: "http://127.0.0.1:4577", allowedOrigins: [] }), false, "no self origin → web origins rejected as before");
});

test("dashboard static route: files, strict headers, no auth needed, API still needs the token", async () => {
  const h = await startServiceHarness();
  const dir = fixtureDashboard();
  h.config.dashboardDir = dir;
  try {
    const idx = await raw(h, "GET", "/dashboard/");
    assert.equal(idx.status, 200);
    assert.match(String(idx.headers["content-type"]), /^text\/html/);
    assert.equal(idx.headers["content-security-policy"], DASHBOARD_CSP);
    assert.match(DASHBOARD_CSP, /default-src 'none'/);
    assert.match(DASHBOARD_CSP, /script-src 'self'/);
    assert.match(DASHBOARD_CSP, /frame-ancestors 'none'/);
    assert.equal(idx.headers["x-frame-options"], "DENY");
    assert.equal(idx.headers["referrer-policy"], "no-referrer");
    assert.equal(idx.headers["x-content-type-options"], "nosniff");
    assert.match(String((await raw(h, "GET", "/dashboard/app.js")).headers["content-type"]), /^text\/javascript/);
    const head = await raw(h, "HEAD", "/dashboard/styles.css");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal((await raw(h, "GET", "/")).headers.location, "/dashboard/");
    assert.equal((await raw(h, "GET", "/dashboard")).status, 308);
    // Static files carry no data; the API remains token-protected.
    assert.equal((await raw(h, "GET", "/v1/sessions")).status, 401);
    assert.equal((await raw(h, "POST", "/dashboard/")).status, 401, "only GET/HEAD are static");
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard static route: traversal, hidden files, unknown types and symlink escapes are 404", async () => {
  const h = await startServiceHarness();
  const dir = fixtureDashboard();
  const outside = mkdtempSync(join(tmpdir(), "lab-outside-"));
  writeFileSync(join(outside, "secret.js"), "secret");
  symlinkSync(join(outside, "secret.js"), join(dir, "link.js"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "x.txt"), "nope");
  h.config.dashboardDir = dir;
  try {
    for (const p of [
      "/dashboard/../package.json",
      "/dashboard/%2e%2e/%2e%2e/package.json",
      "/dashboard/..%2f..%2fpackage.json",
      "/dashboard/sub/..%5c..%5cpackage.json",
      "/dashboard/.hidden.js",
      "/dashboard/link.js",
      "/dashboard/sub/x.txt",
      "/dashboard/%00app.js",
      "/dashboard/%E0%A4%A",
      "/dashboard/missing.js",
    ]) {
      const r = await raw(h, "GET", p);
      assert.ok([404, 401].includes(r.status), `${p} → ${r.status}`);
      assert.ok(!r.body.includes("secret") && !r.body.includes('"name"'), `${p} leaked content`);
    }
    assert.equal(resolveDashboardFile(dir, "/dashboard/../x.js"), undefined);
    assert.equal(resolveDashboardFile(dir, "/dashboard/a/./b.js"), undefined);
    assert.equal(resolveDashboardFile(dir, "/dashboard/app.js"), join(dir, "app.js"));
    assert.equal(resolveDashboardFile(dir, "/dashboard/"), join(dir, "index.html"));
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("dashboard not built → 503 with a hint (no crash)", async () => {
  const h = await startServiceHarness();
  const empty = mkdtempSync(join(tmpdir(), "lab-nodash-"));
  h.config.dashboardDir = empty;
  try {
    const r = await raw(h, "GET", "/dashboard/");
    assert.equal(r.status, 503);
    assert.match(r.body, /pnpm run build/);
  } finally {
    await h.close();
    rmSync(empty, { recursive: true, force: true });
  }
});

test("same-origin dashboard requests pass the origin check; another local origin does not", async () => {
  const h = await startServiceHarness();
  try {
    const self = await get(h, "/v1/stats", authHeaders({ origin: h.base }));
    assert.equal(self.status, 200);
    const mock = await get(h, "/v1/stats", authHeaders({ origin: "http://127.0.0.1:4599" }));
    assert.equal(mock.status, 403);
    const other = await get(h, "/v1/stats", authHeaders({ origin: `http://127.0.0.1:${h.port + 1}` }));
    assert.equal(other.status, 403);
    const noToken = await fetch(`${h.base}/v1/stats`, { headers: { origin: h.base } });
    assert.equal(noToken.status, 401, "same origin still needs the token");
  } finally {
    await h.close();
  }
});

async function seeded(): Promise<ServiceHarness> {
  const h = await startServiceHarness();
  for (let i = 0; i < 3; i++) persist(h.store, mockFlow(`q${i}`, { t0: T0 + i * 86_400_000, env: ENV_A }));
  const b = new SessionBuilder("qerr", { t0: T0 + 5 * 86_400_000 });
  b.start();
  b.wait(100).transition("RATE_SETUP");
  b.add("error", { workflow: "RATE_SETUP", severity: "error", metadata: { message: "save failed" } });
  b.add("screenshot", { workflow: "RATE_SETUP", metadata: { sha256: "b".repeat(64), bytes: 10, format: "png", trigger: "user" } });
  b.end();
  persist(h.store, b);
  h.store.saveRun({ runId: "run_q1", workflow: "wf", mode: "SIMULATE", startedAt: T0, endedAt: T0 + 10, status: "completed", checkpoints: [], steps: [{ id: "a", status: "ok", attempts: 1 }, { id: "b", status: "failed", attempts: 2, error: "x" }] });
  h.store.saveRun({ runId: "run_q2", workflow: "wf2", mode: "SIMULATE", startedAt: T0 + 5, status: "failed", checkpoints: [], steps: [] });
  new AnalysisService({ store: h.store }).run();
  return h;
}

test("GET /v1/stats aggregates counts and buckets days", async () => {
  const h = await seeded();
  try {
    const { status, json } = await get<LabStats>(h, "/v1/stats");
    assert.equal(status, 200);
    assert.equal(json.sessions, 4);
    assert.equal(json.events, h.store.queryEvents().total);
    assert.equal(json.runs, 2);
    assert.equal(json.events_by_severity.error, 1);
    assert.equal(json.runs_by_status.completed, 1);
    assert.ok(json.findings > 0);
    assert.equal(Object.values(json.findings_by_severity).reduce((a, b) => a + b, 0), json.findings);
    assert.equal(json.events_by_day.reduce((a, d) => a + d.count, 0), json.events);
    assert.equal(json.events_by_day.length, 4, "4 distinct days");
    const ranged = await get<LabStats>(h, `/v1/stats?from=${T0 + 4 * 86_400_000}`);
    assert.equal(ranged.json.sessions, 1);
    assert.equal(ranged.json.runs, 0);
    assert.equal((await get(h, "/v1/stats?tz=9999")).status, 400);
  } finally {
    await h.close();
  }
});

test("GET /v1/sessions returns summaries with counts and filters (additive to the old shape)", async () => {
  const h = await seeded();
  try {
    const all = await get<{ total: number; sessions: SessionSummary[] }>(h, "/v1/sessions");
    assert.equal(all.json.total, 4);
    const q = all.json.sessions.find((s) => s.id === "qerr") as SessionSummary;
    assert.ok(q);
    for (const k of ["id", "startedAt", "endedAt", "mode"] as const) assert.ok(k in q, `legacy field ${k}`);
    assert.equal(q.errorCount, 1);
    assert.equal(q.targetKind, "mock");
    assert.ok(q.eventCount > 0 && q.findingCount >= 1);
    assert.deepEqual((await get<{ sessions: SessionSummary[] }>(h, "/v1/sessions?workflow=RATE_SETUP")).json.sessions.map((s) => s.id), ["qerr"]);
    assert.deepEqual((await get<{ sessions: SessionSummary[] }>(h, "/v1/sessions?q=QERR")).json.sessions.map((s) => s.id), ["qerr"]);
    assert.equal((await get<{ sessions: SessionSummary[] }>(h, "/v1/sessions?limit=2&offset=1")).json.sessions.length, 2);
    assert.equal((await get(h, "/v1/sessions?workflow=NOPE")).status, 400);
  } finally {
    await h.close();
  }
});

test("GET /v1/events searches across sessions; GET /v1/events/:id returns one row", async () => {
  const h = await seeded();
  try {
    const errs = await get<{ total: number; events: StoredEventRow[] }>(h, "/v1/events?severity=error");
    assert.equal(errs.json.total, 1);
    assert.equal(errs.json.events[0]?.session_id, "qerr");
    const shots = await get<{ total: number; events: StoredEventRow[] }>(h, "/v1/events?kind=SCREENSHOT");
    assert.equal(shots.json.total, 1);
    const q = await get<{ total: number; events: StoredEventRow[] }>(h, "/v1/events?q=save%20failed");
    assert.equal(q.json.total, 1);
    const asc = await get<{ events: StoredEventRow[] }>(h, "/v1/events?session=q0&order=asc&limit=5");
    assert.deepEqual(asc.json.events.map((e) => e.seq), [0, 1, 2, 3, 4]);
    const desc = await get<{ events: StoredEventRow[] }>(h, "/v1/events?session=q0&limit=1");
    assert.ok((desc.json.events[0]?.seq ?? 0) > 4);
    const one = await get<{ event: StoredEventRow }>(h, `/v1/events/${asc.json.events[2]?.id}`);
    assert.equal(one.json.event.seq, 2);
    assert.equal((await get(h, "/v1/events/nope")).status, 404);
    for (const bad of ["kind=NOPE", "severity=x", "category=x", "order=up", "limit=-1", "session=a%20b", `q=${"x".repeat(201)}`]) {
      assert.equal((await get(h, `/v1/events?${bad}`)).status, 400, bad);
    }
  } finally {
    await h.close();
  }
});

test("GET /v1/runs lists runs with step outcome counts; environment reports are served per session", async () => {
  const h = await seeded();
  try {
    const runs = await get<{ total: number; runs: ReplayRunSummary[] }>(h, "/v1/runs");
    assert.equal(runs.json.total, 2);
    const r1 = runs.json.runs.find((r) => r.runId === "run_q1") as ReplayRunSummary;
    assert.deepEqual(r1.steps, { total: 2, ok: 1, failed: 1 });
    assert.deepEqual((await get<{ runs: ReplayRunSummary[] }>(h, "/v1/runs?status=failed")).json.runs.map((r) => r.runId), ["run_q2"]);
    assert.equal((await get(h, "/v1/runs?status=bogus")).status, 400);

    const env = await get<{ environments: Array<{ session_id: string; captured: boolean; browser?: string }> }>(h, "/v1/analysis/environment?sessions=q0,qerr");
    assert.equal(env.status, 200);
    assert.deepEqual(env.json.environments.map((e) => [e.session_id, e.captured, e.browser ?? null]), [["q0", true, "Chrome"], ["qerr", false, null]]);
  } finally {
    await h.close();
  }
});
