/** Data table with optional row activation and a pager. */

import { type Child, h } from "../dom.ts";
import { fmtInt } from "../format.ts";

export interface Column<T> {
  title: string;
  cell: (row: T) => Child;
  cls?: string;
}

export function table<T>(rows: readonly T[], cols: Array<Column<T>>, opts: { onRow?: (row: T) => void; rowLabel?: (row: T) => string; caption?: string } = {}): HTMLElement {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data" },
      opts.caption ? h("caption", { class: "sr-only" }, opts.caption) : null,
      h("thead", null, h("tr", null, ...cols.map((c) => h("th", { scope: "col", class: c.cls }, c.title)))),
      h(
        "tbody",
        null,
        ...rows.map((r) => {
          const tr = h("tr", opts.onRow ? { class: "clickable", tabindex: 0, "aria-label": opts.rowLabel?.(r) } : null, ...cols.map((c) => h("td", { class: c.cls }, c.cell(r))));
          if (opts.onRow) {
            const act = opts.onRow;
            tr.addEventListener("click", (e) => {
              if ((e.target as Element).closest("a,button,input,select")) return;
              act(r);
            });
            tr.addEventListener("keydown", (e) => {
              if ((e as KeyboardEvent).key === "Enter") act(r);
            });
          }
          return tr;
        }),
      ),
    ),
  );
}

export function pager(total: number, offset: number, limit: number, go: (offset: number) => void): HTMLElement {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(total, offset + limit);
  return h(
    "nav",
    { class: "pager", "aria-label": "pagination" },
    h("button", { type: "button", class: "btn", disabled: offset <= 0, on: { click: () => go(Math.max(0, offset - limit)) } }, "← Prev"),
    h("span", null, `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(total)}`),
    h("button", { type: "button", class: "btn", disabled: to >= total, on: { click: () => go(offset + limit) } }, "Next →"),
  );
}
