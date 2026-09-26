# 14 — Workflow Analysis (Phase 8)

The analyzer turns recorded events into **diagnostic findings**: patterns in
the timing, order and repetition of the operator's own workflow, each linked
to the exact events that produced it.

> **What a finding is not.** A finding describes a pattern in client-side
> events recorded in the operator's browser or replayed against the local
> mock. It is **never** evidence that any external platform detected,
> restricted, ranked or acted on an account. Client-side recordings cannot
> observe a platform's internal decisions. This is enforced in code, not only
> stated here (see *Non-conclusive language guard*).

Code: `shared/src/analysis/` (contracts, validators, language guard) and
`windows-service/src/analysis/` (engine). No new dependency; pure functions
over the existing `LabEvent` wire contract (converted with `fromLabEvent`).

## Pipeline

```
stored LabEvents ──fromLabEvent──► analyzer model (AEvent, sorted by seq)
   │
   ├─ segmentation ............ workflow segments per tab (segment.ts)
   ├─ timing analysis ......... duration, gap distribution, longest gaps, per-workflow time
   ├─ repeated sequences ...... n-grams of operator actions (non-overlapping, maximal)
   ├─ workflow graph .......... nodes = workflows, edges = transitions (+ sample event ids)
   ├─ environment report ...... recorded facts only (session_start / first page_state)
   ├─ rule engine ............. JSON rules × (session, cohort) → matches
   └─ findings ................ evidence extraction, confidence, counter-evidence, validation
```

`analyzeCohort(sessions, { rules, now })` analyses every session with the rest
of the cohort as baseline (outliers) and comparison set (cross-session
correlation). It is deterministic: the same events, rules and clock give the
same result, including finding ids.

## Finding contract

| field | meaning |
|---|---|
| `finding_id` | `fnd_` + sha256(rule_id, session_id, event_ids)[:20] — stable across re-runs |
| `session_id` | analysed session |
| `workflow` | workflow the pattern belongs to (or the dominant one of its events) |
| `event_ids` | **the exact events that triggered the rule**, in seq order (never empty) |
| `timestamp_range` | `{ start, end }` over those events |
| `rule_id` | the JSON rule that produced it (with `context.rule_version`, `context.rules_version`) |
| `category`, `severity` | from the rule |
| `title`, `description` | rendered rule templates |
| `evidence` | one item per triggering event (`role: "trigger"`) plus one context event before/after (`role: "context"`) |
| `confidence` | 0.05–0.95: how clearly the pattern is present in the data — **not** a probability of any platform outcome |
| `counter_evidence` | rule hints + generated bounds (prevalence in the cohort, target kind, data quality, sample size); the platform caveat is always last |
| `recommended_next_test` | a concrete next experiment (usually a replay against the mock) |
| `frequency`, `context`, `possible_explanation`, `created_at` | supporting data |

`validateFinding` (shared) rejects any finding without event ids, without an
evidence item per event id, without counter-evidence, with confidence outside
0.05–0.95, or with conclusive wording. A rejected finding is dropped and
reported in `warnings`; it never reaches the store.

Confidence starts at the rule's base value and is lowered by 0.2 when the
finding's range contains quarantined events or sequence gaps, lowered by 0.1
for sessions with fewer than 10 events, and raised by 0.05 when the rule
matched three or more times; it is clamped to 0.05–0.95.

## JSON rule engine

Rules are data (`windows-service/src/analysis/rules/default-rules.json`,
21 rules). A custom set can be stored in `<LAB_DATA_DIR>/analysis-rules.json`
through `PUT /v1/analysis/rules`.

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "GAP-LONG-IDLE",            // ^[A-Z][A-Z0-9_-]{2,63}$, unique
      "version": 1,
      "enabled": true,                  // optional
      "category": "TIMING",             // FINDING_CATEGORIES
      "severity": "info",               // info | warn | error
      "title": "Idle period of {{gap_s}} s",
      "description": "No event was recorded for {{gap_s}} s (threshold {{threshold_s}} s).",
      "possible_explanation": "The operator may have been away, reading, or working in another window.",
      "recommended_next_test": "…",
      "counter_evidence": ["…"],        // optional hints
      "confidence": 0.6,                // 0.05..0.95
      "when": { "type": "gap", "min_ms": 300000 }
    }
  ]
}
```

Condition types (`when.type`):

| type | parameters | matches |
|---|---|---|
| `sequence` | `steps[2..10]`, `within_ms?`, `same_tab?` | ordered steps (event sequence detection) |
| `repetition` | `match`, `min_count`, `within_ms?`, `consecutive?` | the same control used repeatedly |
| `repeated_sequence` | `min_length`, `max_length` (2..8), `min_count` | a multi-step loop of operator actions |
| `gap` | `min_ms`, `after?`, `before?` | a pause between consecutive events |
| `duration` | `workflow?`, `min_ms?`, `max_ms?`, `min_events?` | workflow segments shorter/longer than bounds |
| `count` | `match`, `min?`, `max?` | number of matching events (fires only when ≥ 1 matched) |
| `rate` | `match`, `window_ms`, `min_count` | densest window of matching events |
| `absence` | `after`, `expect`, `within_ms` | expected follow-up missing (judged only if the window was fully observed) |
| `outlier` | `metric` (`inter_event_gap` \| `segment_duration`), `z?`, `min_samples?`, `min_ms?` | robust z-score (median/MAD) with an absolute floor; segment durations vs. the same workflow in the cohort |
| `data_quality` | `check` (`seq_gap` \| `ts_regression` \| `quarantined` \| `unterminated`) | recording-quality issues |
| `cross_session` | `pattern` (`workflow_bigram` \| `action_trigram`), `min_sessions`, `min_share?`, `max_share?`, `min_cohort?` | patterns shared with (or rare among) other sessions — aggregated into one match per session |

Matchers constrain at least one of `kind`, `action`, `workflow`, `severity`
(value or list), `target` / `page` (case-insensitive regex, ≤ 200 chars) and
`metadata` (scalar equality). Templates may only use the placeholders in
`RULE_PLACEHOLDERS`; unknown placeholders are rejected at load time.

**Fail closed.** `validateRuleSet` rejects the whole set on any error (shape,
duplicate ids, unknown fields, bad regex, confidence 1.0, conclusive wording…).
An invalid custom file on disk is ignored — the defaults are used and
`GET /v1/analysis/rules` reports the reason. A rule that throws during
evaluation produces a warning; other rules still run. Each rule reports at most
25 matches per session (`MAX_MATCHES_PER_RULE`, warning when capped).

## Non-conclusive language guard

`findConclusiveClaims` (shared/src/analysis/language.ts) rejects wording that
asserts proof or certainty, platform enforcement or sanctions (ban,
suspension, penalty, delisting, shadow ban…), detection *by a platform*,
sanctions stated as fact, causation of a platform outcome, decisions
attributed to a platform, or predicted sanctions. It runs on every rule
template when a rule set is loaded and on every generated finding. Every
finding also ends with the fixed `PLATFORM_CAVEAT`, and reports and the
dashboard display `ANALYSIS_DISCLAIMER`.

## Session comparison

`compare(a, b)` returns: similarity (0.6 × workflow-sequence LCS ratio +
0.4 × Jaccard of operator-action tokens), the workflow sequences with their
common subsequence and `only_a` / `only_b`, per-workflow time with delta and
ratio, event/error counts, median inter-event gap, action differences,
field-by-field environment differences, and notes that bound the comparison
(missing environment, different target kinds, small samples).

## Environment report

Built from what the extension recorded — nothing is inferred or spoofed:
`session_start.metadata.environment` (browser family + major version,
platform, language, timezone + offset, hardware concurrency, extension
version) and the first `page_state.metadata.environment` (viewport, screen,
device pixel ratio, colour scheme). `source_event_ids` cites those events.
The full user-agent string is not recorded. Sessions recorded before this
capture existed report `captured: false`.

## API

All routes sit behind the standard pipeline (loopback Host check → Origin
check → bearer token → rate limit), see [05-security-model](05-security-model.md).

| method | route | effect |
|---|---|---|
| GET | `/v1/sessions/:id/analysis` | full `AnalysisResult` for one session against the recent cohort (not persisted) |
| POST | `/v1/analysis/run` `{ sessionIds? }` | analyse (default: recent cohort, ≤ 200 ids) and **persist** findings, replacing earlier findings of those sessions |
| GET | `/v1/analysis/compare?a=&b=` | `SessionComparison` |
| GET | `/v1/analysis/graph?sessions=a,b` | `WorkflowGraph` (default: recent cohort) |
| GET | `/v1/findings?session=&workflow=&severity=&category=&rule=&q=&from=&to=&limit=&offset=` | persisted findings, `{ total, findings }` (limit ≤ 500) |
| GET | `/v1/findings/:id` | `{ finding, events, missing_event_ids }` — the stored events the finding cites |
| GET | `/v1/analysis/rules` | `{ source, version, error, rules }` |
| PUT | `/v1/analysis/rules` | validate + persist a custom rule set (atomic write, mode 0600); `400 invalid_rules` with errors otherwise |
| DELETE | `/v1/analysis/rules` | back to the built-in rules |

Invalid query values (unknown enum, non-integer numbers, malformed ids) are
`400`, never `500`.

**Automatic analysis.** When a session ends (`session.end` on the event bus)
the service analyses it off the request path — coalesced, 1.5 s after the end
so the bridge's final batch has landed — and persists its findings. Failures
are logged (`analysis_failed`) and never affect ingestion.

## Storage

Findings extend the existing `findings` table additively (no new table, no
schema-version bump); see [08-data-model](08-data-model.md). Older rows remain
readable (`rule_id: "LEGACY"`).
