# STEALTH BROWSER AUTOMATION LAB

A **local, single-operator diagnostics & authorized-automation lab** for
browser / Extranet workflows. It lets you **observe → reproduce → analyze →
debug → improve** your *own* authenticated workflows in a controlled lab —
including a bundled **mock Extranet** — instead of experimenting on a live
production account.

> ### Scope & safety (read this first)
>
> This is a **diagnostics / QA / authorized-automation** tool. It is **not** an
> evasion tool. The following are **deliberately not implemented** and are
> enforced-unavailable in code (`shared/src/safety`, tested in
> `shared/test/safety.test.ts`):
> anti-detection · stealth evasion · fingerprint spoofing · IP rotation ·
> CAPTCHA bypass · bot-detection bypass · fake/synthetic human behavior.
>
> - Record only your **own** sessions. Never captures passwords, payment data,
>   tokens, or auth secrets (`docs/06-privacy-model.md`).
> - **Replay runs only against the bundled mock environment or an
>   operator-declared authorized target** (`docs/07-safety-modes.md`).
> - Request observability is **read-only metadata** — it never modifies, forges,
>   or evades server-side security controls.
> - Use it only on systems you own or are explicitly authorized to test, within
>   those systems' Terms of Service and applicable law (see `LICENSE`).

## Status

Built in phases (see `docs/adr/` and the phase list below). **Phases 0 and 3 are
complete** and fully tested (64 tests, zero-install): the `shared` contracts +
safety + redaction core, and the local background service (loopback API, event
bus, SQLite/WAL, watchdog).

| Phase | Component | State |
|------:|-----------|-------|
| 0 | Architecture, docs, `shared` contracts/safety/redaction | ✅ done, tested |
| 3 | Local background service (localhost API, event bus, SQLite, watchdog) | ✅ done, tested |
| 1 | MV3 extension skeleton (least-privilege) | ⬜ next |
| 2 | Event recorder | ⬜ |
| 4 | Bridge (extension ↔ service) | ⬜ |
| 5 | Mock Extranet | ⬜ |
| 6–10 | Controller · replay engine · analyzer · dashboard · reports | ⬜ |
| 11–15 | Security hardening · tests · CI · installer | ⬜ (CI + tests scaffolded) |

## Repository layout

```
stealth-browser-automation-lab/
  shared/           # contracts: event/workflow/replay schema, safety, redaction (done)
  extension/        # MV3 extension (phase 1+)
  windows-service/  # local background service (phase 3+)
  mock-extranet/    # safe automation target (phase 5+)
  dashboard/        # web dashboard (phase 9+)
  docs/             # source-of-truth documentation + ADRs
  .github/workflows # CI
```

## Architecture

```
Chrome/Chromium/Edge → MV3 Extension → localhost/native bridge →
Local Background Service (event bus + SQLite/WAL + watchdog) →
Automation Engine (BrowserController) → Analyzer → Dashboard + Reports
```

Full detail: **`docs/01-architecture.md`**. The architecture is treated as the
source of truth; boundary changes go through an ADR (`docs/adr/`).

## Installation (developer, current phase)

Requires **Node ≥ 22** (for TypeScript type-stripping; no build step needed for
dev/test).

```bash
# Run the safety-critical core + service test suite — zero install required:
node --test --experimental-strip-types shared/test/*.test.ts
node --test --experimental-strip-types --experimental-sqlite windows-service/test/*.test.ts

# Or via npm scripts (workspaces):
npm run test:core        # shared + service
npm run test:shared      # shared only

# Start the local service (loopback only):
node --experimental-strip-types --experimental-sqlite windows-service/src/index.ts

# Typecheck the contracts (requires TypeScript, installed via pnpm/npm):
pnpm install            # or: npm install
pnpm -C shared typecheck
```

Windows installer, service auto-start, and extension packaging land in Phase 12
/ 15 (`docs/` will carry the end-user install steps then).

## Permissions (extension, planned — least privilege)

No `<all_urls>`. The extension will request the minimum required, preferring
`activeTab` / optional host permissions for the specific target being debugged.
The full permission table lands with Phase 1 in `extension/manifest.json` and is
governed by `docs/05-security-model.md`.

## Key references

| Topic | Document |
|-------|----------|
| Architecture | `docs/01-architecture.md` |
| Event schema | `docs/02-event-schema.md` |
| Workflow schema | `docs/03-workflow-schema.md` |
| Replay format | `docs/04-replay-format.md` |
| Security model | `docs/05-security-model.md` |
| Privacy model | `docs/06-privacy-model.md` |
| Safety modes & exclusions | `docs/07-safety-modes.md` |
| Data model (SQLite) | `docs/08-data-model.md` |
| Troubleshooting | `docs/09-troubleshooting.md` |
| Testing | `docs/10-testing.md` |
| ADRs | `docs/adr/` |

## Safety modes (Component 12)

| Mode | Recording | Replay side effects | Allowed targets |
|------|-----------|---------------------|-----------------|
| `OBSERVE` (default) | yes | none | none |
| `SIMULATE` | yes | mock only | mock |
| `AUTHORIZED_AUTOMATION` | yes | yes | mock **or** authorized (with authorization record) |

## Testing

`shared` is tested with Node's built-in runner (no external deps). See
`docs/10-testing.md`. CI (`.github/workflows/ci.yml`) always runs the `shared`
safety/contract suite; per-package build/lint/test jobs come online as each
phase lands.

## Production deployment

Deferred to Phases 11–15 (security hardening, packaging, Windows installer with
service auto-recovery). The design targets: localhost-only binding, auth token +
origin validation + rate limiting, SQLite WAL, event batching, and a watchdog
for crash recovery — see `docs/05-security-model.md` and `docs/08-data-model.md`.

## License

MIT + binding Acceptable-Use terms — see `LICENSE`.
