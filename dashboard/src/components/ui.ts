/** Small shared UI pieces. Text only; identity is never colour-only. */

import { ANALYSIS_DISCLAIMER } from "../shared.ts";
import { type Child, h } from "../dom.ts";
import { label } from "../format.ts";

const SEVERITY_ICON: Record<string, string> = { info: "ℹ", warn: "▲", error: "✖" };
const STATUS_CLASS: Record<string, string> = {
  ok: "good",
  completed: "good",
  passed: "good",
  failed: "critical",
  error: "critical",
  aborted: "serious",
  stopped: "serious",
  denied: "serious",
  skipped: "neutral",
  running: "info",
  paused: "warning",
  pending: "neutral",
};

/** Severity with icon + label (status colours never carry meaning alone). */
export function severityBadge(sev: string): HTMLElement {
  const known = sev in SEVERITY_ICON ? sev : "info";
  return h("span", { class: `badge sev-${known}`, title: `severity: ${sev}` }, h("span", { class: "badge-icon", "aria-hidden": "true" }, SEVERITY_ICON[known] ?? "ℹ"), sev);
}

export function statusBadge(status: string): HTMLElement {
  const cls = STATUS_CLASS[status] ?? "neutral";
  const icon = cls === "good" ? "✔" : cls === "critical" ? "✖" : cls === "serious" || cls === "warning" ? "▲" : "•";
  return h("span", { class: `badge st-${cls}` }, h("span", { class: "badge-icon", "aria-hidden": "true" }, icon), status);
}

export function chip(text: string, cls = ""): HTMLElement {
  return h("span", { class: `chip ${cls}`.trim() }, text);
}

export function workflowChip(w: string | null | undefined): HTMLElement {
  return chip(label(w ?? "UNKNOWN"), "chip-wf");
}

export function link(href: string, text: Child, attrs: Record<string, string> = {}): HTMLElement {
  return h("a", { href, ...attrs }, text);
}

export function card(title: string | null, ...children: Child[]): HTMLElement {
  return h("section", { class: "card" }, title ? h("h2", { class: "card-title" }, title) : null, ...children);
}

export function statTile(name: string, value: string, sub?: string, href?: string): HTMLElement {
  const body = [h("div", { class: "tile-label" }, name), h("div", { class: "tile-value" }, value), sub ? h("div", { class: "tile-sub" }, sub) : null];
  return href ? h("a", { class: "tile", href }, ...body) : h("div", { class: "tile" }, ...body);
}

export function disclaimer(): HTMLElement {
  return h("aside", { class: "disclaimer", role: "note" }, h("strong", null, "Diagnostic observations only. "), ANALYSIS_DISCLAIMER);
}

export function empty(text: string): HTMLElement {
  return h("div", { class: "empty" }, text);
}

export function errorBox(err: unknown): HTMLElement {
  const msg = err instanceof Error ? err.message : String(err);
  return h("div", { class: "error-box", role: "alert" }, h("strong", null, "Request failed: "), msg);
}

export function loading(): HTMLElement {
  return h("div", { class: "loading", "aria-busy": "true" }, "Loading…");
}

export function pageHeader(title: string, subtitle?: Child, ...actions: Child[]): HTMLElement {
  return h(
    "header",
    { class: "page-header" },
    h("div", null, h("h1", null, title), subtitle ? h("p", { class: "subtitle" }, subtitle) : null),
    actions.length ? h("div", { class: "actions" }, ...actions) : null,
  );
}

export function kv(rows: Array<[string, Child]>): HTMLElement {
  return h("dl", { class: "kv" }, ...rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v ?? "—")]));
}

export function button(text: string, onClick: () => void, cls = ""): HTMLElement {
  return h("button", { type: "button", class: `btn ${cls}`.trim(), on: { click: () => onClick() } }, text);
}
