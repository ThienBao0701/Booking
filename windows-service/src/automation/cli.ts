/**
 * lab-replay — run or dry-run a workflow file.
 *
 *   node --experimental-strip-types --experimental-sqlite windows-service/src/automation/cli.ts \
 *     <workflow.json> [--mode SIMULATE] [--dry-run] [--mock-only]
 *     [--param name=value ...] [--params-file params.json] [--db ./.lab-runtime/lab.sqlite] [--json]
 *
 * Exit codes: 0 completed (or dry run that would execute), 1 failed,
 * 2 denied / invalid / would not execute.
 *
 * The shipped controller drives the local mock Extranet only. Non-local
 * (authorized) targets need a browser-backed controller adapter.
 */

import { readFileSync } from "node:fs";

import { isSafetyMode, ReplayNotAuthorizedError, type SafetyMode } from "../shared.ts";
import { Store } from "../db/store.ts";
import { MockExtranetController } from "./mock-controller.ts";
import { ReplayEngine, ReplayValidationError } from "./engine.ts";
import { isMainModule } from "../main-module.ts";

interface Args {
  file: string;
  mode: SafetyMode;
  dryRun: boolean;
  mockOnly: boolean;
  params: Record<string, string>;
  db: string | undefined;
  json: boolean;
}

function usage(msg?: string): never {
  if (msg) process.stderr.write(`error: ${msg}\n`);
  process.stderr.write(
    "usage: lab-replay <workflow.json> [--mode OBSERVE|SIMULATE|AUTHORIZED_AUTOMATION] [--dry-run] [--mock-only]\n" +
      "                  [--param name=value ...] [--params-file f.json] [--db path] [--json]\n",
  );
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { file: "", mode: "SIMULATE", dryRun: false, mockOnly: false, params: {}, db: undefined, json: false };
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
    const engine = new ReplayEngine(JSON.parse(readFileSync(args.file, "utf8")), {
      mode: args.mode,
      controller: new MockExtranetController(),
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
