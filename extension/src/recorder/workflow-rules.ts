/**
 * Config-driven workflow detection (docs/03-workflow-schema.md: business rules
 * live in configuration, not hard-coded logic). Rules are evaluated in order;
 * the first rule whose every specified criterion matches wins. Ambiguous input
 * yields UNKNOWN rather than a guess.
 */

import type { ElementDescriptor, RecordedAction, WorkflowLabel } from "../shared.ts";

export interface WorkflowRule {
  workflow: WorkflowLabel;
  /** Active SPA view names (e.g. mock Extranet data-view). */
  views?: string[];
  /** Regex sources tested against the page path (case-insensitive). */
  pathPatterns?: string[];
  /** Recorder actions this rule applies to. */
  actions?: RecordedAction[];
  /** Regex sources tested against target selector / label / name. */
  targetPatterns?: string[];
}

export interface DetectInput {
  page: string;
  view?: string | undefined;
  action?: RecordedAction | undefined;
  target?: ElementDescriptor | undefined;
}

const VIEW_RULES: WorkflowRule[] = [
  { workflow: "LOGIN", views: ["login"] },
  { workflow: "PROPERTY_SETUP", views: ["property"] },
  { workflow: "ROOM_SETUP", views: ["rooms"] },
  { workflow: "RATE_SETUP", views: ["rates"] },
  { workflow: "RESERVATION", views: ["reservations"] },
  { workflow: "MESSAGING", views: ["messages"] },
  { workflow: "REVIEW", views: ["reviews"] },
  { workflow: "PHOTO", views: ["photos"] },
  { workflow: "REPORTING", views: ["reports"] },
];

export const DEFAULT_WORKFLOW_RULES: readonly WorkflowRule[] = [
  // Cancellation is an action within reservations — most specific first.
  { workflow: "CANCELLATION", actions: ["click", "submit"], targetPatterns: ["data-cancel", "cancel[-_ ]?(reservation|booking)"] },
  { workflow: "CANCELLATION", views: ["reservations"], actions: ["click", "submit"], targetPatterns: ["\\bcancel\\b"] },
  { workflow: "CANCELLATION", pathPatterns: ["/(reservations?|bookings?)/.*cancel", "/cancellations?(/|$)"] },
  // SPA views (the mock Extranet serves every module at "/").
  ...VIEW_RULES,
  // Path-based rules for Extranet-style multi-page apps. More specific first.
  { workflow: "LOGIN", pathPatterns: ["/(log-?in|sign-?in|auth)(/|$)"] },
  { workflow: "ROOM_SETUP", pathPatterns: ["/rooms?(/|$)", "/room-?types?(/|$)"] },
  { workflow: "RATE_SETUP", pathPatterns: ["/rates?(/|$)", "/pricing(/|$)", "/availability(/|$)", "/calendar(/|$)"] },
  { workflow: "RESERVATION", pathPatterns: ["/reservations?(/|$)", "/bookings?(/|$)"] },
  { workflow: "MESSAGING", pathPatterns: ["/messages?(/|$)", "/inbox(/|$)", "/conversations?(/|$)"] },
  { workflow: "REVIEW", pathPatterns: ["/(guest-?)?reviews?(/|$)"] },
  { workflow: "PHOTO", pathPatterns: ["/photos?(/|$)", "/gallery(/|$)", "/images?(/|$)"] },
  { workflow: "REPORTING", pathPatterns: ["/reports?(/|$)", "/analytics(/|$)", "/statistics(/|$)", "/insights(/|$)"] },
  { workflow: "PROPERTY_SETUP", pathPatterns: ["/propert(y|ies)(/|$)", "/hotel(/|$)"] },
];

const compiled = new WeakMap<WorkflowRule, { path: RegExp[]; target: RegExp[] }>();
function regexes(rule: WorkflowRule): { path: RegExp[]; target: RegExp[] } {
  let c = compiled.get(rule);
  if (!c) {
    c = {
      path: (rule.pathPatterns ?? []).map((s) => new RegExp(s, "i")),
      target: (rule.targetPatterns ?? []).map((s) => new RegExp(s, "i")),
    };
    compiled.set(rule, c);
  }
  return c;
}

function targetText(t: ElementDescriptor | undefined): string {
  if (!t) return "";
  return [t.selector, t.label, t.name, t.role].filter((x) => typeof x === "string").join(" ");
}

export function ruleMatches(rule: WorkflowRule, input: DetectInput): boolean {
  const { path, target } = regexes(rule);
  if (rule.views && !(input.view !== undefined && rule.views.includes(input.view))) return false;
  if (rule.actions && !(input.action !== undefined && rule.actions.includes(input.action))) return false;
  if (path.length > 0 && !path.some((re) => re.test(input.page))) return false;
  if (target.length > 0) {
    const text = targetText(input.target);
    if (!target.some((re) => re.test(text))) return false;
  }
  // A rule with no criteria at all never matches (prevents accidental catch-alls).
  return Boolean(rule.views || rule.actions || rule.pathPatterns || rule.targetPatterns);
}

export function detectWorkflow(input: DetectInput, rules: readonly WorkflowRule[] = DEFAULT_WORKFLOW_RULES): WorkflowLabel {
  for (const rule of rules) if (ruleMatches(rule, input)) return rule.workflow;
  return "UNKNOWN";
}
