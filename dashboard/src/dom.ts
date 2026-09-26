/**
 * Minimal DOM builder. Every string child becomes a Text node and attributes
 * go through setAttribute, so recorded data can never be parsed as HTML
 * (the lint and the build forbid HTML sinks in the dashboard).
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Handler = (ev: Event) => void;

export interface Attrs {
  [name: string]: string | number | boolean | undefined | null | Handler | Record<string, Handler>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === "string" || typeof c === "number") el.appendChild(document.createTextNode(String(c)));
    else el.appendChild(c);
  }
}

/** Only in-app hash links and same-origin API/report paths are ever rendered as hrefs. */
export function safeHref(v: string): string {
  return /^#\//.test(v) || /^\/v1\/[A-Za-z0-9/_.?=&%:-]*$/.test(v) || /^\/dashboard\//.test(v) ? v : "#/overview";
}

function applyAttrs(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "on" && typeof v === "object") {
      for (const [ev, fn] of Object.entries(v as Record<string, Handler>)) el.addEventListener(ev, fn);
      continue;
    }
    if (typeof v === "function") continue;
    if (/^on/i.test(k)) continue; // never inline handlers
    if (k === "href") {
      el.setAttribute("href", safeHref(String(v)));
      continue;
    }
    el.setAttribute(k, v === true ? "" : String(v));
  }
}

export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  applyAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

export function s(tag: string, attrs?: Attrs | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

/** Pretty JSON inside <pre>, as text. */
export function jsonBlock(v: unknown): HTMLElement {
  return h("pre", { class: "json" }, JSON.stringify(v, null, 2));
}
