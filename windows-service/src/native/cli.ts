/**
 * Native host installer CLI (Phase 14):
 *
 *   pnpm run native-host:install -- --extension-id <32 a-p> [--extension-id …]
 *        [--service-url http://127.0.0.1:4577] [--install-dir <dir>] [--log-dir <dir>]
 *        [--browser chrome|edge|chromium …] [--user-data-dir <profile> …] [--dry-run] [--json]
 *   pnpm run native-host:uninstall -- [--install-dir <dir>] [--browser …] [--user-data-dir …] [--dry-run]
 *   pnpm run native-host:status    -- [--install-dir <dir>] [--browser …] [--user-data-dir …]
 *
 * Defaults: install dir `<LAB_DATA_DIR>/native-host`, logs `<LAB_DATA_DIR>/logs`,
 * service URL from LAB_SERVICE_HOST / LAB_SERVICE_PORT. Exit 0 ok, 1 failed, 2 usage.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../main-module.ts";
import { BROWSERS, type BrowserKind, InstallError, applyInstall, applyUninstall, nativeHostStatus, planInstall, planUninstall } from "./install.ts";

export const HOST_ENTRY = fileURLToPath(new URL("./main.ts", import.meta.url));

interface Args {
  command: string | undefined;
  extensionIds: string[];
  serviceUrl: string | undefined;
  installDir: string | undefined;
  logDir: string | undefined;
  browsers: BrowserKind[];
  userDataDirs: string[];
  dryRun: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { command: undefined, extensionIds: [], serviceUrl: undefined, installDir: undefined, logDir: undefined, browsers: [], userDataDirs: [], dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] as string;
    const next = () => {
      const n = argv[++i];
      if (n === undefined) throw new InstallError(`${v} needs a value`);
      return n;
    };
    if (v === "--extension-id") a.extensionIds.push(next());
    else if (v === "--service-url") a.serviceUrl = next();
    else if (v === "--install-dir") a.installDir = next();
    else if (v === "--log-dir") a.logDir = next();
    else if (v === "--browser") {
      const b = next();
      if (!(BROWSERS as readonly string[]).includes(b)) throw new InstallError(`unknown browser: ${b} (chrome, edge, chromium)`);
      a.browsers.push(b as BrowserKind);
    } else if (v === "--user-data-dir") a.userDataDirs.push(next());
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--json") a.json = true;
    else if (v === "--") continue;
    else if (!v.startsWith("-") && a.command === undefined) a.command = v;
    else throw new InstallError(`unknown argument: ${v}`);
  }
  return a;
}

export function runNativeCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, out: (s: string) => void = (s) => process.stdout.write(`${s}\n`)): number {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (err) {
    out(`✖ ${(err as Error).message}`);
    return 2;
  }
  const dataDir = resolve(env.LAB_DATA_DIR ?? "./.lab-runtime");
  const target = {
    platform: process.platform,
    installDir: resolve(a.installDir ?? resolve(dataDir, "native-host")),
    ...(a.browsers.length ? { browsers: a.browsers } : {}),
    home: homedir(),
    userDataDirs: a.userDataDirs.map((d) => resolve(d)),
  };
  const print = (human: string, data: unknown) => out(a.json ? JSON.stringify(data, null, 2) : human);
  try {
    switch (a.command) {
      case "install": {
        const host = env.LAB_SERVICE_HOST ?? "127.0.0.1";
        const serviceUrl = a.serviceUrl ?? `http://${host.includes(":") ? `[${host}]` : host}:${env.LAB_SERVICE_PORT ?? "4577"}`;
        const plan = planInstall({ ...target, extensionIds: a.extensionIds, serviceUrl, nodePath: process.execPath, hostEntry: HOST_ENTRY, logDir: resolve(a.logDir ?? resolve(dataDir, "logs")) });
        if (a.dryRun) {
          print([`would write:`, ...plan.files.map((f) => `  ${f.path}`), ...plan.registry.map((r) => `  reg ${r.key} = ${r.value}`)].join("\n"), plan);
          return 0;
        }
        const res = applyInstall(plan);
        print([`✔ native host installed (${plan.manifest.name as string})`, `  manifest  ${plan.manifestPath}`, `  launcher  ${plan.launcherPath}`, `  allowed   ${(plan.manifest.allowed_origins as string[]).join(", ")}`, ...res.registry.map((k) => `  registry  ${k}`)].join("\n"), { ...res, manifestPath: plan.manifestPath });
        return 0;
      }
      case "uninstall": {
        const plan = planUninstall(target);
        if (a.dryRun) {
          print([`would remove:`, ...plan.files.map((f) => `  ${f}`), ...plan.registryKeys.map((k) => `  reg ${k}`)].join("\n"), plan);
          return 0;
        }
        const res = applyUninstall(plan);
        print([`✔ native host removed (${res.removed.length} file(s), ${res.registryDeleted.length} registry key(s); ${res.absent.length} already absent)`].join("\n"), res);
        return 0;
      }
      case "status": {
        const st = nativeHostStatus(target);
        print([st.installed ? "✔ native host installed" : "✖ native host not (fully) installed", `  manifest ${st.manifestPath}`, `  allowed  ${st.allowedOrigins.join(", ") || "—"}`, ...st.registered.map((r) => `  ${r.ok ? "✔" : "✖"} ${r.where}`), ...st.problems.map((p) => `  problem: ${p}`)].join("\n"), st);
        return st.installed ? 0 : 1;
      }
      default:
        out("usage: native-host <install|uninstall|status> [options] (see docs/20-native-messaging.md)");
        return 2;
    }
  } catch (err) {
    out(`✖ ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof InstallError ? 2 : 1;
  }
}

if (isMainModule(import.meta.url)) process.exit(runNativeCli(process.argv.slice(2)));
