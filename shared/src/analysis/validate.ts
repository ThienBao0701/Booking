/**
 * Validation for the JSON rule engine (rule sets) and for findings.
 * Dependency-free; used by the service at rule-load time (fail closed) and by
 * the dashboard's rule editor for immediate feedback.
 */

import { EVENT_KINDS, SEVERITIES, isSeverity } from "../events/types.ts";
import { RECORDED_ACTIONS } from "../events/recorded.ts";
import { WORKFLOW_LABELS, isWorkflowLabel } from "../workflow/types.ts";
import type { ValidationResult } from "../events/validate.ts";
import {
  type AnalysisRule,
  type Finding,
  type RuleSet,
  FINDING_CATEGORIES,
  RULE_CONDITION_TYPES,
  RULE_PLACEHOLDERS,
} from "./types.ts";
import { findConclusiveClaims } from "./language.ts";

const RULE_ID_RE = /^[A-Z][A-Z0-9_-]{2,63}$/;
const PLACEHOLDER_RE = /\{\{\s*([\w]+)\s*\}\}/g;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function oneOrMany(v: unknown, allowed: readonly string[]): boolean {
  const list = Array.isArray(v) ? v : [v];
  return list.length > 0 && list.every((x) => typeof x === "string" && allowed.includes(x));
}
function posInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
function validRegex(src: unknown): boolean {
  if (typeof src !== "string" || src.length > 200) return false;
  try {
    new RegExp(src, "i");
    return true;
  } catch {
    return false;
  }
}

function validateMatcher(m: unknown, path: string, errors: string[]): void {
  if (!isObj(m)) {
    errors.push(`${path}: matcher must be an object`);
    return;
  }
  const known = new Set(["kind", "action", "workflow", "severity", "target", "page", "metadata"]);
  for (const k of Object.keys(m)) if (!known.has(k)) errors.push(`${path}.${k}: unknown matcher field`);
  if (Object.keys(m).length === 0) errors.push(`${path}: matcher must constrain at least one field`);
  if (m.kind !== undefined && !oneOrMany(m.kind, EVENT_KINDS)) errors.push(`${path}.kind: unknown event kind`);
  if (m.action !== undefined && !oneOrMany(m.action, RECORDED_ACTIONS)) errors.push(`${path}.action: unknown action`);
  if (m.workflow !== undefined && !oneOrMany(m.workflow, WORKFLOW_LABELS)) errors.push(`${path}.workflow: unknown workflow`);
  if (m.severity !== undefined && !oneOrMany(m.severity, SEVERITIES)) errors.push(`${path}.severity: unknown severity`);
  if (m.target !== undefined && !validRegex(m.target)) errors.push(`${path}.target: invalid regex`);
  if (m.page !== undefined && !validRegex(m.page)) errors.push(`${path}.page: invalid regex`);
  if (m.metadata !== undefined) {
    if (!isObj(m.metadata)) errors.push(`${path}.metadata: must be an object`);
    else {
      for (const [k, v] of Object.entries(m.metadata)) {
        if (!(v === null || ["string", "number", "boolean"].includes(typeof v))) errors.push(`${path}.metadata.${k}: scalar expected`);
      }
    }
  }
}

function validateCondition(c: unknown, path: string, errors: string[]): void {
  if (!isObj(c) || typeof c.type !== "string" || !(RULE_CONDITION_TYPES as readonly string[]).includes(c.type)) {
    errors.push(`${path}.type: must be one of ${RULE_CONDITION_TYPES.join(", ")}`);
    return;
  }
  const optPos = (k: string) => {
    if (c[k] !== undefined && !posInt(c[k])) errors.push(`${path}.${k}: positive integer expected`);
  };
  const reqPos = (k: string) => {
    if (!posInt(c[k])) errors.push(`${path}.${k}: positive integer required`);
  };
  switch (c.type) {
    case "sequence":
      if (!Array.isArray(c.steps) || c.steps.length < 2 || c.steps.length > 10) errors.push(`${path}.steps: 2..10 matchers required`);
      else c.steps.forEach((s, i) => validateMatcher(s, `${path}.steps[${i}]`, errors));
      optPos("within_ms");
      break;
    case "repetition":
      validateMatcher(c.match, `${path}.match`, errors);
      reqPos("min_count");
      optPos("within_ms");
      break;
    case "repeated_sequence":
      reqPos("min_length");
      reqPos("max_length");
      reqPos("min_count");
      if (posInt(c.min_length) && posInt(c.max_length) && ((c.min_length as number) < 2 || (c.max_length as number) > 8 || (c.min_length as number) > (c.max_length as number))) {
        errors.push(`${path}: 2 <= min_length <= max_length <= 8`);
      }
      break;
    case "gap":
      reqPos("min_ms");
      if (c.after !== undefined) validateMatcher(c.after, `${path}.after`, errors);
      if (c.before !== undefined) validateMatcher(c.before, `${path}.before`, errors);
      break;
    case "duration":
      if (c.workflow !== undefined && !oneOrMany(c.workflow, WORKFLOW_LABELS)) errors.push(`${path}.workflow: unknown workflow`);
      optPos("min_ms");
      optPos("max_ms");
      optPos("min_events");
      if (c.min_ms === undefined && c.max_ms === undefined) errors.push(`${path}: min_ms or max_ms required`);
      break;
    case "count":
      validateMatcher(c.match, `${path}.match`, errors);
      for (const k of ["min", "max"]) {
        if (c[k] !== undefined && !(typeof c[k] === "number" && Number.isInteger(c[k]) && (c[k] as number) >= 0)) errors.push(`${path}.${k}: integer >= 0 expected`);
      }
      if (c.min === undefined && c.max === undefined) errors.push(`${path}: min or max required`);
      break;
    case "rate":
      validateMatcher(c.match, `${path}.match`, errors);
      reqPos("window_ms");
      reqPos("min_count");
      break;
    case "absence":
      validateMatcher(c.after, `${path}.after`, errors);
      validateMatcher(c.expect, `${path}.expect`, errors);
      reqPos("within_ms");
      break;
    case "outlier":
      if (c.metric !== "inter_event_gap" && c.metric !== "segment_duration") errors.push(`${path}.metric: inter_event_gap | segment_duration`);
      if (c.z !== undefined && !(typeof c.z === "number" && c.z >= 2 && c.z <= 20)) errors.push(`${path}.z: 2..20 expected`);
      optPos("min_samples");
      optPos("min_ms");
      break;
    case "data_quality":
      if (!["seq_gap", "ts_regression", "quarantined", "unterminated"].includes(String(c.check))) errors.push(`${path}.check: unknown check`);
      break;
    case "cross_session":
      if (c.pattern !== "workflow_bigram" && c.pattern !== "action_trigram") errors.push(`${path}.pattern: workflow_bigram | action_trigram`);
      reqPos("min_sessions");
      for (const k of ["min_share", "max_share"]) {
        if (c[k] !== undefined && !(typeof c[k] === "number" && (c[k] as number) > 0 && (c[k] as number) <= 1)) errors.push(`${path}.${k}: (0, 1]`);
      }
      optPos("min_cohort");
      break;
  }
}

function validateTemplate(text: unknown, path: string, errors: string[], maxLen = 400): void {
  if (typeof text !== "string" || text.trim().length === 0) {
    errors.push(`${path}: non-empty string required`);
    return;
  }
  if (text.length > maxLen) errors.push(`${path}: at most ${maxLen} characters`);
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!(RULE_PLACEHOLDERS as readonly string[]).includes(m[1] as string)) errors.push(`${path}: unknown placeholder {{${m[1]}}}`);
  }
  for (const issue of findConclusiveClaims(text)) {
    errors.push(`${path}: non-conclusive wording required — "${issue.match}" ${issue.why}`);
  }
}

export function validateRule(r: unknown, path = "rule"): string[] {
  const errors: string[] = [];
  if (!isObj(r)) return [`${path}: must be an object`];
  if (typeof r.id !== "string" || !RULE_ID_RE.test(r.id)) errors.push(`${path}.id: must match ${RULE_ID_RE}`);
  if (!posInt(r.version)) errors.push(`${path}.version: positive integer required`);
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") errors.push(`${path}.enabled: boolean expected`);
  if (!(FINDING_CATEGORIES as readonly string[]).includes(String(r.category))) errors.push(`${path}.category: unknown category`);
  if (!isSeverity(r.severity)) errors.push(`${path}.severity: info | warn | error`);
  validateTemplate(r.title, `${path}.title`, errors, 120);
  validateTemplate(r.description, `${path}.description`, errors);
  validateTemplate(r.possible_explanation, `${path}.possible_explanation`, errors);
  validateTemplate(r.recommended_next_test, `${path}.recommended_next_test`, errors);
  if (r.counter_evidence !== undefined) {
    if (!Array.isArray(r.counter_evidence)) errors.push(`${path}.counter_evidence: array expected`);
    else r.counter_evidence.forEach((t, i) => validateTemplate(t, `${path}.counter_evidence[${i}]`, errors));
  }
  if (!(typeof r.confidence === "number" && r.confidence >= 0.05 && r.confidence <= 0.95)) {
    errors.push(`${path}.confidence: 0.05..0.95 (a finding is never certain)`);
  }
  validateCondition(r.when, `${path}.when`, errors);
  return errors;
}

/** Validate a complete rule set. Invalid sets must not be loaded (fail closed). */
export function validateRuleSet(input: unknown): ValidationResult<RuleSet> {
  if (!isObj(input) || input.version !== 1 || !Array.isArray(input.rules)) {
    return { ok: false, errors: ['rule set must be { "version": 1, "rules": [...] }'] };
  }
  const errors: string[] = [];
  const ids = new Set<string>();
  input.rules.forEach((r, i) => {
    errors.push(...validateRule(r, `rules[${i}]`));
    const id = isObj(r) ? r.id : undefined;
    if (typeof id === "string") {
      if (ids.has(id)) errors.push(`rules[${i}].id: duplicate "${id}"`);
      ids.add(id);
    }
  });
  if (input.rules.length > 500) errors.push("rules: at most 500 rules");
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as RuleSet };
}

/** Structural + wording validation of a generated finding. */
export function validateFinding(f: unknown): ValidationResult<Finding> {
  const errors: string[] = [];
  if (!isObj(f)) return { ok: false, errors: ["finding must be an object"] };
  const str = (k: string) => {
    if (typeof f[k] !== "string" || (f[k] as string).length === 0) errors.push(`${k}: non-empty string required`);
  };
  ["finding_id", "session_id", "rule_id", "title", "description", "recommended_next_test", "possible_explanation"].forEach(str);
  if (!isWorkflowLabel(f.workflow)) errors.push("workflow: invalid label");
  if (!Array.isArray(f.event_ids) || f.event_ids.length === 0 || !f.event_ids.every((x) => typeof x === "string")) {
    errors.push("event_ids: non-empty array of event ids required");
  }
  const tr = f.timestamp_range;
  if (!isObj(tr) || typeof tr.start !== "number" || typeof tr.end !== "number" || tr.start > tr.end) {
    errors.push("timestamp_range: { start <= end } required");
  }
  if (!(FINDING_CATEGORIES as readonly string[]).includes(String(f.category))) errors.push("category: unknown");
  if (!isSeverity(f.severity)) errors.push("severity: invalid");
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) errors.push("evidence: non-empty array required");
  if (!(typeof f.confidence === "number" && f.confidence >= 0.05 && f.confidence <= 0.95)) errors.push("confidence: 0.05..0.95");
  if (!Array.isArray(f.counter_evidence) || f.counter_evidence.length === 0) errors.push("counter_evidence: non-empty array required");
  if (!(typeof f.frequency === "number" && f.frequency >= 1)) errors.push("frequency: >= 1");
  for (const k of ["title", "description", "possible_explanation", "recommended_next_test"]) {
    if (typeof f[k] === "string") {
      for (const issue of findConclusiveClaims(f[k] as string)) errors.push(`${k}: "${issue.match}" ${issue.why}`);
    }
  }
  if (Array.isArray(f.event_ids) && Array.isArray(f.evidence)) {
    const cited = new Set((f.evidence as Array<{ event_id?: string }>).map((e) => e.event_id));
    for (const id of f.event_ids as string[]) if (!cited.has(id)) errors.push(`evidence: missing item for event ${id}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: f as unknown as Finding };
}
