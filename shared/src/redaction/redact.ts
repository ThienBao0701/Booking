/**
 * Redaction engine (docs/06-privacy-model.md). Applied at source, re-applied at
 * the service defensively. Pure + dependency-free so it runs identically in the
 * content script and the service.
 */

import {
  CONTENT_PATTERNS,
  MASK,
  isSensitiveField,
} from "./rules.ts";

export { isSensitiveField, MASK } from "./rules.ts";

/** Mask sensitive substrings inside a free-text string. */
export function redactText(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const { re } of CONTENT_PATTERNS) {
    // Each pattern has the global flag; reset lastIndex defensively.
    re.lastIndex = 0;
    out = out.replace(re, MASK);
  }
  return out;
}

const MAX_DEPTH = 8;

/**
 * Deep-redact an arbitrary JSON-like value:
 *  - strings pass through redactText;
 *  - object keys whose name looks sensitive have their values masked entirely;
 *  - recursion is depth-limited to avoid pathological structures.
 */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return MASK as unknown as T;
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1)) as unknown as T;
  }

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (isSensitiveField({ name: key })) {
      out[key] = MASK;
    } else {
      out[key] = redactValue(src[key], depth + 1);
    }
  }
  return out as unknown as T;
}

/**
 * Decide whether a form field value may be captured at all. Sensitive fields
 * return `undefined` (never read); non-sensitive values are still content-masked.
 */
export function redactFieldValue(
  descriptor: {
    name?: string | undefined;
    id?: string | undefined;
    type?: string | undefined;
    autocomplete?: string | undefined;
  },
  value: string | undefined,
): string | undefined {
  if (isSensitiveField(descriptor)) return undefined;
  if (value === undefined) return undefined;
  return redactText(value);
}

/**
 * Heuristic used by the service to decide whether a payload still contains
 * something that looks sensitive after redaction (for quarantine decisions).
 * Conservative: returns true if any content pattern still matches.
 */
export function looksSensitive(input: unknown): boolean {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? "");
  return CONTENT_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(s);
  });
}
