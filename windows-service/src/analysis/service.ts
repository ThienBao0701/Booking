/**
 * Service-side analysis facade: rule configuration (defaults + validated custom
 * rules in the data dir), cohort selection, analysis, persistence of findings.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AnalysisResult,
  type AnalysisRunSummary,
  type AnalysisStatus,
  type AnalysisStatusReport,
  type StaleReason,
  type EnvironmentReport,
  type RulesInfo,
  type RuleSet,
  type SessionComparison,
  type ValidationResult,
  type WorkflowGraph,
  validateRuleSet,
} from "../shared.ts";
import type { Store } from "../db/store.ts";
import { type SessionData, sessionData } from "./model.ts";
import { analyzeCohort, cohortGraph, compare, environmentReport, rulesVersion } from "./analyzer.ts";

const DEFAULT_RULES_FILE = fileURLToPath(new URL("./rules/default-rules.json", import.meta.url));

/** The built-in rule set. It must always validate (asserted by tests). */
export function loadDefaultRules(): RuleSet {
  const v = validateRuleSet(JSON.parse(readFileSync(DEFAULT_RULES_FILE, "utf8")));
  if (!v.ok) throw new Error(`built-in rules are invalid: ${v.errors.join("; ")}`);
  return v.value;
}

export interface AnalysisServiceOptions {
  store: Store;
  /** Directory holding analysis-rules.json (custom rules). Omit for defaults only. */
  dataDir?: string;
  /** Sessions used as cohort / baseline (most recent first). */
  cohortLimit?: number;
  now?: () => number;
}

/** POST /v1/analysis/run result (contract: shared AnalysisRunSummary). */
export type RunSummary = AnalysisRunSummary;

export class AnalysisService {
  #store: Store;
  #rulesFile: string | undefined;
  #cohortLimit: number;
  #now: () => number;
  #rules: RuleSet;
  #source: "default" | "custom" = "default";
  #rulesError: string | undefined;

  constructor(opts: AnalysisServiceOptions) {
    this.#store = opts.store;
    this.#rulesFile = opts.dataDir ? join(opts.dataDir, "analysis-rules.json") : undefined;
    this.#cohortLimit = opts.cohortLimit ?? 50;
    this.#now = opts.now ?? Date.now;
    this.#rules = loadDefaultRules();
    if (this.#rulesFile && existsSync(this.#rulesFile)) {
      try {
        const v = validateRuleSet(JSON.parse(readFileSync(this.#rulesFile, "utf8")));
        if (v.ok) {
          this.#rules = v.value;
          this.#source = "custom";
        } else {
          this.#rulesError = `custom rules ignored (invalid): ${v.errors.slice(0, 5).join("; ")}`;
        }
      } catch (err) {
        this.#rulesError = `custom rules ignored (unreadable): ${String(err)}`;
      }
    }
  }

  get rules(): RuleSet {
    return this.#rules;
  }

  rulesInfo(): RulesInfo {
    return { source: this.#source, version: rulesVersion(this.#rules), error: this.#rulesError ?? null, rules: this.#rules };
  }

  /** Validate and persist a custom rule set (atomic write). Invalid sets are rejected. */
  setRules(input: unknown): ValidationResult<RuleSet> {
    const v = validateRuleSet(input);
    if (!v.ok) return v;
    if (this.#rulesFile) {
      const tmp = `${this.#rulesFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(v.value, null, 2), { mode: 0o600 });
      renameSync(tmp, this.#rulesFile);
    }
    this.#rules = v.value;
    this.#source = "custom";
    this.#rulesError = undefined;
    return v;
  }

  resetRules(): void {
    if (this.#rulesFile) rmSync(this.#rulesFile, { force: true });
    this.#rules = loadDefaultRules();
    this.#source = "default";
    this.#rulesError = undefined;
  }

  sessionData(id: string): SessionData | undefined {
    const session = this.#store.getSession(id);
    if (!session) return undefined;
    return sessionData(session, this.#store.getLabEvents(id));
  }

  #load(ids: readonly string[]): SessionData[] {
    return ids.map((id) => this.sessionData(id)).filter((d): d is SessionData => d !== undefined);
  }

  #recentIds(): string[] {
    return this.#store.listSessions(this.#cohortLimit).map((s) => s.id);
  }

  /** Analyse one session against the recent-sessions cohort (not persisted). */
  analyze(id: string): AnalysisResult | undefined {
    if (!this.#store.hasSession(id)) return undefined;
    const ids = [id, ...this.#recentIds().filter((x) => x !== id)];
    return analyzeCohort(this.#load(ids), { rules: this.#rules, now: this.#now }).get(id);
  }

  /**
   * Analyse `sessionIds` (default: the recent cohort) with the recent cohort as
   * context and persist their findings (replacing earlier findings).
   */
  run(sessionIds?: readonly string[]): RunSummary {
    const subjects = sessionIds && sessionIds.length > 0 ? sessionIds.filter((id) => this.#store.hasSession(id)) : this.#recentIds();
    const context = [...new Set([...subjects, ...this.#recentIds()])];
    const version = rulesVersion(this.#rules);
    const analyzedAt = this.#now();
    // Event counts are taken before analysing, so events that arrive meanwhile mark the result stale.
    const meta = subjects.map((id) => ({ session_id: id, analyzed_at: analyzedAt, rules_version: version, event_count: this.#store.countEvents(id) }));
    const results = analyzeCohort(this.#load(context), { rules: this.#rules, now: this.#now });
    const findings = subjects.flatMap((id) => results.get(id)?.findings ?? []);
    this.#store.saveFindings(subjects, findings, meta);
    return {
      sessions: subjects.length,
      findings: findings.length,
      rules_version: version,
      warnings: subjects.flatMap((id) => (results.get(id)?.warnings ?? []).map((w) => `${id}: ${w}`)),
      analyzed_at: analyzedAt,
      session_ids: [...subjects],
    };
  }

  /**
   * Are the stored findings still current? A session is stale when the rule
   * set changed since its analysis, when events arrived after it, or when it
   * has findings without an analysis record (from before provenance existed).
   */
  status(sessionIds?: readonly string[]): AnalysisStatusReport {
    const current = rulesVersion(this.#rules);
    const ids = sessionIds && sessionIds.length > 0 ? sessionIds.filter((id) => this.#store.hasSession(id)) : this.#store.listSessions(500).map((s) => s.id);
    const meta = new Map(this.#store.getAnalysisMeta(ids).map((m) => [m.session_id, m]));
    const counts = this.#store.findingCounts(ids);
    const sessions: AnalysisStatus[] = ids.map((id) => {
      const m = meta.get(id);
      const eventCount = this.#store.countEvents(id);
      const findingCount = counts.get(id) ?? 0;
      const reasons: StaleReason[] = [];
      if (!m) {
        if (findingCount > 0) reasons.push("no_analysis_record");
      } else {
        if (m.rules_version !== current) reasons.push("rules_changed");
        if (eventCount !== m.event_count) reasons.push("new_events");
      }
      return {
        session_id: id,
        state: reasons.length > 0 ? "stale" : m ? "current" : "not_analyzed",
        reasons,
        analyzed_at: m?.analyzed_at ?? null,
        rules_version: m?.rules_version ?? null,
        event_count_at_analysis: m?.event_count ?? null,
        event_count: eventCount,
        finding_count: findingCount,
      };
    });
    return { current_rules_version: current, rules_source: this.#source, stale: sessions.filter((s) => s.state === "stale").length, sessions };
  }

  /** Re-analyse only the sessions whose stored findings are stale. */
  runStale(): RunSummary {
    const stale = this.status().sessions.filter((s) => s.state === "stale").map((s) => s.session_id);
    if (stale.length === 0) return { sessions: 0, findings: 0, rules_version: rulesVersion(this.#rules), warnings: [], analyzed_at: this.#now(), session_ids: [] };
    return this.run(stale);
  }

  compare(a: string, b: string): SessionComparison | undefined {
    const da = this.sessionData(a);
    const db = this.sessionData(b);
    return da && db ? compare(da, db) : undefined;
  }

  environments(ids?: readonly string[]): EnvironmentReport[] {
    return this.#load(ids && ids.length > 0 ? ids : this.#recentIds()).map(environmentReport);
  }

  graph(ids?: readonly string[]): WorkflowGraph {
    return cohortGraph(this.#load(ids && ids.length > 0 ? ids : this.#recentIds()));
  }
}
