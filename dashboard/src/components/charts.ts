/**
 * SVG charts (dataviz method): thin marks, 4px rounded data-ends square at the
 * baseline, hairline recessive grid, one series colour per chart (validated
 * palette, styles.css), per-mark hover/focus tooltips, legends for ≥ 2 series,
 * and a table elsewhere on every page carrying the same numbers.
 */

import { type Child, h, s } from "../dom.ts";
import { niceTicks, textWidth } from "../layout.ts";
import { fmtCompact, fmtInt } from "../format.ts";
import { attachTooltip, tipRows } from "./tooltip.ts";

/** Re-render `draw(width)` whenever the container's width changes. */
export function responsive(draw: (width: number) => Child, minWidth = 280): HTMLElement {
  const box = h("div", { class: "chart" });
  let last = -1;
  const render = () => {
    const w = Math.max(minWidth, Math.floor(box.clientWidth || minWidth));
    if (w === last) return;
    last = w;
    while (box.firstChild) box.removeChild(box.firstChild);
    const out = draw(w);
    if (out instanceof Node) box.appendChild(out);
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(render).observe(box);
  queueMicrotask(render);
  return box;
}

/** Horizontal bar path with a rounded data-end (right) and square baseline (left). */
export function hbarPath(x: number, y: number, w: number, th: number): string {
  const r = Math.max(0, Math.min(4, w / 2, th / 2));
  const x2 = x + Math.max(w, 0.5);
  return `M ${x} ${y} H ${x2 - r} Q ${x2} ${y} ${x2} ${y + r} V ${y + th - r} Q ${x2} ${y + th} ${x2 - r} ${y + th} H ${x} Z`;
}

/** Vertical column path, rounded top, square at the baseline `y0`. */
export function colPath(x: number, y0: number, w: number, hgt: number): string {
  const r = Math.max(0, Math.min(4, w / 2, hgt / 2));
  const top = y0 - Math.max(hgt, 0.5);
  return `M ${x} ${y0} V ${top + r} Q ${x} ${top} ${x + r} ${top} H ${x + w - r} Q ${x + w} ${top} ${x + w} ${top + r} V ${y0} Z`;
}

export interface BarDatum {
  label: string;
  value: number;
  /** Extra marker text before the label (e.g. a severity icon). */
  icon?: string;
  /** CSS class for the bar fill (default series-1). */
  fill?: string;
  href?: string;
}

/** Ranked horizontal bars: label column, bar, value at the tip. */
export function barList(data: readonly BarDatum[], opts: { unit?: string; title: string } = { title: "" }): HTMLElement {
  if (data.length === 0) return h("div", { class: "empty" }, "No data in this range.");
  return responsive((width) => {
    const rowH = 26;
    const th = 14;
    const labelW = Math.min(180, Math.max(...data.map((d) => textWidth(`${d.icon ? `${d.icon} ` : ""}${d.label}`, 12))) + 12);
    const valueW = 64;
    const plotW = Math.max(40, width - labelW - valueW);
    const max = Math.max(1, ...data.map((d) => d.value));
    const svg = s("svg", { width, height: data.length * rowH + 4, role: "img", "aria-label": opts.title, class: "viz" });
    data.forEach((d, i) => {
      const y = i * rowH + 2;
      const w = (d.value / max) * plotW;
      const g = s("g", { class: "mark", tabindex: 0, role: "listitem", "aria-label": `${d.label}: ${fmtInt(d.value)}${opts.unit ? ` ${opts.unit}` : ""}` });
      g.appendChild(s("rect", { x: 0, y, width, height: rowH, class: "hit" }));
      g.appendChild(s("text", { x: labelW - 8, y: y + rowH / 2 + 4, "text-anchor": "end", class: "t-secondary" }, `${d.icon ? `${d.icon} ` : ""}${d.label}`));
      if (d.value > 0) g.appendChild(s("path", { d: hbarPath(labelW, y + (rowH - th) / 2, w, th), class: d.fill ?? "fill-series-1" }));
      g.appendChild(s("text", { x: labelW + w + 6, y: y + rowH / 2 + 4, class: "t-primary num" }, fmtCompact(d.value)));
      attachTooltip(g, () => tipRows(d.label, [[fmtInt(d.value), opts.unit ?? ""]]));
      if (d.href) {
        const href = d.href;
        g.addEventListener("click", () => {
          location.hash = href;
        });
        g.addEventListener("keydown", (e) => {
          if ((e as KeyboardEvent).key === "Enter") location.hash = href;
        });
        g.classList.add("clickable");
      }
      svg.appendChild(g);
    });
    return svg;
  });
}

/** Columns over ordered categories (e.g. days) with a y axis and hairline grid. */
export function columnChart(points: ReadonlyArray<{ label: string; value: number }>, opts: { title: string; unit: string }): HTMLElement {
  if (points.length === 0) return h("div", { class: "empty" }, "No data in this range.");
  return responsive((width) => {
    const height = 180;
    const m = { top: 10, right: 8, bottom: 26, left: 44 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const max = Math.max(1, ...points.map((p) => p.value));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] as number;
    const y = (v: number) => m.top + plotH - (v / top) * plotH;
    const band = plotW / points.length;
    const colW = Math.max(2, Math.min(24, band - 2));
    const svg = s("svg", { width, height, role: "img", "aria-label": opts.title, class: "viz" });
    for (const t of ticks) {
      svg.appendChild(s("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "grid" }));
      svg.appendChild(s("text", { x: m.left - 6, y: y(t) + 4, "text-anchor": "end", class: "t-muted num" }, fmtCompact(t)));
    }
    const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 70))));
    points.forEach((p, i) => {
      const x = m.left + i * band + (band - colW) / 2;
      const g = s("g", { class: "mark", tabindex: 0, "aria-label": `${p.label}: ${fmtInt(p.value)} ${opts.unit}` });
      g.appendChild(s("rect", { x: m.left + i * band, y: m.top, width: band, height: plotH, class: "hit" }));
      if (p.value > 0) g.appendChild(s("path", { d: colPath(x, y(0), colW, y(0) - y(p.value)), class: "fill-series-1" }));
      attachTooltip(g, () => tipRows(p.label, [[fmtInt(p.value), opts.unit]]));
      svg.appendChild(g);
      if (i % every === 0) svg.appendChild(s("text", { x: x + colW / 2, y: height - 8, "text-anchor": "middle", class: "t-muted" }, p.label));
    });
    return svg;
  });
}

/** Two series side by side per category (A = series-1, B = series-2) with a legend. */
export function pairedBars(rows: ReadonlyArray<{ label: string; a: number | null; b: number | null }>, names: [string, string], fmt: (v: number) => string, title: string): HTMLElement {
  if (rows.length === 0) return h("div", { class: "empty" }, "Nothing to compare.");
  const legend = h(
    "div",
    { class: "legend" },
    h("span", { class: "legend-item" }, h("span", { class: "swatch fill-series-1" }), names[0]),
    h("span", { class: "legend-item" }, h("span", { class: "swatch fill-series-2" }), names[1]),
  );
  const chart = responsive((width) => {
    const th = 10;
    const rowH = th * 2 + 2 + 12; // two bars + 2px surface gap + air
    const labelW = Math.min(170, Math.max(...rows.map((r) => textWidth(r.label, 12))) + 12);
    const valueW = 72;
    const plotW = Math.max(40, width - labelW - valueW);
    const max = Math.max(1, ...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0]));
    const svg = s("svg", { width, height: rows.length * rowH + 4, role: "img", "aria-label": title, class: "viz" });
    rows.forEach((r, i) => {
      const y = i * rowH + 4;
      const g = s("g", { class: "mark", tabindex: 0, "aria-label": `${r.label}: ${names[0]} ${r.a === null ? "absent" : fmt(r.a)}, ${names[1]} ${r.b === null ? "absent" : fmt(r.b)}` });
      g.appendChild(s("rect", { x: 0, y: y - 4, width, height: rowH, class: "hit" }));
      g.appendChild(s("text", { x: labelW - 8, y: y + th + 4, "text-anchor": "end", class: "t-secondary" }, r.label));
      if (r.a !== null) g.appendChild(s("path", { d: hbarPath(labelW, y, (r.a / max) * plotW, th), class: "fill-series-1" }));
      else g.appendChild(s("text", { x: labelW + 4, y: y + th - 1, class: "t-muted small" }, "absent"));
      if (r.b !== null) g.appendChild(s("path", { d: hbarPath(labelW, y + th + 2, (r.b / max) * plotW, th), class: "fill-series-2" }));
      else g.appendChild(s("text", { x: labelW + 4, y: y + th * 2 + 1, class: "t-muted small" }, "absent"));
      attachTooltip(g, () =>
        tipRows(r.label, [
          [r.a === null ? "—" : fmt(r.a), names[0]],
          [r.b === null ? "—" : fmt(r.b), names[1]],
        ]),
      );
      svg.appendChild(g);
    });
    return svg;
  });
  return h("div", null, legend, chart);
}
