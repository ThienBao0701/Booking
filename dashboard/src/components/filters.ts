/**
 * The filter row (one row, above the content it scopes). Filters live in the
 * route parameters, so they are shareable and survive reloads.
 */

import { EVENT_KINDS, FINDING_CATEGORIES, SEVERITIES, WORKFLOW_LABELS } from "../shared.ts";
import { h } from "../dom.ts";
import { label } from "../format.ts";

export type FilterKey = "range" | "session" | "workflow" | "severity" | "kind" | "category" | "rule" | "q";

export interface FilterBarOpts {
  params: Record<string, string>;
  show: FilterKey[];
  /** Recent session ids for the session picker. */
  sessions?: string[];
  onChange: (next: Record<string, string>) => void;
}

function select(name: string, title: string, value: string | undefined, options: Array<[string, string]>, onChange: (v: string) => void): HTMLElement {
  const el = h(
    "select",
    { name, "aria-label": title, on: { change: (e) => onChange((e.target as HTMLSelectElement).value) } },
    ...options.map(([v, t]) => h("option", { value: v, selected: v === (value ?? "") }, t)),
  );
  return h("label", { class: "filter" }, h("span", { class: "filter-label" }, title), el);
}

export function filterBar(o: FilterBarOpts): HTMLElement {
  const p = o.params;
  const set = (patch: Record<string, string>) => {
    const next: Record<string, string> = { ...p, ...patch };
    delete next.offset;
    for (const [k, v] of Object.entries(next)) if (v === "") delete next[k];
    o.onChange(next);
  };
  const items: HTMLElement[] = [];
  for (const key of o.show) {
    switch (key) {
      case "range": {
        items.push(
          select("range", "Date range", p.range ?? "", [
            ["", "All time"],
            ["24h", "Last 24 hours"],
            ["7d", "Last 7 days"],
            ["30d", "Last 30 days"],
            ["90d", "Last 90 days"],
            ["custom", "Custom range…"],
          ], (v) => set({ range: v, ...(v !== "custom" ? { from: "", to: "" } : {}) })),
        );
        if (p.range === "custom") {
          for (const [k, t] of [["from", "From"], ["to", "To"]] as const) {
            items.push(
              h("label", { class: "filter" }, h("span", { class: "filter-label" }, t), h("input", { type: "date", name: k, value: p[k] ?? "", on: { change: (e) => set({ [k]: (e.target as HTMLInputElement).value }) } })),
            );
          }
        }
        break;
      }
      case "session": {
        const listId = "session-options";
        items.push(
          h(
            "label",
            { class: "filter" },
            h("span", { class: "filter-label" }, "Session"),
            h("input", {
              type: "search",
              name: "session",
              list: listId,
              placeholder: "any session",
              value: p.session ?? "",
              spellcheck: "false",
              on: { change: (e) => set({ session: (e.target as HTMLInputElement).value.trim() }) },
            }),
            h("datalist", { id: listId }, ...(o.sessions ?? []).map((id) => h("option", { value: id }))),
          ),
        );
        break;
      }
      case "workflow":
        items.push(select("workflow", "Workflow", p.workflow, [["", "Any workflow"], ...WORKFLOW_LABELS.map((w): [string, string] => [w, label(w)])], (v) => set({ workflow: v })));
        break;
      case "severity":
        items.push(select("severity", "Severity", p.severity, [["", "Any severity"], ...SEVERITIES.map((s): [string, string] => [s, s])], (v) => set({ severity: v })));
        break;
      case "kind":
        items.push(select("kind", "Event kind", p.kind, [["", "Any kind"], ...EVENT_KINDS.map((k): [string, string] => [k, label(k)])], (v) => set({ kind: v })));
        break;
      case "category":
        items.push(select("category", "Category", p.category, [["", "Any category"], ...FINDING_CATEGORIES.map((c): [string, string] => [c, label(c)])], (v) => set({ category: v })));
        break;
      case "rule":
        items.push(
          h("label", { class: "filter" }, h("span", { class: "filter-label" }, "Rule"), h("input", { type: "search", name: "rule", placeholder: "rule id", value: p.rule ?? "", spellcheck: "false", on: { change: (e) => set({ rule: (e.target as HTMLInputElement).value.trim().toUpperCase() }) } })),
        );
        break;
      case "q":
        items.push(
          h("label", { class: "filter filter-q" }, h("span", { class: "filter-label" }, "Search"), h("input", { type: "search", name: "q", placeholder: "Search…", value: p.q ?? "", maxlength: 200, on: { change: (e) => set({ q: (e.target as HTMLInputElement).value.trim() }) } })),
        );
        break;
    }
  }
  const active = o.show.some((k) => p[k] !== undefined) || p.from !== undefined || p.to !== undefined;
  return h(
    "div",
    { class: "filter-bar", role: "search" },
    ...items,
    active
      ? h("button", { type: "button", class: "btn btn-ghost", on: { click: () => o.onChange(Object.fromEntries(Object.entries(p).filter(([k]) => ![...o.show, "from", "to", "offset"].includes(k as FilterKey)))) } }, "Clear filters")
      : null,
  );
}
