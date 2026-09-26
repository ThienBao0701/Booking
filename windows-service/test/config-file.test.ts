/**
 * Configuration management (Phase 15): strict validation, env precedence,
 * last-known-good recovery from a corrupted file (never widening anything),
 * atomic writes, and the service's behaviour with a corrupted config or a
 * port that is already taken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILE, LAST_GOOD_FILE, configFileToEnv, loadServiceConfigFile, mergeConfigEnv, parseSetting, validateServiceConfigFile, writeServiceConfigFile } from "../src/config-file.ts";
import { EXIT_PORT_IN_USE, PortInUseError, startService } from "../src/index.ts";

const EXT = `chrome-extension://${"a".repeat(32)}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lab-cfg-"));
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("validation: known keys, loopback host, ranges, extension origins only", () => {
  assert.equal(validateServiceConfigFile({ host: "127.0.0.1", port: 4600, safetyMode: "SIMULATE", allowedOrigins: [EXT], logLevel: "warn", logMaxBytes: 1048576, logMaxFiles: 3, healthIntervalMs: 5000, healthFailures: 2 }).ok, true);
  for (const bad of [
    [],
    "x",
    { host: "0.0.0.0" },
    { host: "192.168.1.10" },
    { port: 0 },
    { port: "4577" },
    { safetyMode: "GOD_MODE" },
    { allowedOrigins: ["https://evil.example"] },
    { logMaxFiles: 500 },
    { authToken: "x".repeat(20) },
    { unknown: 1 },
  ]) {
    assert.equal(validateServiceConfigFile(bad).ok, false, JSON.stringify(bad));
  }
});

test("a valid file is used and remembered as last-good; env still wins", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ port: 4600, safetyMode: "SIMULATE" }));
    const loaded = loadServiceConfigFile(dir);
    assert.equal(loaded.source, "file");
    assert.deepEqual(loaded.values, { port: 4600, safetyMode: "SIMULATE" });
    assert.ok(existsSync(join(dir, LAST_GOOD_FILE)));
    const env = mergeConfigEnv(configFileToEnv(loaded.values), { LAB_SERVICE_PORT: "4700" });
    assert.equal(env.LAB_SERVICE_PORT, "4700");
    assert.equal(env.LAB_SAFETY_MODE, "SIMULATE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupted file falls back to last-good, then to defaults — never to anything wider", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ port: 4600 }));
    loadServiceConfigFile(dir); // remembers last-good
    writeFileSync(join(dir, CONFIG_FILE), "{ \"port\": 46");
    const a = loadServiceConfigFile(dir);
    assert.equal(a.source, "last-good");
    assert.deepEqual(a.values, { port: 4600 });
    assert.match(a.problems.join(), /not valid JSON/);

    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ host: "0.0.0.0", safetyMode: "AUTHORIZED_AUTOMATION" }));
    rmSync(join(dir, LAST_GOOD_FILE));
    const b = loadServiceConfigFile(dir);
    assert.equal(b.source, "defaults");
    assert.deepEqual(b.values, {}, "an invalid file contributes nothing (defaults: loopback, OBSERVE)");
    assert.match(b.problems.join(), /host must be loopback/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes are validated and atomic; the previous file is kept as .bak", () => {
  const dir = tmp();
  try {
    writeServiceConfigFile(dir, { port: 4600 });
    writeServiceConfigFile(dir, { port: 4601 });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8")), { port: 4601 });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `${CONFIG_FILE}.bak`), "utf8")), { port: 4600 });
    assert.throws(() => writeServiceConfigFile(dir, { host: "example.com" }), /invalid configuration/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8")), { port: 4601 }, "a rejected write changes nothing");
    assert.equal(parseSetting("port", "4602"), 4602);
    assert.deepEqual(parseSetting("allowedOrigins", `${EXT}, ${EXT}`), [EXT, EXT]);
    assert.throws(() => parseSetting("nope", "1"), /unknown setting/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the service starts from a corrupted config with safe defaults and says so on /healthz", async () => {
  const dir = tmp();
  const port = await freePort();
  try {
    writeFileSync(join(dir, CONFIG_FILE), "not json at all");
    const svc = await startService({ LAB_DATA_DIR: dir, LAB_SERVICE_PORT: String(port), LAB_AUTH_TOKEN: "cfg-test-token-0123456789", LAB_LOG_LEVEL: "error" });
    try {
      const h = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { status: string; config: string; safetyMode: string };
      assert.deepEqual([h.status, h.config, h.safetyMode], ["ok", "recovered", "OBSERVE"]);
      const log = readFileSync(join(dir, "logs", "service.log"), "utf8");
      assert.match(log, /"msg":"config_invalid"/);
    } finally {
      await svc.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a port already in use is reported as such (typed error; exit code 3 for the supervisor)", async () => {
  const dir = tmp();
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const port = (blocker.address() as { port: number }).port;
  try {
    await assert.rejects(startService({ LAB_DATA_DIR: dir, LAB_SERVICE_PORT: String(port), LAB_AUTH_TOKEN: "cfg-test-token-0123456789", LAB_LOG_LEVEL: "error" }), PortInUseError);
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", entry], { env: { ...process.env, LAB_DATA_DIR: dir, LAB_SERVICE_PORT: String(port), LAB_LOG_LEVEL: "error" }, stdio: "ignore" });
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    assert.equal(code, EXIT_PORT_IN_USE);
    assert.match(readFileSync(join(dir, "logs", "service.log"), "utf8"), /"msg":"port_in_use"/);
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log rotation: size and file-count limits from the config file are applied", async () => {
  const dir = tmp();
  const port = await freePort();
  try {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ logMaxBytes: 64 * 1024, logMaxFiles: 2, logLevel: "info" }));
    const svc = await startService({ LAB_DATA_DIR: dir, LAB_SERVICE_PORT: String(port), LAB_AUTH_TOKEN: "cfg-test-token-0123456789" });
    try {
      // Every request is logged (~150 B): 3000 requests roll the 64 KiB log several times.
      for (let i = 0; i < 3000; i++) await fetch(`http://127.0.0.1:${port}/healthz`);
    } finally {
      await svc.close();
    }
    const { readdirSync, statSync } = await import("node:fs");
    const files = readdirSync(join(dir, "logs")).filter((f) => f.startsWith("service.log")).sort();
    assert.deepEqual(files, ["service.log", "service.log.1", "service.log.2"], "current + 2 rolled files, older ones dropped");
    for (const f of files) assert.ok(statSync(join(dir, "logs", f)).size <= 64 * 1024 + 4096, `${f} bounded`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
