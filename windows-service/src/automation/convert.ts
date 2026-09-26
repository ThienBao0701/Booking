/**
 * Recording → replayable workflow draft (OBSERVE → RECORD → REPRODUCE).
 *
 * The recorder never captures field values or entity ids (privacy), so the
 * draft is reconstructed with explicit, documented rules:
 *   - typed fields   → `type` with a `{{param}}` placeholder (test data supplied at replay)
 *   - sensitive fields → `type` with `{{secret_<name>}}` (never stored; supplied at replay)
 *   - <select>        → `select "$last"` (binds to the entity created earlier in the run)
 *   - id-less entity selectors (e.g. `button[data-cancel]`) → rebound to `$last.<kind>`
 *   - SPA view changes after a click → `waitFor .view.active[data-view=…]` (robustness)
 *   - checkbox/radio changes → `click`
 *   - scope exits, implicit submits → reported in `notes`, not reproduced
 */

import { type RecordedEvent, type ReplayStep, type ReplayTarget, type WorkflowFile, validateWorkflowFile } from "../shared.ts";

export interface ConvertOptions {
  workflow: string;
  target: ReplayTarget;
  /** First navigation; defaults to the first recorded page. */
  startUrl?: string;
  defaults?: { timeoutMs?: number; retries?: number };
}

export interface ConvertResult {
  file: WorkflowFile;
  /** Placeholders the operator must supply at replay time. */
  params: string[];
  notes: string[];
}

const ENTITY_SELECTORS: Array<[RegExp, string]> = [[/\[data-cancel\]$/, '[data-cancel="$last.reservation"]']];

function paramName(target: RecordedEvent["target"], fallback: number): string {
  const sel = target?.selector ?? "";
  const id = /^#([\w-]+)$/.exec(sel)?.[1];
  if (id) return id;
  const named = /\[name="([\w-]+)"\]/.exec(sel)?.[1];
  return named ?? target?.name ?? `field${fallback}`;
}

export function recordingToWorkflow(events: readonly RecordedEvent[], opts: ConvertOptions): ConvertResult {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const steps: ReplayStep[] = [];
  const params = new Set<string>();
  const notes: string[] = [];
  let selectNoted = false;
  let page: string | undefined;

  const push = (s: Omit<ReplayStep, "id">): void => {
    const last = steps.at(-1);
    if (last && last.action === s.action && last.target === s.target && last.value === s.value) return;
    steps.push({ id: `s${steps.length + 1}`, ...s });
  };

  const firstPage = sorted.find((e) => e.action === "navigate" || e.action === "page_load" || e.action === "page_state")?.page;
  page = opts.startUrl ?? firstPage ?? "/";
  push({ action: "navigate", target: page });

  for (const e of sorted) {
    const sel = e.target?.selector;
    switch (e.action) {
      case "navigate": {
        if (e.metadata.leftScope) {
          notes.push(`seq ${e.seq}: the tab left the recordable scope — not reproduced`);
          break;
        }
        if (e.page !== page) {
          page = e.page;
          push({ action: "navigate", target: e.page });
        }
        break;
      }
      case "click": {
        if (!sel) {
          notes.push(`seq ${e.seq}: click without a stable selector — skipped`);
          break;
        }
        let target = sel;
        for (const [re, replacement] of ENTITY_SELECTORS) {
          if (re.test(sel)) {
            target = sel.replace(re, replacement);
            notes.push(`seq ${e.seq}: "${sel}" rebound to "${target}" (recordings contain no entity ids)`);
          }
        }
        push({ action: "click", target });
        break;
      }
      case "change": {
        if (!sel) {
          notes.push(`seq ${e.seq}: field change without a stable selector — skipped`);
          break;
        }
        const inputType = String(e.metadata.inputType ?? "");
        if (inputType === "checkbox" || inputType === "radio") {
          push({ action: "click", target: sel });
        } else if (e.metadata.sensitive === true) {
          const name = `secret_${paramName(e.target, steps.length + 1)}`;
          params.add(name);
          push({ action: "type", target: sel, value: `{{${name}}}` });
          notes.push(`seq ${e.seq}: sensitive field ${sel} — supply {{${name}}} at replay time; it is never stored`);
        } else if (e.target?.tag === "select" || inputType === "select") {
          push({ action: "select", target: sel, value: "$last" });
          if (!selectNoted) {
            notes.push(`<select> choices replay as "$last" (the entity created earlier in the run); edit to a {{param}} if needed`);
            selectNoted = true;
          }
        } else if (e.metadata.filled !== false) {
          const name = paramName(e.target, steps.length + 1);
          params.add(name);
          push({ action: "type", target: sel, value: `{{${name}}}` });
        }
        break;
      }
      case "submit":
        if (steps.at(-1)?.action !== "click") {
          notes.push(`seq ${e.seq}: implicit form submit (e.g. Enter key) — add a click on the submit button to reproduce`);
        }
        break;
      case "page_state": {
        const view = e.metadata.view;
        if (typeof view === "string" && steps.at(-1)?.action === "click") {
          push({ action: "waitFor", target: `.view.active[data-view="${view}"]` });
        }
        break;
      }
      default:
        break; // lifecycle, DOM summaries, transitions, http, screenshots: not user actions
    }
  }

  const file: WorkflowFile = {
    workflow: opts.workflow,
    version: 1,
    target: opts.target,
    defaults: { timeoutMs: opts.defaults?.timeoutMs ?? 10_000, retries: opts.defaults?.retries ?? 1 },
    steps,
  };
  const v = validateWorkflowFile(file);
  if (!v.ok) throw new Error(`converted workflow is invalid: ${v.errors.join("; ")}`);
  return { file, params: [...params], notes };
}
