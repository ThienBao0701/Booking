// Dashboard build + artifact verification.
// Run: node --experimental-strip-types build.mjs   (or: pnpm -C dashboard build)
//
// 1. esbuild bundles src/main.ts → dist/app.js (one classic script, no eval)
// 2. static assets copied (index.html, styles.css)
// 3. verification: index.html references only files that exist, no inline
//    scripts or styles (the service CSP is script-src/style-src 'self'), and no
//    HTML-injection sink or dynamic code in the bundle. Exits non-zero on failure.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { app: "src/main.ts" },
  bundle: true,
  format: "iife",
  target: ["chrome116", "firefox115", "safari16"],
  sourcemap: "linked",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  outdir: dist,
});
for (const f of ["index.html", "styles.css"]) cpSync(join(root, "src", f), join(dist, f));

// verification
const html = readFileSync(join(dist, "index.html"), "utf8");
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) fail("index.html: inline <script> is not allowed (CSP script-src 'self')");
if (/<style\b|\sstyle=/i.test(html)) fail("index.html: inline styles are not allowed (CSP style-src 'self')");
if (/\son[a-z]+=/i.test(html)) fail("index.html: inline event handlers are not allowed");
const referenced = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
for (const file of referenced) if (!existsSync(join(dist, file))) fail(`referenced file missing from dist: ${file}`);

const FORBIDDEN = [
  [/\.innerHTML\s*=/, "innerHTML assignment"],
  [/\.outerHTML\s*=/, "outerHTML assignment"],
  [/insertAdjacentHTML\s*\(/, "insertAdjacentHTML"],
  [/document\.write\s*\(/, "document.write"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\s*\(/, "new Function"],
  [/\bcreateContextualFragment\s*\(/, "createContextualFragment"],
];
const files = readdirSync(dist).map((n) => join(dist, n));
for (const f of files.filter((p) => p.endsWith(".js"))) {
  const code = readFileSync(f, "utf8");
  for (const [re, what] of FORBIDDEN) if (re.test(code)) fail(`${relative(dist, f)} contains ${what}`);
}

console.log(`✔ dashboard built → ${relative(process.cwd(), dist) || "dist"}`);
for (const f of files.filter((p) => !p.endsWith(".map")).sort()) {
  const buf = readFileSync(f);
  console.log(`  ${relative(dist, f).padEnd(20)} ${String(buf.length).padStart(8)} B  sha256:${createHash("sha256").update(buf).digest("hex").slice(0, 12)}`);
}
console.log(`✔ verified: ${referenced.length} referenced files, no inline script/style, no HTML sinks or dynamic code`);
