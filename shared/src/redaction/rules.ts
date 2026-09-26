/**
 * Redaction rules (Component 1 privacy constraints / docs/06-privacy-model.md).
 *
 * Centralized so the privacy policy is defined once and provably applied
 * (shared/test/redaction.test.ts). Rules are data; the engine in redact.ts
 * applies them.
 */

/** Field name / autocomplete tokens that mark an input as sensitive-never-read. */
export const SENSITIVE_FIELD_PATTERNS: readonly RegExp[] = [
  /pass(word|code|phrase)?/i,
  /\botp\b|one[-_]?time/i,
  /\b2fa\b|mfa|auth(entication)?[-_]?code/i,
  /\bpin\b/i,
  /\bcvv\b|cvc|security[-_]?code/i,
  /\bcard[-_]?(number|no)\b|cc[-_]?num/i,
  /\biban\b|account[-_]?number|routing/i,
  /\bssn\b|social[-_]?security|national[-_]?id/i,
  /token|secret|api[-_]?key|apikey|private[-_]?key|access[-_]?key/i,
  /credential|bearer|session[-_]?id/i,
];

/** Input `type` attributes whose values are never read. */
export const SENSITIVE_INPUT_TYPES: readonly string[] = ["password"];

/** Autocomplete values that indicate sensitive data. */
export const SENSITIVE_AUTOCOMPLETE: readonly string[] = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
];

/** The replacement token used when masking. */
export const MASK = "[REDACTED]";

/**
 * Value-content patterns masked inside free-text payloads. Order matters:
 * more specific patterns first.
 */
export const CONTENT_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Email addresses.
  { name: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  // JWT-like tokens (three base64url segments).
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  // Long digit runs (card / IBAN / account-like), 13–19 digits with optional spaces/dashes.
  { name: "long-number", re: /\b(?:\d[ -]?){13,19}\b/g },
  // Bearer tokens / api keys — long opaque alphanumeric strings (>= 24 chars).
  { name: "opaque-token", re: /\b[A-Za-z0-9_-]{24,}\b/g },
  // Phone numbers (loose international).
  { name: "phone", re: /(?<!\d)\+?\d[\d\s().-]{7,}\d(?!\d)/g },
];

/** True if a field descriptor should never have its value read. */
export function isSensitiveField(descriptor: {
  name?: string | undefined;
  id?: string | undefined;
  type?: string | undefined;
  autocomplete?: string | undefined;
}): boolean {
  const { name, id, type, autocomplete } = descriptor;
  if (type && SENSITIVE_INPUT_TYPES.includes(type.toLowerCase())) return true;
  if (autocomplete && SENSITIVE_AUTOCOMPLETE.includes(autocomplete.toLowerCase())) return true;
  const hay = `${name ?? ""} ${id ?? ""} ${autocomplete ?? ""}`;
  return SENSITIVE_FIELD_PATTERNS.some((re) => re.test(hay));
}
