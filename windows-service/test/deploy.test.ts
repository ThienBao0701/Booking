/**
 * Windows deployment (Phase 15): Task Scheduler definition, command-line
 * quoting, and every installer flow on a real temp directory with a
 * simulated `schtasks` and health endpoint — clean install, upgrade (data and
 * config kept, previous release kept for rollback, old ones pruned), failed
 * upgrade → automatic rollback, native host re-pointed, uninstall (data kept /
 * purged), status, and the CLI's guards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TASK_NAME, encodeTaskXml, parseTaskAction, taskXml, winQuote, winSplit } from "../src/deploy/task.ts";
import { type DeployContext, type DeployEffects, install, layout, readCurrent, realDeployEffects, status, uninstall, upgrade } from "../src/deploy/installer.ts";
import { runDeployCli } from "../src/deploy/cli.ts";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

test("task definition: logon trigger, least privilege, restart on failure, no time limit, hidden, one instance", () => {
  const xml = taskXml({ userId: "LAB\\op", command: "C:\\Lab & Co\\runtime\\node.exe", arguments: '"C:\\Lab & Co\\app\\watchdog.ts" --data-dir "C:\\Lab\\data"', workingDirectory: "C:\\Lab\\app" });
  for (const needle of [
    "<LogonTrigger>",
    "<UserId>LAB\\op</UserId>",
    "<LogonType>InteractiveToken</LogonType>",
    "<RunLevel>LeastPrivilege</RunLevel>",
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "<Hidden>true</Hidden>",
    "<StartWhenAvailable>true</StartWhenAvailable>",
    "<RestartOnFailure>",
    "<Command>C:\\Lab &amp; Co\\runtime\\node.exe</Command>",
    `<URI>\\${TASK_NAME}</URI>`,
  ]) {
    assert.ok(xml.includes(needle), needle);
  }
  assert.ok(!xml.includes("HighestAvailable"), "never elevated");
  assert.deepEqual(parseTaskAction(xml), { command: "C:\\Lab & Co\\runtime\\node.exe", arguments: '"C:\\Lab & Co\\app\\watchdog.ts" --data-dir "C:\\Lab\\data"', workingDirectory: "C:\\Lab\\app" });
  const bytes = encodeTaskXml(xml);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "UTF-16LE BOM for schtasks");
  assert.equal(bytes.subarray(2).toString("utf16le"), xml);
  assert.throws(() => taskXml({ userId: "op", command: "a\nb", arguments: "", workingDirectory: "C:\\" }));
});

test("command-line quoting round-trips (spaces, quotes, trailing backslashes)", () => {
  for (const a of ["plain", "C:\\Program Files\\Lab\\node.exe", 'say "hi"', "C:\\dir with space\\", "", "a\\\\b", 'x\\"y']) {
    assert.deepEqual(winSplit(winQuote(a)), [a], JSON.stringify(a));
  }
  const args = ["--data-dir", "C:\\Users\\A B\\data\\", "--x"];
  assert.deepEqual(winSplit(args.map(winQuote).join(" ")), args);
});

// ---- installer flows against a simulated Task Scheduler ----

interface Sim {
  fx: DeployEffects;
  tasks: Map<string, string>;
  calls: string[][];
  runs: number;
  /** Health answers: a function of the task's current working directory. */
  healthy: (appDir: string | undefined) => boolean;
}

function simulate(): Sim {
  const sim: Sim = {
    tasks: new Map(),
    calls: [],
    runs: 0,
    healthy: () => true,
    fx: undefined as unknown as DeployEffects,
  };
  let running = false;
  sim.fx = {
    ...realDeployEffects,
    exec(cmd, args) {
      sim.calls.push([cmd, ...args]);
      if (cmd === "reg") return { status: 0, stdout: "" };
      assert.equal(cmd, "schtasks");
      const op = args[0];
      if (op === "/Create") {
        const file = args[args.indexOf("/XML") + 1] as string;
        const raw = readFileSync(file);
        assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe]);
        sim.tasks.set(args[args.indexOf("/TN") + 1] as string, raw.subarray(2).toString("utf16le"));
        return { status: 0, stdout: "SUCCESS" };
      }
      const name = args[args.indexOf("/TN") + 1] as string;
      if (op === "/Query") return sim.tasks.has(name) ? { status: 0, stdout: sim.tasks.get(name) as string } : { status: 1, stdout: "" };
      if (op === "/Run") {
        if (!sim.tasks.has(name)) return { status: 1, stdout: "" };
        running = true;
        sim.runs += 1;
        return { status: 0, stdout: "" };
      }
      if (op === "/End") {
        running = false;
        return { status: 0, stdout: "" };
      }
      if (op === "/Delete") return sim.tasks.delete(name) ? { status: 0, stdout: "" } : { status: 1, stdout: "" };
      return { status: 1, stdout: "" };
    },
    health: async () => running && sim.healthy(parseTaskAction(sim.tasks.get(TASK_NAME) ?? "")?.workingDirectory),
    sleep: async () => undefined,
    isAlive: () => false,
    kill: () => undefined,
  };
  let t = 1_790_000_000_000;
  sim.fx.now = () => (t += 1000);
  return sim;
}

/** A minimal checkout with everything an app directory needs. */
function makeSource(root: string, version: string): string {
  const src = join(root, `src-${version}`);
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ version }),
    "shared/package.json": "{}",
    "shared/src/index.ts": "export {};",
    "windows-service/package.json": "{}",
    "windows-service/src/watchdog.ts": "// supervisor",
    "windows-service/src/native/main.ts": "// host",
    "windows-service/test/big.test.ts": "// must not be copied",
    "mock-extranet/package.json": "{}",
    "mock-extranet/src/index.ts": "",
    "examples/workflows/a.json": "{}",
    "dashboard/dist/index.html": "<!doctype html>",
    "extension/dist/manifest.json": "{}",
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(src, p, ".."), { recursive: true });
    writeFileSync(join(src, p), c);
  }
  return src;
}

function context(root: string, sim: Sim): DeployContext {
  return { root: join(root, "AutomationLab"), platform: "win32", userId: "LAB\\op", fx: sim.fx, healthTimeoutMs: 5000 };
}

test("clean install → upgrade (data + config kept, rollback copy kept) → second upgrade prunes → uninstall keeps data", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-deploy-"));
  try {
    const sim = simulate();
    const ctx = context(tmp, sim);
    const L = layout(ctx.root);
    const fakeNode = join(tmp, "node.exe");
    writeFileSync(fakeNode, "binary");

    const r1 = await install(ctx, { sourceDir: makeSource(tmp, "1.0.0"), nodePath: fakeNode, nodeVersion: "v22.9.0", config: { port: 4611 }, extensionIds: [EXT_ID] });
    assert.equal(r1.ok, true, r1.message);
    const c1 = readCurrent(ctx);
    assert.equal(c1?.version, "1.0.0");
    assert.ok(existsSync(join(c1?.appDir as string, "windows-service", "src", "watchdog.ts")));
    assert.equal(existsSync(join(c1?.appDir as string, "windows-service", "test")), false, "tests are not deployed");
    assert.equal(readFileSync(c1?.node as string, "utf8"), "binary", "runtime bundled");
    assert.deepEqual(JSON.parse(readFileSync(join(L.dataDir, "config.json"), "utf8")), { port: 4611 });
    const action = parseTaskAction(sim.tasks.get(TASK_NAME) as string);
    assert.equal(action?.command, c1?.node);
    assert.deepEqual(winSplit(action?.arguments ?? "").slice(-3), [join(c1?.appDir as string, "windows-service", "src", "watchdog.ts"), "--data-dir", L.dataDir]);
    const native = JSON.parse(readFileSync(join(L.nativeDir, "com.automation_lab.bridge.json"), "utf8"));
    assert.deepEqual(native.allowed_origins, [`chrome-extension://${EXT_ID}/`]);
    assert.ok(readFileSync(join(L.nativeDir, "lab-native-host.cmd"), "utf8").includes(join(c1?.appDir as string, "windows-service", "src", "native", "main.ts")));
    assert.ok(sim.calls.some((c) => c[0] === "reg" && c[1] === "add"), "native host registered for the browsers");
    assert.equal(readdirSync(process.cwd()).some((n) => n.includes("\\")), false, "nothing written outside the install root (path syntax follows the local file system)");

    // Operator data and a customized config survive upgrades.
    writeFileSync(join(L.dataDir, "lab.sqlite"), "precious");
    writeFileSync(join(L.dataDir, "auth-token.txt"), "token-unchanged-0123456789");
    const r2 = await upgrade(ctx, { sourceDir: makeSource(tmp, "1.1.0"), nodePath: fakeNode, nodeVersion: "v22.9.0" });
    assert.equal(r2.ok, true, r2.message);
    const c2 = readCurrent(ctx);
    assert.equal(c2?.version, "1.1.0");
    assert.equal(c2?.previous?.version, "1.0.0");
    assert.equal(readFileSync(join(L.dataDir, "lab.sqlite"), "utf8"), "precious");
    assert.equal(readFileSync(join(L.dataDir, "auth-token.txt"), "utf8"), "token-unchanged-0123456789");
    assert.deepEqual(JSON.parse(readFileSync(join(L.dataDir, "config.json"), "utf8")), { port: 4611 });
    assert.equal(parseTaskAction(sim.tasks.get(TASK_NAME) as string)?.workingDirectory, c2?.appDir);
    assert.ok(readFileSync(join(L.nativeDir, "lab-native-host.cmd"), "utf8").includes(c2?.appDir as string), "native host re-pointed at the new release");
    assert.ok(sim.calls.findIndex((c) => c[1] === "/End") < sim.calls.findLastIndex((c) => c[1] === "/Run"), "stopped before starting the new release");

    const r3 = await upgrade(ctx, { sourceDir: makeSource(tmp, "1.2.0"), nodePath: fakeNode, nodeVersion: "v22.10.0" });
    assert.equal(r3.ok, true);
    assert.equal(readdirSync(L.appsDir).length, 2, "only the current and previous releases are kept");
    assert.equal(readdirSync(L.runtimeDir).length, 2);

    const st = await status(ctx);
    assert.equal(st.installed, true);
    assert.equal(st.version, "1.2.0");
    assert.equal(st.previous, "1.1.0");
    assert.deepEqual(st.task, { registered: true, pointsAtCurrent: true });
    assert.equal(st.healthy, true);
    assert.equal(st.config.source, "file");

    const u = await uninstall(ctx);
    assert.equal(u.ok, true);
    assert.equal(sim.tasks.size, 0, "task removed");
    for (const p of [L.appsDir, L.runtimeDir, L.currentFile, L.taskFile, L.nativeDir]) assert.equal(existsSync(p), false, p);
    assert.equal(readFileSync(join(L.dataDir, "lab.sqlite"), "utf8"), "precious", "data kept by default");
    assert.ok(sim.calls.some((c) => c[0] === "reg" && c[1] === "delete") || sim.calls.some((c) => c[0] === "reg" && c[1] === "query"));

    await uninstall(ctx, { purgeData: true });
    assert.equal(existsSync(ctx.root), false, "purge removes everything");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a release that does not become healthy is rolled back automatically", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-deploy-"));
  try {
    const sim = simulate();
    const ctx = context(tmp, sim);
    const fakeNode = join(tmp, "node.exe");
    writeFileSync(fakeNode, "binary");
    await install(ctx, { sourceDir: makeSource(tmp, "1.0.0"), nodePath: fakeNode, nodeVersion: "v22.9.0" });
    const good = readCurrent(ctx);
    sim.healthy = (appDir) => appDir === good?.appDir; // the new release never answers
    const r = await upgrade(ctx, { sourceDir: makeSource(tmp, "2.0.0"), nodePath: fakeNode, nodeVersion: "v22.9.0" });
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, true);
    assert.equal(r.healthy, true, "the previous release is running again");
    assert.equal(readCurrent(ctx)?.version, "1.0.0");
    assert.equal(parseTaskAction(sim.tasks.get(TASK_NAME) as string)?.workingDirectory, good?.appDir);
    assert.deepEqual(readdirSync(layout(ctx.root).appsDir), [good?.appDir.split(/[\\/]/).pop()], "the failed release was removed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("install refuses an unbuilt or incomplete source, and a bad config", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-deploy-"));
  try {
    const sim = simulate();
    const ctx = context(tmp, sim);
    const src = makeSource(tmp, "1.0.0");
    rmSync(join(src, "dashboard", "dist"), { recursive: true });
    await assert.rejects(install(ctx, { sourceDir: src, nodePath: process.execPath, nodeVersion: "v22" }), /pnpm run build/);
    const src2 = makeSource(tmp, "1.0.1");
    await assert.rejects(install(ctx, { sourceDir: src2, nodePath: process.execPath, nodeVersion: "v22", config: { host: "0.0.0.0" } as never }), /host must be loopback/);
    assert.equal(sim.tasks.size, 0, "nothing registered");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: Windows-only commands refuse elsewhere; config show / set / validate", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-deploy-"));
  try {
    const out: string[] = [];
    assert.equal(await runDeployCli(["install"], { platform: "linux", env: {}, out: (s) => out.push(s) }), 2);
    assert.match(out.join(), /Windows-only/);
    const root = join(tmp, "root");
    assert.equal(await runDeployCli(["config", "set", "port=4620", "safetyMode=SIMULATE", "--root", root], { platform: "linux", out: () => undefined }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "data", "config.json"), "utf8")), { port: 4620, safetyMode: "SIMULATE" });
    assert.equal(await runDeployCli(["config", "set", "host=10.0.0.5", "--root", root], { platform: "linux", out: () => undefined }), 2, "non-loopback host refused");
    assert.equal(await runDeployCli(["config", "set", "port=http", "--root", root], { platform: "linux", out: () => undefined }), 2);
    assert.equal(await runDeployCli(["config", "validate", "--root", root], { platform: "linux", out: () => undefined }), 0);
    writeFileSync(join(root, "data", "config.json"), "{ corrupted");
    const v: string[] = [];
    assert.equal(await runDeployCli(["config", "validate", "--root", root], { platform: "linux", out: (s) => v.push(s) }), 1);
    assert.match(v.join(), /running from last-good/);
    assert.equal(await runDeployCli(["frobnicate"], { platform: "linux", out: () => undefined }), 2);
    assert.equal(await runDeployCli(["install", "--bogus"], { platform: "win32", out: () => undefined }), 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
