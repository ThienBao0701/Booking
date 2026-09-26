# 10 — Testing Strategy (Component 14)

## Layers

| Layer                | Where                         | Runner                         |
|----------------------|-------------------------------|--------------------------------|
| Unit                 | each package `*/test`         | `node --test` (type-stripping) |
| Contract/schema      | `shared/test`                 | `node --test`                  |
| Integration          | service ⇄ mock-extranet       | `node --test` + ephemeral svc  |
| Extension            | recorder/redaction units + harness | `node --test` / Playwright |
| Replay               | replay engine vs mock         | `node --test`                  |
| Persistence          | SQLite read/write/vacuum      | `node --test` + tmp db         |
| Crash recovery       | kill + restart + WAL replay   | `node --test` (spawn)          |

## Available now (Phase 0)

The `shared` package is fully unit-tested with **zero install**:

```bash
node --test --experimental-strip-types shared/test/*.test.ts
# or
npm run test:shared
```

Covers: id/time helpers, event validation, workflow validation, replay
validation + target guard, **safety policy** (modes + forbidden-capability
denylist), and **redaction** (secrets/PII masking).

## CI pipeline (Component 14)

`.github/workflows/ci.yml`:

1. `shared` job — always runs, no network (built-in test runner).
2. `workspaces` job — install + typecheck + lint + test + build across
   packages as they land (non-blocking until each phase is complete).

Target order mirrors the spec: lint → typecheck → unit → integration →
build extension → build service → build dashboard.

## Principles

- Safety and redaction are the highest-priority test targets: a regression that
  weakens them must fail CI.
- Tests are deterministic; time and ids are injectable so runs are reproducible.
