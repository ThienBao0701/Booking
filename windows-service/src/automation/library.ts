/**
 * Workflow library for service-initiated replays (Phase 13): the bundled,
 * read-only examples (examples/workflows) and the operator's own directory
 * (LAB_WORKFLOWS_DIR, default <dataDir>/workflows). Files are validated with
 * the shared workflow schema; `<name>.params.json` next to a workflow is
 * offered as example test data.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type ReplayLibraryEntry, type WorkflowFile, validateWorkflowFile } from "../shared.ts";

export const DEFAULT_EXAMPLES_DIR = fileURLToPath(new URL("../../../examples/workflows/", import.meta.url));
const MAX_FILE_BYTES = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;

export type LibraryEntry = ReplayLibraryEntry;

export interface WorkflowLibraryOptions {
  examplesDir?: string | undefined;
  libraryDir?: string | undefined;
}

export class WorkflowLibrary {
  #dirs: Array<["examples" | "library", string]>;

  constructor(opts: WorkflowLibraryOptions = {}) {
    this.#dirs = [];
    const ex = opts.examplesDir ?? DEFAULT_EXAMPLES_DIR;
    if (ex) this.#dirs.push(["examples", ex]);
    if (opts.libraryDir) this.#dirs.push(["library", opts.libraryDir]);
  }

  #file(source: string, stem: string, suffix = ".json"): string | undefined {
    const dir = this.#dirs.find(([s]) => s === source)?.[1];
    if (!dir || !NAME_RE.test(stem) || stem.endsWith(".params")) return undefined;
    const file = join(dir, `${stem}${suffix}`);
    try {
      const st = statSync(file);
      return st.isFile() && st.size <= MAX_FILE_BYTES ? file : undefined;
    } catch {
      return undefined;
    }
  }

  list(): LibraryEntry[] {
    const out: LibraryEntry[] = [];
    for (const [source, dir] of this.#dirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".json") || name.endsWith(".params.json")) continue;
        const stem = name.slice(0, -5);
        const file = this.#file(source, stem);
        if (!file) continue;
        const e: LibraryEntry = { id: `${source}:${stem}`, source, name: stem, valid: false, errors: [], steps: 0, target: null, hasExampleParams: !!this.#file(source, stem, ".params.json") };
        try {
          const v = validateWorkflowFile(JSON.parse(readFileSync(file, "utf8")));
          if (v.ok) {
            e.valid = true;
            e.name = v.value.workflow;
            e.steps = v.value.steps.length;
            const t = v.value.target as { kind: string; baseUrl?: string };
            e.target = { kind: t.kind, ...(t.baseUrl ? { baseUrl: t.baseUrl } : {}) };
          } else e.errors = v.errors.slice(0, 10);
        } catch (err) {
          e.errors = [`unreadable: ${String(err)}`];
        }
        out.push(e);
      }
    }
    return out;
  }

  /** The parsed workflow (validated by the replay engine when used). */
  get(id: string): { workflow: unknown; exampleParams: Record<string, string> | null } | undefined {
    const m = /^(examples|library):(.+)$/.exec(id);
    if (!m) return undefined;
    const file = this.#file(m[1] as string, m[2] as string);
    if (!file) return undefined;
    const workflow = JSON.parse(readFileSync(file, "utf8")) as WorkflowFile;
    const pfile = this.#file(m[1] as string, m[2] as string, ".params.json");
    let exampleParams: Record<string, string> | null = null;
    if (pfile) {
      const raw = JSON.parse(readFileSync(pfile, "utf8")) as Record<string, unknown>;
      exampleParams = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    }
    return { workflow, exampleParams };
  }
}
