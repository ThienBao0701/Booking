/** Forensic reports: model, traceability, HTML/print/CSV renderings, API, CLI. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ForensicReport, PLATFORM_CAVEAT, REPORT_SECTIONS, findConclusiveClaims } from "../src/shared.ts";
import { Store } from "../src/db/store.ts";
import { AnalysisService } from "../src/analysis/service.ts";
import { REPORT_CSS, REPORT_STYLE_HASH, anchor, buildReport, csvCell, renderReport, reportDigest, reportHtml } from "../src/reports/index.ts";
import { runReportCli } from "../src/reports/cli.ts";
import { authHeaders, startServiceHarness } from "./helpers.ts";
import { ENV_A, SessionBuilder, T0, mockFlow, persist } from "./analysis-fixtures.ts";

const XSS_SELECTOR = `"><script>alert(1)</script>`;
const XSS_MESSAGE = `<img src=x onerror=alert(2)>`;
const FORMULA = `=HYPERLINK("http://example.invalid","x")`;

/** A store with a baseline flow, a later flow, and an irregular session with hostile strings. */
function seed(store: Store): void {
  persist(store, mockFlow("base", { t0: T0, env: ENV_A }));
  persist(store, mockFlow("later", { t0: T0 + 3_600_000, pace: 1.5, env: ENV_A }));
  const b = new SessionBuilder("odd", { t0: T0 + 7_200_000 });
  b.start({ ...ENV_A, language: "vi-VN" });
  b.wait(100).transition("LOGIN");
  for (let i = 0; i < 4; i++) b.wait(200).click("#login-submit", "LOGIN");
  b.wait(100).add("click", { workflow: "LOGIN", target: { tag: "button", selector: XSS_SELECTOR } });
  b.wait(100).add("click", { workflow: "LOGIN", target: { tag: "button", selector: FORMULA } });
  b.add("error", { workflow: "LOGIN", severity: "error", metadata: { message: XSS_MESSAGE } });
  b.wait(400_000).transition("RATE_SETUP", "LOGIN");
  b.wait(1000).click("#rate-submit", "RATE_SETUP");
  b.end();
  persist(store, b);
}

function setup(): { store: Store; svc: AnalysisService; done: () => void } {
  const store = new Store(":memory:");
  seed(store);
  return { store, svc: new AnalysisService({ store }), done: () => store.close() };
}

function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

test("report model: every required section, integrity digest, stored vs computed findings", () => {
  const { store, svc, done } = setup();
  try {
    const computed = buildReport(store, svc, "odd", { now: T0 + 1 }) as ForensicReport;
    assert.equal(computed.findings_source, "computed");
    for (const [key] of REPORT_SECTIONS) assert.ok(key in computed, `section ${key}`);
    assert.equal(computed.report_version, 1);
    assert.equal(computed.integrity.digest, reportDigest(computed));
    const tampered = { ...computed, findings: computed.findings.slice(1) };
    assert.notEqual(reportDigest(tampered), computed.integrity.digest, "digest detects changes");

    svc.run(["odd"]);
    const stored = buildReport(store, svc, "odd", { now: T0 + 1 }) as ForensicReport;
    assert.equal(stored.findings_source, "stored");
    assert.deepEqual(stored.findings.map((f) => f.finding_id).sort(), store.listFindings({ sessionId: "odd" }).findings.map((f) => f.finding_id).sort());
    assert.equal(stored.executive_summary.findings_total, stored.findings.length);
    assert.equal(stored.executive_summary.findings_by_severity.error, 0);
    assert.ok((stored.executive_summary.findings_by_severity.warn ?? 0) >= 1, "CNT-ERROR-EVENTS is warn");
    assert.equal(stored.session.event_count, store.countEvents("odd"));
    assert.equal(buildReport(store, svc, "missing"), undefined);
  } finally {
    done();
  }
});

test("traceability: every finding's event ids (and evidence) resolve to timeline rows that link back", () => {
  const { store, svc, done } = setup();
  try {
    svc.run();
    for (const id of ["odd", "base", "later"]) {
      const r = buildReport(store, svc, id) as ForensicReport;
      const rows = new Map(r.timeline.events.map((e) => [e.event_id, e]));
      assert.ok(r.findings.length > 0, `${id} has findings`);
      for (const f of r.findings) {
        assert.ok(f.event_ids.length > 0);
        for (const eid of [...f.event_ids, ...f.evidence.map((e) => e.event_id)]) {
          const row = rows.get(eid);
          assert.ok(row, `${f.rule_id}: event ${eid} in timeline`);
          assert.ok(row.cited_by.includes(f.finding_id), `${eid} links back to ${f.finding_id}`);
        }
        const ev = r.evidence.find((e) => e.finding_id === f.finding_id);
        assert.deepEqual(ev?.event_ids, f.event_ids);
        const ce = r.counter_evidence.find((c) => c.finding_id === f.finding_id);
        assert.equal(ce?.items[ce.items.length - 1], PLATFORM_CAVEAT);
      }
      for (const e of r.timeline.events) for (const fid of e.cited_by) assert.ok(r.findings.some((f) => f.finding_id === fid));
      const tests = r.recommended_next_tests.flatMap((t) => t.finding_ids).sort();
      assert.deepEqual(tests, r.findings.map((f) => f.finding_id).sort(), "every finding has its next test listed");
    }
  } finally {
    done();
  }
});

test("timeline truncation keeps every cited event", () => {
  const { store, svc, done } = setup();
  try {
    svc.run(["odd"]);
    const r = buildReport(store, svc, "odd", { maxTimelineEvents: 2 }) as ForensicReport;
    assert.equal(r.timeline.truncated, true);
    assert.ok(r.timeline.included_events < r.timeline.total_events);
    const rows = new Set(r.timeline.events.map((e) => e.event_id));
    for (const f of r.findings) for (const eid of f.event_ids) assert.ok(rows.has(eid), eid);
  } finally {
    done();
  }
});

test("comparative analysis: explicit baseline, previous session, or none", () => {
  const { store, svc, done } = setup();
  try {
    const auto = buildReport(store, svc, "odd") as ForensicReport;
    assert.equal(auto.comparative_analysis.basis, "previous_session");
    assert.equal(auto.comparative_analysis.baseline_session_id, "later");
    assert.equal(auto.comparative_analysis.comparison?.b, "later");
    const first = buildReport(store, svc, "base") as ForensicReport;
    assert.equal(first.comparative_analysis.basis, "most_recent_other", "no earlier session → most recent other");
    const explicit = buildReport(store, svc, "odd", { compare: "base" }) as ForensicReport;
    assert.equal(explicit.comparative_analysis.basis, "explicit");
    assert.ok(explicit.comparative_analysis.comparison?.environment_differences.some((d) => d.field === "language"));
    assert.throws(() => buildReport(store, svc, "odd", { compare: "nope" }), /compare_not_found/);
    assert.throws(() => buildReport(store, svc, "odd", { compare: "odd" }), /compare_is_same_session/);

    const lone = new Store(":memory:");
    persist(lone, mockFlow("solo"));
    const solo = buildReport(lone, new AnalysisService({ store: lone }), "solo") as ForensicReport;
    assert.equal(solo.comparative_analysis.basis, "none");
    assert.equal(solo.comparative_analysis.comparison, null);
    assert.match(solo.comparative_analysis.notes[0] ?? "", /No other recorded session/);
    lone.close();
  } finally {
    done();
  }
});

test("generated report text never presents findings as proof of platform enforcement", () => {
  const { store, svc, done } = setup();
  try {
    svc.run();
    for (const id of ["odd", "base", "later"]) {
      const r = buildReport(store, svc, id) as ForensicReport;
      const { disclaimer: _d, ...rest } = r;
      const texts = allStrings(rest).filter((t) => t !== PLATFORM_CAVEAT);
      for (const t of texts) assert.deepEqual(findConclusiveClaims(t), [], t);
    }
  } finally {
    done();
  }
});

test("HTML: all sections in order, event-id links resolve to anchors, hostile strings are escaped, CSP pins the stylesheet", () => {
  const { store, svc, done } = setup();
  try {
    svc.run(["odd"]);
    const r = buildReport(store, svc, "odd") as ForensicReport;
    const html = reportHtml(r);
    let last = -1;
    REPORT_SECTIONS.forEach(([key, title], i) => {
      const at = html.indexOf(`<section id="sec-${key}"><h2>${i + 1}. ${title}</h2>`);
      assert.ok(at > last, `${title} present and in order`);
      last = at;
    });
    // Every finding: card anchor + a link to each exact event id, and each target anchor exists.
    for (const f of r.findings) {
      assert.ok(html.includes(`id="${anchor("f", f.finding_id)}"`), f.finding_id);
      for (const eid of f.event_ids) {
        assert.ok(html.includes(`href="#${anchor("ev", eid)}"`), `link to ${eid}`);
        assert.ok(html.includes(`<tr id="${anchor("ev", eid)}">`), `anchor for ${eid}`);
      }
    }
    // Recorded data is text, never markup; the document has no scripts at all.
    assert.ok(!/<script/i.test(html), "no <script> element");
    assert.ok(!/<img/i.test(html), "no injected <img>");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;") || !html.includes("onerror=alert(2)>"));
    // CSP: meta tag pins exactly the inline stylesheet by hash.
    const hash = `sha256-${createHash("sha256").update(REPORT_CSS).digest("base64")}`;
    assert.equal(REPORT_STYLE_HASH, hash);
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;${hash}&#39;`));
    assert.ok(html.includes(`<style>${REPORT_CSS}</style>`));
    assert.ok(html.includes(r.integrity.digest));
    assert.ok(html.includes("Diagnostic observations only."));
    assert.ok(!html.includes('class="print"'));
    const print = reportHtml(r, { print: true });
    assert.ok(print.includes('<body class="print">'));
    assert.match(REPORT_CSS, /@page\{size:A4/);
    assert.match(REPORT_CSS, /body\.print h2\{break-before:page/);
  } finally {
    done();
  }
});

test("CSV: RFC 4180 quoting, BOM, formula-injection guard, one evidence row per item", () => {
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(FORMULA), `"'=HYPERLINK(""http://example.invalid"",""x"")"`);
  for (const bad of ["+1", "-1+2", "@SUM(A1)", "\tx", "\rx"]) assert.ok(csvCell(bad).startsWith(`"'`), JSON.stringify(bad));
  assert.equal(csvCell(-3), "-3", "numbers are not prefixed");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(true), "true");

  const { store, svc, done } = setup();
  try {
    svc.run(["odd"]);
    const r = buildReport(store, svc, "odd") as ForensicReport;
    const findings = renderReport(r, "csv", "findings").body;
    assert.ok(findings.startsWith("﻿\"finding_id\",\"session_id\",\"rule_id\""));
    const lines = findings.trimEnd().split("\r\n");
    assert.equal(lines.length, r.findings.length + 1);
    for (const f of r.findings) assert.ok(findings.includes(`"${f.event_ids.join(" ")}"`), `${f.finding_id} event ids column`);
    const events = renderReport(r, "csv", "events").body;
    assert.ok(events.includes("HYPERLINK"), "recorded selector text is exported");
    assert.ok(!/(^|,)"[=+\-@]/m.test(events), "no cell starts with a formula character");
    // Operator-authored rule text reaches cells verbatim: a title starting with "=" is neutralised.
    const custom = { version: 1 as const, rules: svc.rules.rules.filter((x) => x.id === "CNT-ERROR-EVENTS").map((x) => ({ ...x, title: "=1+1 error events ({{count}})" })) };
    assert.ok(svc.setRules(custom).ok);
    svc.run(["odd"]);
    const guarded = renderReport(buildReport(store, svc, "odd") as ForensicReport, "csv", "findings").body;
    assert.ok(guarded.includes(`"'=1+1 error events (1)"`), guarded.slice(0, 400));
    const evidence = renderReport(r, "csv", "evidence").body.trimEnd().split("\r\n");
    assert.equal(evidence.length - 1, r.evidence.reduce((a, e) => a + e.items.length, 0));
  } finally {
    done();
  }
});

test("API: every format with correct types and headers; validation, auth and origin rules apply", async () => {
  const h = await startServiceHarness();
  seed(h.store);
  try {
    const base = `${h.base}/v1/reports/sessions/odd`;
    const json = await fetch(`${base}?format=json`, { headers: authHeaders() });
    assert.equal(json.status, 200);
    assert.match(String(json.headers.get("content-type")), /^application\/json/);
    const body = (await json.json()) as ForensicReport;
    assert.equal(body.session.session_id, "odd");
    assert.equal(json.headers.get("x-report-digest"), `sha256:${body.integrity.digest}`);
    assert.match(String(json.headers.get("content-disposition")), /^inline; filename="lab-report_odd_\d{8}\.json"$/);

    const html = await fetch(`${base}?format=html&download=1`, { headers: authHeaders() });
    assert.equal(html.status, 200);
    assert.match(String(html.headers.get("content-type")), /^text\/html/);
    assert.match(String(html.headers.get("content-security-policy")), /default-src 'none'; style-src 'sha256-[^']+'.*frame-ancestors 'none'/);
    assert.equal(html.headers.get("x-frame-options"), "DENY");
    assert.match(String(html.headers.get("content-disposition")), /^attachment; filename="lab-report_odd_\d{8}\.html"$/);
    assert.ok(!/<script/i.test(await html.text()));

    const print = await fetch(`${base}?format=print`, { headers: authHeaders() });
    assert.ok((await print.text()).includes('<body class="print">'));
    const csv = await fetch(`${base}?format=csv&table=evidence&download=1`, { headers: authHeaders() });
    assert.match(String(csv.headers.get("content-type")), /^text\/csv/);
    assert.match(String(csv.headers.get("content-disposition")), /lab-report_odd_evidence_\d{8}\.csv/);
    const cmp = (await (await fetch(`${base}?compare=base`, { headers: authHeaders() })).json()) as ForensicReport;
    assert.equal(cmp.comparative_analysis.baseline_session_id, "base");

    assert.equal((await fetch(`${h.base}/v1/reports/sessions/nope`, { headers: authHeaders() })).status, 404);
    assert.equal((await fetch(`${base}?compare=nope`, { headers: authHeaders() })).status, 404);
    assert.equal((await fetch(`${base}?compare=odd`, { headers: authHeaders() })).status, 400);
    for (const bad of ["format=pdf", "table=secrets", "compare=a%20b"]) {
      assert.equal((await fetch(`${base}?${bad}`, { headers: authHeaders() })).status, 400, bad);
    }
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: authHeaders({ origin: "http://127.0.0.1:4599" }) })).status, 403);
    assert.equal((await fetch(base, { headers: authHeaders({ origin: h.base }) })).status, 200, "dashboard origin");
  } finally {
    await h.close();
  }
});

test("CLI writes a report from the database file; bad arguments and unknown sessions fail clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-report-cli-"));
  const db = join(dir, "lab.sqlite");
  try {
    const store = new Store(db);
    seed(store);
    store.close();
    const out = join(dir, "r.html");
    const err: string[] = [];
    const io = { stdout: (_s: string) => {}, stderr: (s: string) => void err.push(s) };
    assert.equal(runReportCli(["odd", "--db", db, "--format", "html", "--out", out], io), 0);
    const html = readFileSync(out, "utf8");
    assert.ok(html.startsWith("<!doctype html>"));
    assert.match(err.join(""), /report written: .*sha256 [0-9a-f]{64}/);
    let printed = "";
    assert.equal(runReportCli(["odd", "--db", db, "--format", "csv", "--table", "events"], { stdout: (s) => void (printed += s), stderr: () => {} }), 0);
    assert.ok(printed.startsWith("﻿\"event_id\""));
    assert.equal(runReportCli(["missing", "--db", db], io), 1);
    assert.equal(runReportCli(["odd", "--db", db, "--format", "pdf"], io), 2);
    assert.equal(runReportCli(["--db", db], io), 2);
    assert.equal(runReportCli(["odd", "--db", db, "--compare", "nope"], io), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
