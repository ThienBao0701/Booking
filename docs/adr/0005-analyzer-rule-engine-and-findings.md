# ADR-0005 — Analyzer, JSON rule engine and the finding contract

- Status: Accepted
- Date: 2026-09-26
- Amends: docs/08-data-model.md (`findings` columns, `environment_reports`).
  Does not change module boundaries or the event/wire contracts.

## Context

Phase 8 adds workflow analysis (Components 6–8): sequence detection,
segmentation, timing, repetition, anomalies, session comparison, cross-session
correlation, workflow graphs and evidence extraction. Findings must link to the
exact events that produced them and must not be presented as proof of any
external platform's enforcement.

## Decisions

1. **Placement.** Contracts, validators and the language guard live in
   `shared/src/analysis/` (dependency-free; reused by the dashboard and
   reports). The engine lives in `windows-service/src/analysis/`, the owner of
   the event store. Input is the existing `LabEvent` contract converted with
   `fromLabEvent`; no second event schema.

2. **Rules are data.** Detection logic is a closed set of parameterised
   condition types; everything tunable (thresholds, matchers, wording, base
   confidence, severity) is JSON. Rule sets are validated **fail-closed**: one
   invalid rule rejects the whole set, and an invalid custom file falls back
   to the built-in defaults with the reason reported.

3. **Non-conclusive by construction.** A shared language guard rejects claims
   of proof, platform enforcement/sanctions, platform-side detection and
   causation of platform outcomes — in rule templates at load time and in every
   generated finding. Confidence is capped at 0.95, counter-evidence is
   mandatory and always ends with a fixed platform caveat.

4. **Traceability.** `event_ids` are the triggering events, never empty; each
   has an evidence item; ids are deterministic
   (sha256 of rule, session and event ids). `GET /v1/findings/:id` returns the
   stored events a finding cites and lists any that are missing.

5. **Storage is additive.** The Component 6 `findings` table gains columns
   (`workflow`, `event_ids`, `rule_id`, `category`, `severity`,
   `description`, `confidence`, `counter_evidence`, `recommended_next_test`,
   `created_at`) through the existing additive-migration mechanism; the schema
   version stays 1 and legacy rows stay readable.

6. **Environment reports are derived, not stored.** The planned
   `environment_reports` table is not created. The report is computed from the
   events that carry the facts (`session_start` / first `page_state`
   `metadata.environment`), so the events stay the single source of truth and
   each value cites its source event. The extension records only coarse facts
   (browser family + major version, not the full user agent).

7. **Automatic analysis** runs on `session.end`, off the request path; manual
   runs go through `POST /v1/analysis/run`. Ad-hoc analysis
   (`GET /v1/sessions/:id/analysis`) never writes.

## Consequences

- New detections usually need only a JSON rule; a new condition type is a
  code change with tests.
- Wording that implies platform enforcement cannot be shipped in a rule set or
  a finding, including by operator-edited rules.
- Findings are reproducible: re-running the same rules on the same data
  replaces findings with identical ids.
