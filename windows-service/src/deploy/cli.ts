/**
 * `lab` deployment CLI (Phase 15, ADR-0010). Windows is the target; `status`
 * and `config` work everywhere.
 *
 *   lab install   [--source <checkout>] [--root <dir>] [--port N] [--safety-mode M]
 *                 [--extension-id <id> …] [--browser chrome|edge|chromium …] [--user DOMAIN\user] [--no-start]
 *   lab upgrade   (same options; keeps data and config; rolls back if unhealthy)
 *   lab uninstall [--root <dir>] [--purge-data]
 *   lab status    [--root <dir>] [--json]
 *   lab start | stop | restart [--root <dir>]
 *   lab config    show | validate | set <key>=<value> … [--root <dir>]
 *
 * Exit codes: 0 ok, 1 failed (e.g. unhealthy, rolled back), 2 usage / invalid input.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../main-module.ts";
import { loadServiceConfigFile, parseSetting, validateServiceConfigFile, writeServiceConfigFile } from "../config-file.ts";
import { BROWSERS, type BrowserKind } from "../native/install.ts";
import { type DeployContext, DeployError, type DeployResult, install, layout, realDeployEffects, restartService, startService, status, stopService, uninstall, upgrade } from "./installer.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function defaultRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AutomationLab");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "automation-lab");
}

interface Args {
  command: string | undefined;
  rest: string[];
  source: string | undefined;
  root: string | undefined;
  port: number | undefined;
  safetyMode: string | undefined;
  extensionIds: string[];
  browsers: BrowserKind[];
  user: string | undefined;
  noStart: boolean;
  purgeData: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { command: undefined, rest: [], source: undefined, root: undefined, port: undefined, safetyMode: undefined, extensionIds: [], browsers: [], user: undefined, noStart: false, purgeData: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] as string;
    const next = () => {
      const n = argv[++i];
      if (n === undefined) throw new DeployError(`${v} needs a value`);
      return n;
    };
    if (v === "--source") a.source = next();
    else if (v === "--root") a.root = next();
    else if (v === "--port") a.port = Number(next());
    else if (v === "--safety-mode") a.safetyMode = next();
    else if (v === "--extension-id") a.extensionIds.push(next());
    else if (v === "--browser") {
      const b = next();
      if (!(BROWSERS as readonly string[]).includes(b)) throw new DeployError(`unknown browser: ${b}`);
      a.browsers.push(b as BrowserKind);
    } else if (v === "--user") a.user = next();
    else if (v === "--no-start") a.noStart = true;
    else if (v === "--purge-data") a.purgeData = true;
    else if (v === "--json") a.json = true;
    else if (v === "--") continue;
    else if (v.startsWith("--")) throw new DeployError(`unknown option: ${v}`);
    else if (a.command === undefined) a.command = v;
    else a.rest.push(v);
  }
  return a;
}

export async function runDeployCli(
  argv: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; out?: (s: string) => void; ctx?: Partial<DeployContext> } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const out = opts.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (err) {
    out(`✖ ${(err as Error).message}`);
    return 2;
  }
  const root = resolve(a.root ?? defaultRoot(platform, env));
  const ctx: DeployContext = {
    root,
    platform,
    userId: a.user ?? (env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : (env.USERNAME ?? env.USER ?? "")),
    fx: realDeployEffects,
    log: (l) => out(`· ${l}`),
    ...(opts.ctx ?? {}),
  };
  const report = (r: DeployResult) => {
    out(a.json ? JSON.stringify(r, null, 2) : `${r.ok ? "✔" : "✖"} ${r.message}`);
    return r.ok ? 0 : 1;
  };
  const needsWindows = ["install", "upgrade", "uninstall", "start", "stop", "restart"].includes(a.command ?? "");
  if (needsWindows && platform !== "win32" && !opts.ctx?.fx) {
    out("✖ Task Scheduler registration is Windows-only. On other systems run the supervisor directly: pnpm run start:watchdog (docs/13).");
    return 2;
  }
  try {
    switch (a.command) {
      case "install":
      case "upgrade": {
        if (!ctx.userId) throw new DeployError("cannot determine the Windows user; pass --user DOMAIN\\user");
        const config: Record<string, unknown> = {
          ...(a.port !== undefined ? { port: a.port } : {}),
          ...(a.safetyMode !== undefined ? { safetyMode: a.safetyMode } : {}),
        };
        const v = validateServiceConfigFile(config);
        if (!v.ok) throw new DeployError(v.errors.join("; "));
        const input = {
          sourceDir: resolve(a.source ?? REPO_ROOT),
          nodePath: process.execPath,
          nodeVersion: process.version,
          config: v.value,
          extensionIds: a.extensionIds,
          ...(a.browsers.length ? { browsers: a.browsers } : {}),
          noStart: a.noStart,
        };
        return report(a.command === "install" ? await install(ctx, input) : await upgrade(ctx, input));
      }
      case "uninstall":
        return report(await uninstall(ctx, { purgeData: a.purgeData, ...(a.browsers.length ? { browsers: a.browsers } : {}) }));
      case "start":
        return report(await startService(ctx));
      case "stop":
        return report(await stopService(ctx));
      case "restart":
        return report(await restartService(ctx));
      case "status": {
        const st = await status(ctx);
        if (a.json) out(JSON.stringify(st, null, 2));
        else {
          out(`${st.installed && st.healthy ? "✔" : "✖"} Automation Lab ${st.version ?? "(not installed)"} at ${root}`);
          out(`  task       ${st.task.registered ? (st.task.pointsAtCurrent ? "registered (current release)" : "registered (points elsewhere!)") : "not registered"}`);
          out(`  supervisor ${st.supervisor ? `${st.supervisor.alive ? "running" : "not running"} (${st.supervisor.state}, restarts ${st.supervisor.restarts}${st.supervisor.lastExit ? `, last exit: ${st.supervisor.lastExit.reason}` : ""})` : "never started"}`);
          out(`  service    ${st.healthy ? "healthy" : "not answering"} at ${st.serviceUrl}`);
          out(`  config     ${st.config.source}${st.config.problems.length ? ` — ${st.config.problems.join("; ")}` : ""}`);
          out(`  native     ${st.nativeHost ? (st.nativeHost.installed ? "installed" : `problems: ${st.nativeHost.problems.join("; ")}`) : "not installed"}`);
          if (st.previous) out(`  rollback   ${st.previous} kept`);
        }
        return st.installed && st.healthy ? 0 : 1;
      }
      case "config": {
        const dataDir = layout(root).dataDir;
        const sub = a.rest[0];
        const loaded = loadServiceConfigFile(dataDir);
        if (sub === "show" || sub === undefined) {
          out(JSON.stringify({ source: loaded.source, problems: loaded.problems, values: loaded.values }, null, 2));
          return 0;
        }
        if (sub === "validate") {
          out(loaded.problems.length ? `✖ ${loaded.problems.join("; ")} (running from ${loaded.source})` : `✔ ${loaded.source === "none" ? "no config file (defaults)" : "valid"}`);
          return loaded.problems.length ? 1 : 0;
        }
        if (sub === "set") {
          const next: Record<string, unknown> = { ...loaded.values };
          for (const kv of a.rest.slice(1)) {
            const i = kv.indexOf("=");
            if (i <= 0) throw new DeployError(`expected key=value, got ${kv}`);
            next[kv.slice(0, i)] = parseSetting(kv.slice(0, i), kv.slice(i + 1));
          }
          const v = validateServiceConfigFile(next);
          if (!v.ok) throw new DeployError(v.errors.join("; "));
          writeServiceConfigFile(dataDir, v.value);
          out("✔ saved; restart the service to apply: lab restart");
          return 0;
        }
        throw new DeployError(`unknown config command: ${sub}`);
      }
      default:
        out("usage: lab <install|upgrade|uninstall|status|start|stop|restart|config> [options] (docs/21-windows-deployment.md)");
        return 2;
    }
  } catch (err) {
    out(`✖ ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof DeployError || (err instanceof Error && /^(unknown setting|invalid configuration)/.test(err.message)) ? 2 : 1;
  }
}

if (isMainModule(import.meta.url)) void runDeployCli(process.argv.slice(2)).then((code) => process.exit(code));
