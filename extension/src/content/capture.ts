/**
 * Structural element description for interaction recording (docs/06 privacy
 * model). Written against a minimal `ElementLike` interface so it is unit
 * testable without a DOM. Rules:
 *  - selectors prefer stable ids / data attributes; entity ids are never embedded;
 *  - labels come from aria-label/title or *button* captions only (never link
 *    text, which can contain guest names), capped and redacted;
 *  - field VALUES are never read here; sensitive fields are flagged without even
 *    a "filled" bit.
 */

import { type ElementDescriptor, isSensitiveField, redactText } from "../shared.ts";

export interface ElementLike {
  tagName: string;
  id?: string;
  getAttribute(name: string): string | null;
  parentElement?: ElementLike | null;
  textContent?: string | null;
}

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "summary", "label"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);
const BUTTON_LIKE = new Set(["button", "summary"]);
const MAX_LABEL = 60;

/** Climb from an event target to the closest interactive element (bounded depth). */
export function findInteractive(el: ElementLike | null | undefined, maxDepth = 6): ElementLike | null {
  let cur: ElementLike | null | undefined = el;
  for (let depth = 0; cur && depth <= maxDepth; depth++) {
    const tag = cur.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return cur;
    const role = cur.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return cur;
    if (cur.getAttribute("data-action") !== null || cur.getAttribute("data-cancel") !== null) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/** Ids / attribute values that look generated or entity-like are not "stable". */
function isStableValue(v: string): boolean {
  return v.length > 0 && v.length <= 64 && !/\d{5,}/.test(v) && !/[A-Za-z0-9_-]{24,}/.test(v);
}

export function isStableId(id: string): boolean {
  return /^[A-Za-z][\w-]{0,63}$/.test(id) && isStableValue(id);
}

function attrEscape(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

function elementId(el: ElementLike): string {
  return el.id || el.getAttribute("id") || "";
}

export function buildSelector(el: ElementLike): string {
  const tag = el.tagName.toLowerCase();
  const id = elementId(el);
  if (id && isStableId(id)) return `#${id}`;
  for (const attr of ["data-action", "data-view", "data-testid", "name"]) {
    const v = el.getAttribute(attr);
    if (v !== null && isStableValue(v)) return `${tag}[${attr}="${attrEscape(v)}"]`;
  }
  // data-cancel's value is an entity id — keep the attribute, drop the value.
  if (el.getAttribute("data-cancel") !== null) return `${tag}[data-cancel]`;
  const aria = el.getAttribute("aria-label");
  if (aria !== null && isStableValue(aria)) return `${tag}[aria-label="${attrEscape(redactText(aria))}"]`;
  return tag;
}

export function elementLabel(el: ElementLike): string | undefined {
  const tag = el.tagName.toLowerCase();
  let text = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? undefined;
  if (!text && (BUTTON_LIKE.has(tag) || el.getAttribute("role") === "button")) text = el.textContent ?? undefined;
  if (!text && tag === "input") {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "submit" || type === "button") text = el.getAttribute("value") ?? undefined; // caption, not user data
  }
  if (!text) return undefined;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  return clean ? redactText(clean) : undefined;
}

export function describeElement(el: ElementLike): ElementDescriptor {
  const d: ElementDescriptor = { tag: el.tagName.toLowerCase(), selector: buildSelector(el) };
  const label = elementLabel(el);
  if (label) d.label = label;
  const role = el.getAttribute("role");
  if (role) d.role = role;
  const name = el.getAttribute("name");
  if (name && isStableValue(name)) d.name = name;
  return d;
}

/** True when a form field must never be read (password, OTP, card, token...). */
export function isSensitiveElement(el: ElementLike): boolean {
  return isSensitiveField({
    name: el.getAttribute("name") ?? undefined,
    id: elementId(el) || undefined,
    type: el.getAttribute("type") ?? undefined,
    autocomplete: el.getAttribute("autocomplete") ?? undefined,
  });
}

/**
 * Describe a form field interaction. `filled` must be computed by the caller
 * only for non-sensitive fields; for sensitive fields it is ignored entirely.
 */
export function describeField(el: ElementLike, filled: boolean): { target: ElementDescriptor; metadata: Record<string, unknown> } {
  const target = describeElement(el);
  const inputType = (el.getAttribute("type") ?? el.tagName).toLowerCase();
  if (isSensitiveElement(el)) return { target, metadata: { sensitive: true, inputType } };
  return { target, metadata: { filled, inputType } };
}
