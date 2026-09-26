/**
 * Native host installer (Phase 14): Windows registry + .cmd launcher plans,
 * POSIX manifest locations, validation, install → status → upgrade →
 * uninstall on a real temp directory (registry through a fake `reg`), and the
 * CLI's dry run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NATIVE_HOST_NAME } from "../src/shared.ts";
import { type InstallEffects, InstallError, applyInstall, applyUninstall, launcherContent, nativeHostStatus, nodeEffects, planInstall, planUninstall } from "../src/native/install.ts";
import { runNativeCli } from "../src/native/cli.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const WIN = {
  platform: "win32" as const,
  installDir: "C:\\Users\\op\\AppData\\Local\\AutomationLab\\native-host",
  extensionIds: [ID],
  serviceUrl: "http://127.0.0.1:4577",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  hostEntry: "C:\\AutomationLab\\app\\windows-service\\src\\native\\main.ts",
  logDir: "C:\\Users\\op\\AppData\\Local\\AutomationLab\\data\\logs",
};

test("Windows plan: per-user registry keys for Chrome, Edge, Chromium and a quoted .cmd launcher", () => {
  const plan = planInstall(WIN);
  assert.equal(plan.manifestPath, `${WIN.installDir}\\${NATIVE_HOST_NAME}.json`);
  assert.deepEqual(
    plan.registry.map((r) => r.key),
    [
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    ],
  );
  assert.ok(plan.registry.every((r) => r.value === plan.manifestPath));
  assert.ok(plan.registry.every((r) => r.key.startsWith("HKCU\\")), "per user; never HKLM");
  assert.deepEqual(plan.manifest, {
    name: NATIVE_HOST_NAME,
    description: plan.manifest.description,
    path: `${WIN.installDir}\\lab-native-host.cmd`,
    type: "stdio",
    allowed_origins: [`chrome-extension://${ID}/`],
  });
  const launcher = plan.files.find((f) => f.path === plan.launcherPath)?.content ?? "";
  assert.match(launcher, /^@echo off\r\n/);
  assert.ok(launcher.includes(`"${WIN.nodePath}" --experimental-strip-types --no-warnings "${WIN.hostEntry}" --config "${WIN.installDir}\\native-host.json" %*`));
  const config = JSON.parse(plan.files.find((f) => f.path === plan.configPath)?.content ?? "{}");
  assert.deepEqual(config, { serviceUrl: "http://127.0.0.1:4577", allowedOrigins: [`chrome-extension://${ID}/`], timeoutMs: 10000, logDir: WIN.logDir });
  assert.deepEqual(planInstall({ ...WIN, browsers: ["edge"] }).registry.map((r) => r.key.split("\\")[2]), ["Microsoft"]);
});

test("install refuses unsafe input", () => {
  assert.throws(() => planInstall({ ...WIN, extensionIds: [] }), InstallError);
  assert.throws(() => planInstall({ ...WIN, extensionIds: ["not-an-id"] }), InstallError);
  assert.throws(() => planInstall({ ...WIN, extensionIds: ["ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"] }), InstallError);
  assert.throws(() => planInstall({ ...WIN, serviceUrl: "http://192.168.1.5:4577" }), InstallError);
  assert.throws(() => planInstall({ ...WIN, installDir: "relative\\dir" }), InstallError);
  assert.throws(() => launcherContent("win32", "C:\\a%PATH%\\node.exe", WIN.hostEntry, "C:\\c.json"), InstallError, "cmd expansion in a path");
  assert.throws(() => launcherContent("win32", 'C:\\a"b\\node.exe', WIN.hostEntry, "C:\\c.json"), InstallError);
});

test("POSIX plan: manifests in each browser's NativeMessagingHosts dir and custom profiles; quoted sh launcher", () => {
  const plan = planInstall({ platform: "linux", installDir: "/opt/lab/native-host", extensionIds: [ID], serviceUrl: "http://127.0.0.1:4577", nodePath: "/usr/bin/node", hostEntry: "/opt/lab/app/main.ts", logDir: "/opt/lab/logs", home: "/home/op", userDataDirs: ["/tmp/profile x"] });
  const paths = plan.files.map((f) => f.path);
  for (const p of [
    `/home/op/.config/google-chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    `/home/op/.config/microsoft-edge/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    `/home/op/.config/chromium/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
    `/tmp/profile x/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
  ]) {
    assert.ok(paths.includes(p), p);
  }
  assert.deepEqual(plan.registry, []);
  assert.equal(launcherContent("linux", "/usr/bin/node", "/it's/main.ts", "/c.json").split("\n")[2], `exec '/usr/bin/node' --experimental-strip-types --no-warnings '/it'\\''s/main.ts' --config '/c.json' "$@"`);
  const mac = planInstall({ platform: "darwin", installDir: "/opt/lab", extensionIds: [ID], serviceUrl: "http://127.0.0.1:4577", nodePath: "/usr/local/bin/node", hostEntry: "/opt/main.ts", logDir: "/opt/logs", home: "/Users/op", browsers: ["chrome"] });
  assert.ok(mac.files.some((f) => f.path === `/Users/op/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`));
});

/** Real files in a temp dir; `reg` simulated in memory. */
function fakeWindowsEffects(): InstallEffects & { reg: Map<string, string>; calls: string[][] } {
  const reg = new Map<string, string>();
  const calls: string[][] = [];
  return {
    ...nodeEffects,
    reg,
    calls,
    exec(cmd, args) {
      calls.push([cmd, ...args]);
      assert.equal(cmd, "reg");
      const [op, key] = args as [string, string];
      if (op === "add") {
        reg.set(key, args[args.indexOf("/d") + 1] as string);
        return { status: 0, stdout: "" };
      }
      if (op === "query") return reg.has(key) ? { status: 0, stdout: `${key}\n    (Default)    REG_SZ    ${reg.get(key)}\n` } : { status: 1, stdout: "" };
      if (op === "delete") return reg.delete(key) ? { status: 0, stdout: "" } : { status: 1, stdout: "" };
      return { status: 1, stdout: "" };
    },
  };
}

test("install → status → upgrade → uninstall (clean) → uninstall again (idempotent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-nhi-"));
  try {
    const fx = fakeWindowsEffects();
    const installDir = join(dir, "native-host");
    // Paths are POSIX here, but the plan is the Windows one (registry + .cmd).
    const opts = { ...WIN, installDir, nodePath: process.execPath, hostEntry: join(dir, "main.ts"), logDir: join(dir, "logs") };
    const plan = planInstall({ ...opts, platform: "linux", browsers: [] });
    const winPlan = { ...plan, registry: planInstall({ ...WIN }).registry.map((r) => ({ key: r.key, value: plan.manifestPath })) };
    const res = applyInstall(winPlan, fx);
    assert.equal(res.registry.length, 3);
    assert.equal(statSync(plan.configPath).mode & 0o777, 0o600, "host config is private");
    assert.equal(statSync(plan.launcherPath).mode & 0o777, 0o700);
    const target = { platform: "win32" as const, installDir };
    // status reads files with the platform's path API; use the POSIX layout for the file part.
    const st = nativeHostStatus({ platform: "linux", installDir }, fx);
    assert.equal(st.installed, true, st.problems.join("; "));
    assert.deepEqual(st.allowedOrigins, [`chrome-extension://${ID}/`]);

    // Upgrade: a second install with another id rewrites everything in place.
    const id2 = "ponmlkjihgfedcbaponmlkjihgfedcba";
    const plan2 = planInstall({ ...opts, extensionIds: [ID, id2], platform: "linux", browsers: [] });
    applyInstall({ ...plan2, registry: winPlan.registry }, fx);
    assert.deepEqual(JSON.parse(readFileSync(plan2.manifestPath, "utf8")).allowed_origins, [`chrome-extension://${ID}/`, `chrome-extension://${id2}/`]);

    // Corrupted config is reported.
    nodeEffects.writeFile(plan.configPath, "{ not json", 0o600);
    assert.ok(nativeHostStatus({ platform: "linux", installDir }, fx).problems.some((p) => p.includes("host config")));

    const un = applyUninstall({ ...planUninstall({ platform: "linux", installDir, browsers: [] }), registryKeys: planUninstall(target).registryKeys }, fx);
    assert.equal(un.registryDeleted.length, 3);
    assert.equal(fx.reg.size, 0, "registry keys removed");
    assert.equal(existsSync(installDir), false, "install dir removed when empty");
    const again = applyUninstall({ ...planUninstall({ platform: "linux", installDir, browsers: [] }), registryKeys: planUninstall(target).registryKeys }, fx);
    assert.equal(again.removed.length + again.registryDeleted.length, 0);
    assert.ok(again.absent.length >= 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: dry-run install lists the plan; usage errors exit 2", () => {
  const out: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "lab-nhc-"));
  try {
    const code = runNativeCli(["install", "--extension-id", ID, "--install-dir", join(dir, "nh"), "--user-data-dir", join(dir, "profile"), "--browser", "chromium", "--dry-run", "--json"], { LAB_DATA_DIR: dir }, (s) => out.push(s));
    assert.equal(code, 0);
    const plan = JSON.parse(out.join("\n"));
    assert.ok(plan.files.some((f: { path: string }) => f.path === join(dir, "profile", "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`)));
    assert.equal(existsSync(join(dir, "nh")), false, "dry run writes nothing");
    assert.equal(runNativeCli(["install"], {}, () => undefined), 2, "no extension id");
    assert.equal(runNativeCli(["frobnicate"], {}, () => undefined), 2);
    assert.equal(runNativeCli(["install", "--browser", "netscape"], {}, () => undefined), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
