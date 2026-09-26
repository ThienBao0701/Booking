/**
 * lab-replay — run or dry-run a workflow file.
 *
 *   node --experimental-strip-types --experimental-sqlite windows-service/src/automation/cli.ts \
 *     <workflow.json> [--mode SIMULATE] [--dry-run] [--mock-only]
 *     [--param name=value ...] [--params-file params.json] [--db ./.lab-runtime/lab.sqlite] [--json]
 *     [--controller mock|browser] [--allow-origin <origin> ...] [--resource-origin <origin> ...]
 *     [--headed] [--browser-path <chrome>]
 *
 * Exit codes: 0 completed (or dry run that would execute), 1 failed,
 * 2 denied / invalid / would not execute.
 *
 * `--controller mock` (default) drives the local mock Extranet's page model.
 * `--controller browser` drives Chromium via the Playwright adapter; every
 * origin it may touch must be listed with --allow-origin (the target's own
 * origin included) — see docs/17-browser-adapter.md.
 */

import { readFileSync } from "node:fs";

import { isSafetyMode, ReplayNotAuthorizedError, type SafetyMode } from "../shared.ts";
import { Store } from "../db/store.ts";
import { MockExtranetController } from "./mock-controller.ts";
import { ReplayEngine, ReplayValidationError } from "./engine.ts";
import type { BrowserController } from "./controller.ts";
import { BrowserAdapterController, BrowserTargetPolicy, PlaywrightAdapter } from "./browser/index.ts";
import { isMainModule } from "../main-module.ts";

interface Args {
  file: string;
  mode: SafetyMode;
  dryRun: boolean;
  mockOnly: boolean;
  params: Record<string, string>;
  db: string | undefined;
  json: boolean;
  controller: "mock" | "browser";
  allowOrigins: string[];
  resourceOrigins: string[];
  headed: boolean;
  browserPath: string | undefined;
}

function usage(msg?: string): never {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: lab-replay <workflow.json> [--mode OBSERVE|SIMULATE|AUTHORIZED_AUTOMATION] [--dry-run] [--mock-only]\n" +
      "                  [--param name=value ...] [--params-file f.json] [--db path] [--json]\n" +
      "                  [--controller mock|browser] [--allow-origin o ...] [--resource-origin o ...] [--headed] [--browser-path p]\n",
  );
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    file: "",
    mode: "SIMULATE",
    dryRun: false,
    mockOnly: false,
    params: {},
    db: undefined,
    json: false,
    controller: "mock",
    allowOrigins: [],
    resourceOrigins: [],
    headed: false,
    browserPath: process.env.LAB_BROWSER_EXECUTABLE || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] as string;
    const next = (): string => argv[++i] ?? usage(`${t} needs a value`);
    if (t === "--mode") {
      const m = next();
      if (!isSafetyMode(m)) usage(`invalid mode ${m}`);
      a.mode = m;
    } else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--mock-only") a.mockOnly = true;
    else if (t === "--json") a.json = true;
    else if (t === "--db") a.db = next();
    else if (t === "--controller") {
      const c = next();
      if (c !== "mock" && c !== "browser") usage(`invalid controller ${c}`);
      a.controller = c;
    } else if (t === "--allow-origin") a.allowOrigins.push(next());
    else if (t === "--resource-origin") a.resourceOrigins.push(next());
    else if (t === "--headed") a.headed = true;
    else if (t === "--browser-path") a.browserPath = next();
    else if (t === "--param") {
      const kv = next();
      const eq = kv.indexOf("=");
      if (eq <= 0) usage(`--param expects name=value, got ${kv}`);
      a.params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (t === "--params-file") {
      Object.assign(a.params, JSON.parse(readFileSync(next(), "utf8")) as Record<string, string>);
    } else if (t.startsWith("--")) usage(`unknown option ${t}`);
    else if (!a.file) a.file = t;
    else usage(`unexpected argument ${t}`);
  }
  if (!a.file) usage("missing workflow file");
  return a;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const store = args.db ? new Store(args.db) : undefined;
  try {
    const workflow = JSON.parse(readFileSync(args.file, "utf8")) as { target?: unknown };
    let controller: BrowserController = new MockExtranetController();
    if (args.controller === "browser") {
      // Browser runs need the explicit allowlist; decided before any browser starts.
      const p = BrowserTargetPolicy.create({
        mode: args.mode,
        target: workflow.target as Parameters<typeof BrowserTargetPolicy.create>[0]["target"],
        allowlist: args.allowOrigins,
        resourceOrigins: args.resourceOrigins,
      });
      if (!p.ok) {
        process.stderr.write(`denied: ${p.reason} (${p.replayDecision?.code ?? p.code})\n`);
        return 2;
      }
      controller = new BrowserAdapterController({ adapter: new PlaywrightAdapter(), policy: p.policy, headless: !args.headed, executablePath: args.browserPath });
    }
    const engine = new ReplayEngine(workflow, {
      mode: args.mode,
      controller,
      mockOnly: args.mockOnly,
      params: args.params,
      ...(store ? { persist: (r) => store.saveRun(r) } : {}),
      onEvent: (e) => {
        if (args.json || args.dryRun) return;
        const detail = e.detail?.error ? ` — ${String(e.detail.error)}` : "";
        out(`${new Date(e.at).toISOString().slice(11, 23)}  ${e.type.padEnd(15)} ${e.stepId ?? ""}${detail}`);
      },
    });

    if (args.dryRun) {
      const plan = await engine.dryRun();
      out(JSON.stringify(plan, null, 2));
      return plan.wouldExecute ? 0 : 2;
    }
    const run = await engine.start();
    if (args.json) out(JSON.stringify(run, null, 2));
    else out(`run ${run.runId}: ${run.status}${store ? ` (persisted to ${args.db})` : ""}`);
    return run.status === "completed" ? 0 : 1;
  } catch (err) {
    if (err instanceof ReplayNotAuthorizedError) {
      process.stderr.write(`denied: ${err.decision.reason} (${err.decision.code})\n`);
      return 2;
    }
    if (err instanceof ReplayValidationError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
