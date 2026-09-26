import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONFIG,
  isRecordableUrl,
  normalizeOrigin,
  originToMatchPattern,
  validateConfig,
} from "../src/common/config.ts";
import { checkManifestPolicy } from "../src/common/manifest-policy.ts";
import { isContentMessage, isUiMessage } from "../src/common/messages.ts";

const manifestPath = fileURLToPath(new URL("../manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

// ---- config ----

test("default config is valid", () => {
  assert.ok(validateConfig(DEFAULT_CONFIG).ok);
});

test("service URL must be loopback — events never leave the machine", () => {
  for (const bad of ["https://collector.example.com", "http://127.0.0.1@evil.example", "http://10.0.0.5:4577"]) {
    const r = validateConfig({ serviceUrl: bad });
    assert.ok(!r.ok, bad);
  }
  assert.ok(validateConfig({ serviceUrl: "http://localhost:4577" }).ok);
});

test("target origins must be exact origins (no wildcards, paths, userinfo)", () => {
  assert.equal(normalizeOrigin("https://Extranet.Example:8443/"), "https://extranet.example:8443");
  for (const bad of ["https://*.example.com", "https://a.example/path", "https://u@a.example", "ftp://a", "<all_urls>"]) {
    assert.equal(normalizeOrigin(bad), undefined, bad);
  }
  const r = validateConfig({ targetOrigins: ["https://A.example", "https://a.example/"] });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.targetOrigins, ["https://a.example"], "normalized + deduplicated");
  assert.ok(!validateConfig({ targetOrigins: ["https://*/*"] }).ok);
});

test("numeric bounds are enforced", () => {
  assert.ok(!validateConfig({ batchSize: 0 }).ok);
  assert.ok(!validateConfig({ batchSize: 501 }).ok, "service accepts at most 500 per batch");
  assert.ok(!validateConfig({ flushIntervalMs: 10 }).ok);
});

test("recordable URLs: loopback or a granted origin only", () => {
  assert.ok(isRecordableUrl("http://127.0.0.1:4599/", []));
  assert.ok(isRecordableUrl("https://staging.example/x", ["https://staging.example"]));
  assert.ok(!isRecordableUrl("https://bank.example/", ["https://staging.example"]));
  assert.ok(!isRecordableUrl(undefined, []));
  assert.equal(originToMatchPattern("https://staging.example:8443"), "https://staging.example/*");
});

// ---- messages ----

test("content messages are shape-checked", () => {
  assert.ok(isContentMessage({ type: "lab/capture", payload: { action: "click", page: "/", metadata: {} } }));
  assert.ok(!isContentMessage({ type: "lab/capture", payload: { action: "session_start", page: "/", metadata: {} } }));
  assert.ok(!isContentMessage({ type: "lab/capture", payload: { action: "click", page: 1, metadata: {} } }));
  assert.ok(!isContentMessage({ type: "other" }));
  assert.ok(isUiMessage({ type: "lab/ui/start" }));
  assert.ok(!isUiMessage({ type: "lab/ui/rm-rf" }));
});

// ---- manifest least privilege ----

test("shipped manifest satisfies the least-privilege policy", () => {
  assert.deepEqual(checkManifestPolicy(manifest), []);
});

test("manifest has no <all_urls> and only loopback required hosts", () => {
  assert.ok(!JSON.stringify(manifest).includes("<all_urls>"));
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
});

test("policy rejects privilege widening", () => {
  const widen = (patch: Record<string, unknown>) => checkManifestPolicy({ ...manifest, ...patch });
  assert.ok(widen({ permissions: ["storage", "proxy"] }).some((v) => v.includes("proxy")));
  assert.ok(widen({ permissions: ["storage", "debugger"] }).some((v) => v.includes("debugger")));
  assert.ok(widen({ permissions: ["storage", "webRequestBlocking"] }).length > 0);
  assert.ok(widen({ permissions: ["storage", "cookies"] }).length > 0);
  assert.ok(widen({ host_permissions: ["<all_urls>"] }).length > 0);
  assert.ok(widen({ host_permissions: ["https://*/*"] }).length > 0, "broad required host permission");
  assert.ok(widen({ externally_connectable: { matches: ["https://*/*"] } }).length > 0);
  assert.ok(widen({ content_scripts: [{ matches: ["https://*/*"], js: ["x.js"] }] }).length > 0);
  assert.ok(widen({ content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" } }).length > 0);
});
