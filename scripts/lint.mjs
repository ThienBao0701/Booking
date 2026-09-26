// Architecture + safety lint (zero dependencies). Run: node --experimental-strip-types scripts/lint.mjs
//
// Enforces rules from docs/01-architecture.md and ADR-0002 that the type checker
// cannot see:
//   boundary/sibling      packages never import each other (only shared)
//   boundary/coupling     shared is imported only via each package's src/shared.ts
//   boundary/shared-pure  shared/src imports nothing outside itself and no node: builtins
//   boundary/browser      extension/src and dashboard/src must not import node: builtins
//   safety/dom-sink       dashboard/src renders recorded data as text: no HTML sinks or dynamic code
//   safety/forbidden-cap  forbidden capability identifiers only in the denylist module
//   safety/evasion-api    no navigator/screen property overrides, no proxy/debugger APIs
//   safety/manifest       extension manifest passes the least-privilege policy
//   hygiene/*             no `debugger;`, no focused tests (.only)
// Test harnesses (*/test, tests/) are exempt from boundary rules only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["shared", "extension", "windows-service", "mock-extranet", "dashboard"];
const FORBIDDEN_CAPS = [
  "ANTI_DETECTION",
  "STEALTH_EVASION",
  "FINGERPRINT_SPOOFING",
  "IP_ROTATION",
  "CAPTCHA_BYPASS",
  "BOT_DETECTION_BYPASS",
  "FAKE_USER_BEHAVIOR",
];
const CAP_ALLOWED_FILES = new Set(["shared/src/safety/capabilities.ts"]);
const EVASION_PATTERNS = [
  [/Object\.defineProperty\(\s*(?:window\.)?(?:navigator|screen)\b/, "overriding navigator/screen properties (fingerprint spoofing)"],
  [/\bnavigator\.webdriver\s*=/, "assigning navigator.webdriver (bot-detection evasion)"],
  [/\bchrome\.(?:proxy|debugger)\b/, "chrome.proxy / chrome.debugger APIs (IP rotation / CDP manipulation)"],
];

// Recorded data is untrusted: the dashboard builds DOM with text nodes only (ADR-0006).
const DOM_SINKS = [
  [/\.(?:innerHTML|outerHTML)\s*=/, "innerHTML/outerHTML assignment"],
  [/\binsertAdjacentHTML\s*\(/, "insertAdjacentHTML"],
  [/\bdocument\.write(?:ln)?\s*\(/, "document.write"],
  [/\bcreateContextualFragment\s*\(/, "createContextualFragment"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\s*\(/, "new Function"],
  [/setAttribute\(\s*["'](?:style|on[a-z]+)["']/, "inline style / event-handler attribute (blocked by CSP)"],
];

const violations = [];
const report = (file, line, rule, msg) => violations.push(`${file}:${line}: ${rule}: ${msg}`);

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = [...PACKAGES, "tests", "scripts"]
  .map((d) => join(root, d))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(walk);

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*["']([^"']+)["']|(?:^|[\s;(])import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

for (const abs of files) {
  const rel = relative(root, abs).split(sep).join("/");
  const text = readFileSync(abs, "utf8");
  const [top, sub] = rel.split("/");
  const isTest = top === "tests" || top === "scripts" || sub === "test" || rel.endsWith("build.mjs");
  const pkg = PACKAGES.includes(top) ? top : undefined;

  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const line = lineOf(text, m.index ?? 0);
    if (spec.startsWith("node:")) {
      if (!isTest && top === "shared") report(rel, line, "boundary/shared-pure", `shared must be runtime-agnostic; imports ${spec}`);
      if (!isTest && (top === "extension" || top === "dashboard")) report(rel, line, "boundary/browser", `${top} code runs in the browser; imports ${spec}`);
      continue;
    }
    if (!spec.startsWith(".")) continue;
    const target = relative(root, resolve(dirname(abs), spec)).split(sep).join("/");
    const targetTop = target.split("/")[0];
    if (isTest || !pkg) continue;
    if (pkg === "shared") {
      if (!target.startsWith("shared/src/")) report(rel, line, "boundary/shared-pure", `shared imports outside itself: ${spec}`);
      continue;
    }
    if (targetTop === pkg) continue;
    if (targetTop === "shared") {
      if (rel !== `${pkg}/src/shared.ts`) {
        report(rel, line, "boundary/coupling", `import shared via ${pkg}/src/shared.ts, not ${spec}`);
      }
      continue;
    }
    report(rel, line, "boundary/sibling", `${pkg} must not import ${targetTop} (${spec}); communicate over the service API`);
  }

  if (!isTest) {
    for (const cap of FORBIDDEN_CAPS) {
      const i = text.indexOf(cap);
      if (i >= 0 && !CAP_ALLOWED_FILES.has(rel)) {
        report(rel, lineOf(text, i), "safety/forbidden-cap", `${cap} may only appear in the denylist (shared/src/safety/capabilities.ts)`);
      }
    }
    for (const [re, why] of EVASION_PATTERNS) {
      const mm = re.exec(text);
      if (mm) report(rel, lineOf(text, mm.index), "safety/evasion-api", why);
    }
    if (top === "dashboard") {
      for (const [re, why] of DOM_SINKS) {
        const mm = re.exec(text);
        if (mm) report(rel, lineOf(text, mm.index), "safety/dom-sink", why);
      }
    }
  }
  const dbg = /^\s*debugger\s*;?\s*$/m.exec(text);
  if (dbg) report(rel, lineOf(text, dbg.index), "hygiene/debugger", "remove debugger statement");
  const only = /\b(?:test|it|describe)\.only\s*\(/.exec(text);
  if (only) report(rel, lineOf(text, only.index), "hygiene/focused-test", "remove .only");
}

// Manifest least-privilege policy (same function the build and unit tests use).
const { checkManifestPolicy } = await import("../extension/src/common/manifest-policy.ts");
const manifest = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));
for (const v of checkManifestPolicy(manifest)) report("extension/manifest.json", 1, "safety/manifest", v);

if (violations.length > 0) {
  console.error(violations.join("\n"));
  console.error(`\n✖ lint: ${violations.length} violation(s) in ${files.length} files`);
  process.exit(1);
}
console.log(`✔ lint: ${files.length} files, 0 violations (boundaries, safety, hygiene, manifest policy)`);
