// Extension build + artifact verification.
// Run: node --experimental-strip-types build.mjs   (or: pnpm -C extension build)
//
// 1. manifest least-privilege policy (same checks as the unit tests)
// 2. esbuild bundles → dist/ (service worker = ESM; content/popup/options = IIFE,
//    because content scripts cannot use ES module imports)
// 3. static assets copied
// 4. verification: every file referenced by the manifest / HTML exists, the
//    content script has no module syntax, and no forbidden API or dynamic code
//    evaluation appears in any bundle. Exits non-zero on any failure.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const { checkManifestPolicy } = await import("./src/common/manifest-policy.ts");

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// 1. policy
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const violations = checkManifestPolicy(manifest);
if (violations.length > 0) fail(`manifest policy violations:\n  - ${violations.join("\n  - ")}`);

// 2. bundles
rmSync(dist, { recursive: true, force: true });
const common = {
  absWorkingDir: root,
  bundle: true,
  target: ["chrome116"],
  sourcemap: "linked",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  outdir: dist,
};
await build({ ...common, format: "esm", entryPoints: { "background/service-worker": "src/background/service-worker.ts" } });
await build({
  ...common,
  format: "iife",
  entryPoints: {
    "content/content-script": "src/content/content-script.ts",
    "popup/popup": "src/popup/popup.ts",
    "options/options": "src/options/options.ts",
  },
});

// 3. static assets
const copies = [
  ["manifest.json", "manifest.json"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/options/options.html", "options/options.html"],
  ["src/ui/styles.css", "ui/styles.css"],
];
for (const [from, to] of copies) {
  mkdirSync(dirname(join(dist, to)), { recursive: true });
  cpSync(join(root, from), join(dist, to));
}

// 4. verification
const referenced = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  ...manifest.content_scripts.flatMap((c) => c.js),
]);
for (const html of [manifest.action.default_popup, manifest.options_page]) {
  const text = readFileSync(join(dist, html), "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) fail(`${html}: inline <script> is not allowed (CSP script-src 'self')`);
  for (const m of text.matchAll(/(?:src|href)="([^"#:]+)"/g)) referenced.add(join(dirname(html), m[1]));
}
for (const file of referenced) {
  if (!existsSync(join(dist, file))) fail(`referenced file missing from dist: ${file}`);
}

const FORBIDDEN_CODE = [
  /\bchrome\.(proxy|debugger|webRequest|cookies|privacy|declarativeNetRequest|management|history)\b/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
];
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(dist);
for (const f of files.filter((p) => p.endsWith(".js"))) {
  const code = readFileSync(f, "utf8");
  for (const re of FORBIDDEN_CODE) if (re.test(code)) fail(`${relative(dist, f)} contains forbidden code: ${re}`);
}
// Native messaging (ADR-0009): one connectNative call site (service worker), the lab host only.
const { NATIVE_HOST_NAME } = await import("../shared/src/native/protocol.ts");
for (const f of files.filter((p) => p.endsWith(".js"))) {
  const code = readFileSync(f, "utf8");
  const rel = relative(dist, f).split("\\").join("/");
  if (/\bsendNativeMessage\s*\(/.test(code)) fail(`${rel} uses sendNativeMessage (only the validated NativeChannel may talk to the host)`);
  const calls = (code.match(/\bconnectNative\s*\(/g) ?? []).length;
  if (calls > 0 && rel !== manifest.background.service_worker) fail(`${rel} calls connectNative; only the service worker may`);
  if (calls > 1) fail(`${rel} has ${calls} connectNative call sites (expected 1)`);
  if (calls === 1 && !code.includes(JSON.stringify(NATIVE_HOST_NAME))) fail(`${rel} connects natively but does not reference ${NATIVE_HOST_NAME}`);
}
for (const cs of manifest.content_scripts.flatMap((c) => c.js)) {
  const code = readFileSync(join(dist, cs), "utf8");
  if (/^\s*(import|export)\s/m.test(code)) fail(`${cs} must not contain ES module syntax (content scripts are classic scripts)`);
}

console.log(`✔ extension built → ${relative(process.cwd(), dist) || "dist"}`);
for (const f of files.filter((p) => !p.endsWith(".map")).sort()) {
  const buf = readFileSync(f);
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  console.log(`  ${relative(dist, f).padEnd(34)} ${String(buf.length).padStart(7)} B  sha256:${hash}`);
}
console.log(`✔ verified: policy, ${referenced.size} referenced files, no forbidden APIs, no module syntax in content scripts`);
