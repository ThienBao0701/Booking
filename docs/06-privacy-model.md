# 06 — Privacy Model

The lab records **structure and timing**, not **secrets and contents**.

## Never captured

- Passwords, PINs, OTP / 2FA codes.
- Payment credentials (card numbers, CVV, IBAN, etc.).
- Authentication secrets: cookies, bearer/session tokens, API keys, CSRF tokens.
- Personal data beyond what is strictly needed for workflow analysis
  (e.g. free-text guest messages, full names, emails, phone numbers, addresses).

## How redaction works (defense in depth)

1. **At source (content script).** Before an event leaves the page:
   - form field **values** are dropped by default; only field `name`/`role`/
     type is kept, and only when the field is not classified sensitive;
   - inputs of type `password`, or matching sensitive name/autocomplete
     patterns (`password`, `otp`, `cvv`, `card`, `iban`, `ssn`, `token`,
     `secret`, `apikey`, …) are never read at all;
   - free-text payloads pass through `shared/src/redaction` which masks
     emails, phone numbers, long digit runs (card/IBAN-like), and known token
     shapes.
2. **In transit.** Events are marked `redacted: true`; the bridge refuses to
   forward an event with `redacted !== true`.
3. **At the service.** Redaction is re-applied defensively and validation runs
   again; anything that still looks sensitive is quarantined to the error log
   (metadata only), never stored in the main event table.

Redaction rules and patterns are centralized in `shared/src/redaction/rules.ts`
and unit-tested (`shared/test/redaction.test.ts`), so the policy is one place
and provably applied.

## Screenshots

- Captured only on an explicit user action trigger (Component 1), not
  continuously.
- Stored locally; a masking pass can be applied. Operators should avoid
  screenshotting pages showing secrets; the tool warns on known-sensitive
  routes (config-driven).

## Data lifecycle

- All data is local. Retention is operator-controlled; the service supports
  purging a session and vacuuming the database.
- Nothing is uploaded anywhere by the tool.

## Environment / fingerprint report (Component 8)

The environment report contains only values a page can already observe about
itself (browser family + major version, platform, language, timezone,
hardware concurrency, viewport, screen size, pixel ratio, colour scheme,
extension version, session duration). It is a **comparison** artifact across
sessions. The full user-agent string is not recorded, and there is no canvas,
audio, WebGL or font probing. The tool never spoofs or alters any of these
values. Browser facts ride on `session_start`, page facts on the first
`page_state` of a tab (`metadata.environment`).
