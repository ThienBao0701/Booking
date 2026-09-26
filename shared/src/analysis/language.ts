/**
 * Non-conclusive language guard (Phase 8).
 *
 * Diagnostic findings describe patterns in recorded events. They must never be
 * worded as proof of, or as the cause of, any action by an external platform
 * (bans, suspensions, penalties, enforcement, ranking changes, flagging…).
 * Client-side recordings cannot observe a platform's internal decisions.
 *
 * Applied to every rule-authored text at rule-load time (a rule set containing
 * such wording is rejected) and to every generated finding.
 */

const CLAIM_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\b(prove[sn]?|proof|proving|conclusive(ly)?|definitive(ly)?|undeniabl[ey]|certainly|without (a )?doubt)\b/i, why: "asserts proof/certainty" },
  { re: /\b(confirm(s|ed)?|demonstrates?)\b\s+(that\s+)?(the\s+)?(account|platform|listing|partner)\b/i, why: "asserts a confirmed platform-side fact" },
  { re: /\benforcement\b/i, why: "refers to platform enforcement" },
  { re: /\b(ban(ned|s)?|suspen(d|ded|ds|sion)|penali[sz](e|ed|es|ation)|blacklist(ed)?|delist(ed|ing)?|shadow ?ban(ned)?|throttl(ed|ing) by)\b/i, why: "names a platform sanction" },
  { re: /\b(flagged|detected|caught|identified)\s+by\s+(the\s+)?(platform|booking(\.com)?|extranet|marketplace|anti-?bot|bot[- ]detection|fraud|risk|security|trust)\b/i, why: "claims detection by a platform" },
  { re: /\b(account|listing|property|host|partner)\s+(was|were|is|has been|got|gets)\s+(flagged|restricted|limited|blocked|suspended|banned|penali[sz]ed|downranked|demoted)\b/i, why: "states a platform sanction as fact" },
  { re: /\b(caus(e|es|ed|ing)|leads?\s+to|led\s+to|results?\s+in|resulted\s+in|triggers?|triggered)\b[^.]{0,60}\b(ban|suspen\w*|penal\w*|restrict\w*|block(ed|ing)?|enforce\w*|flag\w*|delist\w*|ranking|visibility)\b/i, why: "asserts causation of a platform outcome" },
  { re: /\b(the\s+)?(platform|booking(\.com)?|extranet|marketplace)\s+(decided|penali[sz]ed|punished|flagged|restricted|blocked|suspended|banned)\b/i, why: "attributes a decision to a platform" },
  { re: /\b(will|would|is going to)\s+(be|get)\s+(blocked|banned|suspended|restricted|penali[sz]ed|flagged|delisted)\b/i, why: "predicts a platform sanction" },
];

export interface LanguageIssue {
  text: string;
  match: string;
  why: string;
}

/** Returns the claims found in `text` (empty = acceptable wording). */
export function findConclusiveClaims(text: string): LanguageIssue[] {
  const issues: LanguageIssue[] = [];
  for (const { re, why } of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) issues.push({ text, match: m[0], why });
  }
  return issues;
}

export function isNonConclusive(text: string): boolean {
  return findConclusiveClaims(text).length === 0;
}

/**
 * Standard caveat attached (last) to every finding's counter-evidence. It is
 * engine-controlled text and therefore not subject to the claim guard.
 */
export const PLATFORM_CAVEAT =
  "Client-side recordings cannot observe any platform's internal decisions; this finding describes a pattern in recorded events only and is not evidence of any platform action.";

/** Fixed disclaimer for reports and the dashboard. */
export const ANALYSIS_DISCLAIMER =
  "Findings are diagnostic observations derived from events recorded in the operator's own browser or replayed against a local mock. " +
  "They describe patterns, timings and sequences in that data. They do not show, and must not be read as showing, that any external platform " +
  "detected, restricted or acted on an account. Confidence values express how clearly a pattern is present in the recorded data, not the likelihood of any platform outcome.";
