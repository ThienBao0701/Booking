/**
 * lab-report — write a forensic report for one recorded session from the local
 * database (no network, no token: reads the SQLite file directly).
 *
 *   node --experimental-strip-types --experimental-sqlite windows-service/src/reports/cli.ts \
 *     <sessionId> [--format json|csv|html|print] [--table findings|events|evidence]
 *     [--compare <sessionId>] [--db ./.lab-runtime/lab.sqlite] [--out file]
 *
 * Without --out the report is written to stdout. Exit codes: 0 written,
 * 1 session not found, 2 invalid arguments.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { REPORT_CSV_TABLES, REPORT_FORMATS, type ReportCsvTable, type ReportFormat } from "../shared.ts";
import { Store } from "../db/store.ts";
import { AnalysisService } from "../analysis/service.ts";
import { isMainModule } from "../main-module.ts";
import { ReportError, buildReport, renderReport } from "./index.ts";

export interface ReportArgs {
  session: string;
  format: ReportFormat;
  table: ReportCsvTable;
  compare: string | undefined;
  db: string;
  out: string | undefined;
}

export class UsageError extends Error {}

export function parseReportArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): ReportArgs {
  const dataDir = env.LAB_DATA_DIR ?? "./.lab-runtime";
  const a: ReportArgs = { session: "", format: "html", table: "findings", compare: undefined, db: join(dataDir, "lab.sqlite"), out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] as string;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${t} needs a value`);
      return v;
    };
    if (t === "--format") {
      const f = next();
      if (!(REPORT_FORMATS as readonly string[]).includes(f)) throw new UsageError(`invalid format ${f}`);
      a.format = f as ReportFormat;
    } else if (t === "--table") {
      const tb = next();
      if (!(REPORT_CSV_TABLES as readonly string[]).includes(tb)) throw new UsageError(`invalid table ${tb}`);
      a.table = tb as ReportCsvTable;
    } else if (t === "--compare") a.compare = next();
    else if (t === "--db") a.db = next();
    else if (t === "--out") a.out = next();
    else if (t.startsWith("--")) throw new UsageError(`unknown option ${t}`);
    else if (!a.session) a.session = t;
    else throw new UsageError(`unexpected argument ${t}`);
  }
  if (!a.session) throw new UsageError("a session id is required");
  return a;
}

/** Returns the process exit code. */
export function runReportCli(argv: readonly string[], io: { stdout: (s: string) => void; stderr: (s: string) => void } = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }): number {
  let args: ReportArgs;
  try {
    args = parseReportArgs(argv);
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\nusage: lab-report <sessionId> [--format json|csv|html|print] [--table findings|events|evidence] [--compare <id>] [--db path] [--out file]\n`);
    return 2;
  }
  const store = new Store(args.db);
  try {
    let report;
    try {
      report = buildReport(store, new AnalysisService({ store }), args.session, { compare: args.compare });
    } catch (err) {
      if (err instanceof ReportError) {
        io.stderr(`error: ${err.code}\n`);
        return 2;
      }
      throw err;
    }
    if (!report) {
      io.stderr(`error: session ${args.session} not found in ${args.db}\n`);
      return 1;
    }
    const out = renderReport(report, args.format, args.table);
    if (args.out) {
      writeFileSync(args.out, out.body, { mode: 0o600 });
      io.stderr(`report written: ${args.out} (${out.body.length} bytes, sha256 ${report.integrity.digest})\n`);
    } else io.stdout(out.body);
    return 0;
  } finally {
    store.close();
  }
}

if (isMainModule(import.meta.url)) process.exit(runReportCli(process.argv.slice(2)));
