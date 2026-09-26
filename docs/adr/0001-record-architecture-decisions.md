# ADR-0001 — Record architecture decisions

- Status: Accepted
- Date: 2026-09-26

## Context

The architecture is treated as the source of truth and is frozen except via
explicit proposals. We need a lightweight, durable record of decisions and any
future changes to boundaries.

## Decision

Use Architecture Decision Records (ADRs) in `docs/adr/`. Any change to module
boundaries, the safety policy, contracts in `shared`, or the component map in
`docs/01-architecture.md` MUST be introduced as a new ADR before implementation.
ADRs are append-only; a superseding ADR references the one it replaces.

## Consequences

- Boundary/architecture changes are visible and reviewable.
- Implementation PRs can cite the ADR that authorizes them.
- Silent architecture drift is prevented.
