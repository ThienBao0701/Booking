# ADR-0003 — Monorepo with contracts and safety centralized in `shared`

- Status: Accepted
- Date: 2026-09-26

## Context

Five components (extension, service, mock-extranet, dashboard, controller host)
must agree on event/workflow/replay contracts and must not be able to weaken
safety locally.

## Decision

- Use a single repository (pnpm/npm workspaces) with packages: `shared`,
  `extension`, `windows-service`, `mock-extranet`, `dashboard`.
- Put all cross-component contracts — event schema, workflow schema, replay
  format, **safety policy**, and **redaction** — in `shared`.
- Enforce the import rule: everything imports `shared`; `shared` imports nothing
  internal; siblings never import each other.
- Keep `shared` **zero runtime dependency** and **erasable-syntax only** so it
  can be type-checked and unit-tested with the built-in Node test runner and
  type-stripping, with no install step. This keeps the safety-critical core
  always testable in CI regardless of network state.

## Consequences

- One authoritative place for contracts and safety; components stay decoupled.
- The safety-critical core is provable in CI without external tooling.
- Sibling communication goes through the service API / event bus, preserving
  modularity.
