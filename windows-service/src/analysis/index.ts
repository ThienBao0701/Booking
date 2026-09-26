/** Workflow-analysis engine public surface (Phase 8). */
export { type AEvent, type SessionData, sessionData, toAEvent } from "./model.ts";
export { segmentSession, timingSummary, repeatedSequences, workflowGraph, workflowSequence } from "./segment.ts";
export { compareSessions, extractEnvironment, environmentDifferences, lcs } from "./compare.ts";
export { evaluateRule, matches, MAX_MATCHES_PER_RULE, type EvalContext, type RuleMatch } from "./rules/engine.ts";
export { buildFinding, findingId, render } from "./findings.ts";
export { analyzeCohort, analyzeSession, compare, cohortGraph, environmentReport, rulesVersion, type AnalyzeOptions } from "./analyzer.ts";
export { AnalysisService, loadDefaultRules, type RunSummary } from "./service.ts";
