/**
 * Windows deployment (Phase 15, ADR-0010): install, upgrade (health-checked,
 * with automatic rollback), uninstall, status, start / stop / restart.
 *
 * Layout (default root %LOCALAPPDATA%\AutomationLab, per user):
 *
 *   app\<version>-<stamp>\    the service code (shared, windows-service, mock,
 *                             examples, built dashboard + extension)
 *   runtime\<node-version>\   a private copy of the Node.js runtime
 *   data\                     LAB_DATA_DIR: database, logs, token, config.json
 *   native-host\              the Phase 14 native messaging host (optional)
 *   current.json              active + previous version (for rollback)
 *   task.xml                  the registered Task Scheduler definition
 *
 * All effects go through `DeployEffects`, so every flow is exercised by tests
 * on any OS (Task Scheduler via a simulated `schtasks`).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, sep } from "node:path";

import { type ServiceConfigFile, loadServiceConfigFile, validateServiceConfigFile, writeServiceConfigFile } from "../config-file.ts";
import { type BrowserKind, type InstallEffects, applyInstall as applyNativeInstall, applyUninstall as applyNativeUninstall, nativeHostStatus, nodeEffects, planInstall as planNativeInstall, planUninstall as planNativeUninstall } from "../native/install.ts";
import { loadNativeHostConfig } from "../native/config.ts";
import { readSupervisorState, type SupervisorState } from "../watchdog.ts";
import { TASK_NAME, encodeTaskXml, parseTaskAction, taskXml, winQuote } from "./task.ts";

export class DeployError extends Error {}

/** Deployment always writes to this machine's file system. */
const LOCAL_PATH_STYLE: "win32" | "posix" = sep === "\\" ? "win32" : "posix";

/** What an app directory must contain (paths relative to the source checkout). */
export const APP_ENTRIES = [
  "package.json",
  "shared/package.json",
  "shared/src",
  "windows-service/package.json",
  "windows-service/src",
  "mock-extranet/package.json",
  "mock-extranet/src",
  "examples",
  "dashboard/dist",
  "extension/dist",
] as const;
const REQUIRED_BUILT = ["dashboard/dist/index.html", "extension/dist/manifest.json"];

export interface Layout {
  root: string;
  appsDir: string;
  runtimeDir: string;
  dataDir: string;
  nativeDir: string;
  currentFile: string;
  taskFile: string;
}

export function layout(root: string): Layout {
  return {
    root,
    appsDir: join(root, "app"),
    runtimeDir: join(root, "runtime"),
    dataDir: join(root, "data"),
    nativeDir: join(root, "native-host"),
    currentFile: join(root, "current.json"),
    taskFile: join(root, "task.xml"),
  };
}

export interface Release {
  version: string;
  appDir: string;
  node: string;
  installedAt: number;
}
export interface CurrentFile extends Release {
  previous?: Release;
}

export interface DeployEffects extends InstallEffects {
  exists(path: string): boolean;
  copyTree(src: string, dst: string): void;
  copyFile(src: string, dst: string): void;
  writeBytes(path: string, data: Buffer): void;
  removeTree(path: string): void;
  listDir(path: string): string[];
  health(url: string, timeoutMs: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  isAlive(pid: number): boolean;
  kill(pid: number): void;
  now(): number;
}

export const realDeployEffects: DeployEffects = {
  ...nodeEffects,
  exists: (p) => existsSync(p),
  copyTree: (src, dst) => {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, filter: (s) => !/[\\/](node_modules|test|\.git)([\\/]|$)/.test(s.slice(src.length)) });
  },
  copyFile: (src, dst) => {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  },
  writeBytes: (p, data) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  },
  removeTree: (p) => rmSync(p, { recursive: true, force: true }),
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  health: (url, timeoutMs) =>
    new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      const req = request(url, { timeout: timeoutMs, agent: false }, (res) => {
        res.resume();
        res.on("end", () => done(res.statusCode === 200));
        res.on("error", () => done(false));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => done(false));
      req.on("close", () => done(false));
      req.end();
    }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill: (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  },
  now: () => Date.now(),
};

export interface DeployContext {
  root: string;
  platform: NodeJS.Platform;
  /** DOMAIN\user for the logon trigger. */
  userId: string;
  fx: DeployEffects;
  /** Wait this long for /healthz after start (default 45 s). */
  healthTimeoutMs?: number;
  /** Wait this long for the supervisor to exit on stop (default 15 s). */
  stopTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface InstallInput {
  sourceDir: string;
  /** The Node.js binary to bundle (normally process.execPath). */
  nodePath: string;
  nodeVersion: string;
  /** Settings written to data\config.json (merged over an existing file). */
  config?: ServiceConfigFile;
  /** Install/refresh the native messaging host for these extension ids. */
  extensionIds?: string[];
  browsers?: BrowserKind[];
  /** Do not start the service after installing. */
  noStart?: boolean;
}

export interface DeployResult {
  ok: boolean;
  action: "install" | "upgrade" | "uninstall" | "start" | "stop" | "restart";
  version?: string;
  healthy?: boolean;
  rolledBack?: boolean;
  message: string;
}

function readJson<T>(fx: DeployEffects, path: string): T | undefined {
  const raw = fx.readFile(path);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function readCurrent(ctx: DeployContext): CurrentFile | undefined {
  return readJson<CurrentFile>(ctx.fx, layout(ctx.root).currentFile);
}

function nodeFile(ctx: DeployContext): string {
  return ctx.platform === "win32" ? "node.exe" : "node";
}

function serviceUrl(ctx: DeployContext): string {
  const cfg = loadServiceConfigFile(layout(ctx.root).dataDir).values;
  const host = cfg.host ?? "127.0.0.1";
  return `http://${host.includes(":") ? `[${host}]` : host}:${cfg.port ?? 4577}`;
}

export function taskFor(ctx: DeployContext, rel: Release): string {
  const L = layout(ctx.root);
  const watchdog = join(rel.appDir, "windows-service", "src", "watchdog.ts");
  const args = ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", watchdog, "--data-dir", L.dataDir].map(winQuote).join(" ");
  return taskXml({ userId: ctx.userId, command: rel.node, arguments: args, workingDirectory: rel.appDir });
}

function schtasks(ctx: DeployContext, args: string[]): { status: number; stdout: string } {
  return ctx.fx.exec("schtasks", args);
}

function register(ctx: DeployContext, rel: Release): void {
  const L = layout(ctx.root);
  ctx.fx.writeBytes(L.taskFile, encodeTaskXml(taskFor(ctx, rel)));
  const r = schtasks(ctx, ["/Create", "/TN", TASK_NAME, "/XML", L.taskFile, "/F"]);
  if (r.status !== 0) throw new DeployError(`schtasks /Create failed (exit ${r.status})`);
}

export function taskRegistered(ctx: DeployContext): { registered: boolean; action?: ReturnType<typeof parseTaskAction> } {
  const r = schtasks(ctx, ["/Query", "/TN", TASK_NAME, "/XML"]);
  if (r.status !== 0) return { registered: false };
  return { registered: true, action: parseTaskAction(r.stdout) };
}

async function waitHealthy(ctx: DeployContext): Promise<boolean> {
  const deadline = ctx.fx.now() + (ctx.healthTimeoutMs ?? 45_000);
  const url = `${serviceUrl(ctx)}/healthz`;
  while (ctx.fx.now() < deadline) {
    if (await ctx.fx.health(url, 2000)) return true;
    await ctx.fx.sleep(500);
  }
  return false;
}

/** Stop the task and make sure the supervisor (and so the service) is gone. */
export async function stopService(ctx: DeployContext): Promise<DeployResult> {
  const L = layout(ctx.root);
  schtasks(ctx, ["/End", "/TN", TASK_NAME]); // not running is fine
  const st = readSupervisorState(L.dataDir);
  if (st && st.state !== "stopped") {
    const deadline = ctx.fx.now() + (ctx.stopTimeoutMs ?? 15_000);
    while (ctx.fx.isAlive(st.pid) && ctx.fx.now() < deadline) await ctx.fx.sleep(200);
    if (ctx.fx.isAlive(st.pid)) ctx.fx.kill(st.pid);
    // The service exits when its supervisor disappears (IPC); make sure.
    if (st.childPid && ctx.fx.isAlive(st.childPid)) {
      const d2 = ctx.fx.now() + 5000;
      while (ctx.fx.isAlive(st.childPid) && ctx.fx.now() < d2) await ctx.fx.sleep(200);
      if (ctx.fx.isAlive(st.childPid)) ctx.fx.kill(st.childPid);
    }
  }
  return { ok: true, action: "stop", message: "stopped" };
}

export async function startService(ctx: DeployContext): Promise<DeployResult> {
  const r = schtasks(ctx, ["/Run", "/TN", TASK_NAME]);
  if (r.status !== 0) return { ok: false, action: "start", message: `schtasks /Run failed (exit ${r.status}); is the task registered?` };
  const healthy = await waitHealthy(ctx);
  return { ok: healthy, action: "start", healthy, message: healthy ? "running and healthy" : "started, but /healthz did not answer in time (see data\\logs\\supervisor.log)" };
}

export async function restartService(ctx: DeployContext): Promise<DeployResult> {
  await stopService(ctx);
  const r = await startService(ctx);
  return { ...r, action: "restart" };
}

function writeConfig(ctx: DeployContext, overrides: ServiceConfigFile | undefined): void {
  const L = layout(ctx.root);
  const existing = loadServiceConfigFile(L.dataDir);
  const merged = { ...existing.values, ...(overrides ?? {}) };
  const v = validateServiceConfigFile(merged);
  if (!v.ok) throw new DeployError(`invalid configuration: ${v.errors.join("; ")}`);
  // Only write when something changes (or nothing valid is there yet).
  if (existing.source !== "file" || JSON.stringify(existing.values) !== JSON.stringify(v.value)) writeServiceConfigFile(L.dataDir, v.value);
}

function stageRelease(ctx: DeployContext, input: InstallInput, version: string): Release {
  const L = layout(ctx.root);
  for (const f of REQUIRED_BUILT) if (!ctx.fx.exists(join(input.sourceDir, f))) throw new DeployError(`${f} is missing: run \`pnpm run build\` in ${input.sourceDir} first`);
  const appDir = join(L.appsDir, `${version}-${ctx.fx.now()}`);
  for (const e of APP_ENTRIES) {
    const src = join(input.sourceDir, e);
    if (!ctx.fx.exists(src)) throw new DeployError(`source is incomplete: ${e} not found in ${input.sourceDir}`);
    ctx.fx.copyTree(src, join(appDir, e));
  }
  const node = join(L.runtimeDir, input.nodeVersion.replace(/[^0-9A-Za-z.-]/g, ""), nodeFile(ctx));
  if (!ctx.fx.exists(node)) ctx.fx.copyFile(input.nodePath, node);
  return { version, appDir, node, installedAt: ctx.fx.now() };
}

function sourceVersion(ctx: DeployContext, sourceDir: string): string {
  const pkg = readJson<{ version?: string }>(ctx.fx, join(sourceDir, "package.json"));
  if (!pkg?.version || !/^[0-9A-Za-z.+-]{1,40}$/.test(pkg.version)) throw new DeployError(`cannot read the version from ${join(sourceDir, "package.json")}`);
  return pkg.version;
}

function nativeIds(ctx: DeployContext): string[] {
  const cfg = loadNativeHostConfig(join(layout(ctx.root).nativeDir, "native-host.json"));
  return cfg.ok ? cfg.value.allowedOrigins.map((o) => o.replace(/^chrome-extension:\/\//, "").replace(/\/$/, "")) : [];
}

function installNative(ctx: DeployContext, rel: Release, ids: string[], browsers: BrowserKind[] | undefined): void {
  if (ids.length === 0) return;
  const L = layout(ctx.root);
  const plan = planNativeInstall({
    platform: ctx.platform,
    pathStyle: LOCAL_PATH_STYLE,
    installDir: L.nativeDir,
    ...(browsers ? { browsers } : {}),
    extensionIds: ids,
    serviceUrl: serviceUrl(ctx),
    nodePath: rel.node,
    hostEntry: join(rel.appDir, "windows-service", "src", "native", "main.ts"),
    logDir: join(L.dataDir, "logs"),
  });
  applyNativeInstall(plan, ctx.fx);
}

function prune(ctx: DeployContext, keep: CurrentFile): void {
  const L = layout(ctx.root);
  const keepApps = new Set([keep.appDir, keep.previous?.appDir].filter(Boolean));
  for (const name of ctx.fx.listDir(L.appsDir)) {
    const p = join(L.appsDir, name);
    if (!keepApps.has(p)) ctx.fx.removeTree(p);
  }
  const keepRuntimes = new Set([keep.node, keep.previous?.node].filter(Boolean).map((n) => dirname(n as string)));
  for (const name of ctx.fx.listDir(L.runtimeDir)) {
    const p = join(L.runtimeDir, name);
    if (!keepRuntimes.has(p)) ctx.fx.removeTree(p);
  }
}

/** Fresh install, or an upgrade when a release is already installed. */
export async function install(ctx: DeployContext, input: InstallInput): Promise<DeployResult> {
  const L = layout(ctx.root);
  const version = sourceVersion(ctx, input.sourceDir);
  const current = readCurrent(ctx);
  if (current) return await upgrade(ctx, input);

  ctx.log?.(`installing ${version} into ${ctx.root}`);
  ctx.fx.writeFile(join(L.dataDir, ".keep"), "", 0o600);
  writeConfig(ctx, input.config);
  const rel = stageRelease(ctx, input, version);
  register(ctx, rel);
  const cur: CurrentFile = { ...rel };
  ctx.fx.writeFile(L.currentFile, `${JSON.stringify(cur, null, 2)}\n`, 0o644);
  installNative(ctx, rel, input.extensionIds ?? [], input.browsers);
  if (input.noStart) return { ok: true, action: "install", version, message: `installed ${version} (not started)` };
  const started = await startService(ctx);
  return { ok: started.ok, action: "install", version, healthy: started.healthy ?? false, message: started.ok ? `installed ${version}; service healthy` : `installed ${version}; ${started.message}` };
}

/** Upgrade in place; rolls back to the previous release if the new one is not healthy. */
export async function upgrade(ctx: DeployContext, input: InstallInput): Promise<DeployResult> {
  const L = layout(ctx.root);
  const old = readCurrent(ctx);
  if (!old) return await install(ctx, input);
  const version = sourceVersion(ctx, input.sourceDir);
  ctx.log?.(`upgrading ${old.version} → ${version}`);
  const oldNative = nativeIds(ctx);
  const rel = stageRelease(ctx, input, version);
  await stopService(ctx);
  writeConfig(ctx, input.config);
  register(ctx, rel);
  const cur: CurrentFile = { ...rel, previous: { version: old.version, appDir: old.appDir, node: old.node, installedAt: old.installedAt } };
  ctx.fx.writeFile(L.currentFile, `${JSON.stringify(cur, null, 2)}\n`, 0o644);
  const ids = [...new Set([...oldNative, ...(input.extensionIds ?? [])])];
  installNative(ctx, rel, ids, input.browsers);
  if (input.noStart) {
    prune(ctx, cur);
    return { ok: true, action: "upgrade", version, message: `upgraded to ${version} (not started)` };
  }
  const started = await startService(ctx);
  if (started.ok) {
    prune(ctx, cur);
    return { ok: true, action: "upgrade", version, healthy: true, message: `upgraded ${old.version} → ${version}; service healthy` };
  }
  // Roll back: previous release, same data.
  ctx.log?.(`new release unhealthy; rolling back to ${old.version}`);
  await stopService(ctx);
  const back: Release = { version: old.version, appDir: old.appDir, node: old.node, installedAt: old.installedAt };
  register(ctx, back);
  ctx.fx.writeFile(L.currentFile, `${JSON.stringify({ ...back, ...(old.previous ? { previous: old.previous } : {}) }, null, 2)}\n`, 0o644);
  installNative(ctx, back, oldNative, input.browsers);
  const again = await startService(ctx);
  ctx.fx.removeTree(rel.appDir);
  return { ok: false, action: "upgrade", version: old.version, healthy: again.ok, rolledBack: true, message: `upgrade to ${version} failed its health check; rolled back to ${old.version}${again.ok ? " (healthy)" : " (NOT healthy — see logs)"}` };
}

export interface UninstallInput {
  /** Also delete data\ (recordings, findings, screenshots, token, config, logs). */
  purgeData?: boolean;
  browsers?: BrowserKind[];
}

export async function uninstall(ctx: DeployContext, input: UninstallInput = {}): Promise<DeployResult> {
  const L = layout(ctx.root);
  await stopService(ctx);
  schtasks(ctx, ["/Delete", "/TN", TASK_NAME, "/F"]); // absent is fine
  applyNativeUninstall(planNativeUninstall({ platform: ctx.platform, pathStyle: LOCAL_PATH_STYLE, installDir: L.nativeDir, ...(input.browsers ? { browsers: input.browsers } : {}) }), ctx.fx);
  for (const p of [L.appsDir, L.runtimeDir]) ctx.fx.removeTree(p);
  for (const f of [L.currentFile, L.taskFile]) ctx.fx.removeFile(f);
  ctx.fx.removeFile(join(L.dataDir, "watchdog.lock"));
  if (input.purgeData) ctx.fx.removeTree(L.dataDir);
  ctx.fx.removeDirIfEmpty(L.root);
  return { ok: true, action: "uninstall", message: input.purgeData ? "removed (data deleted)" : `removed (data kept in ${L.dataDir})` };
}

export interface DeployStatus {
  installed: boolean;
  version: string | null;
  previous: string | null;
  task: { registered: boolean; pointsAtCurrent: boolean };
  supervisor: (SupervisorState & { alive: boolean }) | null;
  healthy: boolean;
  serviceUrl: string;
  config: { source: string; problems: string[] };
  nativeHost: { installed: boolean; problems: string[] } | null;
}

export async function status(ctx: DeployContext): Promise<DeployStatus> {
  const L = layout(ctx.root);
  const cur = readCurrent(ctx);
  const task = taskRegistered(ctx);
  const sup = readSupervisorState(L.dataDir);
  const cfg = loadServiceConfigFile(L.dataDir);
  const url = serviceUrl(ctx);
  const nativeInstalled = ctx.fx.exists(join(L.nativeDir, "native-host.json"));
  const nh = nativeInstalled ? nativeHostStatus({ platform: ctx.platform, pathStyle: LOCAL_PATH_STYLE, installDir: L.nativeDir }, ctx.fx) : null;
  return {
    installed: !!cur,
    version: cur?.version ?? null,
    previous: cur?.previous?.version ?? null,
    task: { registered: task.registered, pointsAtCurrent: !!cur && !!task.action && task.action.command === cur.node && task.action.workingDirectory === cur.appDir },
    supervisor: sup ? { ...sup, alive: ctx.fx.isAlive(sup.pid) } : null,
    healthy: await ctx.fx.health(`${url}/healthz`, 2000),
    serviceUrl: url,
    config: { source: cfg.source, problems: cfg.problems },
    nativeHost: nh ? { installed: nh.installed, problems: nh.problems } : null,
  };
}
