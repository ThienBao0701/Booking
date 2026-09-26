import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMainModule } from "../src/main-module.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, NODE_NO_WARNINGS: "1", MOCK_EXTRANET_PORT: "0" } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const t = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

test("isMainModule compares real paths", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(import.meta.url, self), true);
  assert.equal(isMainModule(import.meta.url, join(repo, "package.json")), false);
  assert.equal(isMainModule(import.meta.url, "/no/such/file.ts"), false);
  assert.equal(isMainModule(import.meta.url, ""), false, "no entry script");
});

test("regression: entry points start from a path with spaces reached via a symlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab path with spaces "));
  const link = join(dir, "my lab repo");
  symlinkSync(repo, link, "dir");
  try {
    // The naive check fails for this path class (it fails on Windows the same way).
    const probe = join(dir, "probe.mjs");
    writeFileSync(probe, "console.log(import.meta.url === `file://${process.argv[1]}`);\n");
    const naive = await run([probe]);
    assert.equal(naive.out.trim(), "false", "the old check would not recognize the entry point");
    assert.equal(isMainModule(pathToFileURL(probe).href, probe), true);

    // Real entry points, launched through the symlinked, space-containing path, now run.
    const cli = await run(["--experimental-strip-types", "--experimental-sqlite", join(link, "windows-service/src/automation/cli.ts")]);
    assert.equal(cli.code, 2, "CLI main ran and printed usage");
    assert.match(cli.out, /usage: lab-replay/);

    const mock = spawn(process.execPath, ["--experimental-strip-types", join(link, "mock-extranet/src/index.ts")], {
      env: { ...process.env, NODE_NO_WARNINGS: "1", MOCK_EXTRANET_PORT: "0" },
    });
    const started = await new Promise<string>((resolve) => {
      let out = "";
      const t = setTimeout(() => resolve(out), 10_000);
      mock.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes("listening")) {
          clearTimeout(t);
          resolve(out);
        }
      });
    });
    mock.kill("SIGTERM");
    assert.match(started, /mock-extranet listening on http:\/\/127\.0\.0\.1:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
