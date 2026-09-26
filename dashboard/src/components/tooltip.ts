/**
 * One shared tooltip. Enhances, never gates: every value it shows is also in a
 * table or label. Content is built as text; shown on hover and keyboard focus.
 */

import { type Child, h, mount } from "../dom.ts";

let tip: HTMLElement | undefined;

function el(): HTMLElement {
  if (!tip) {
    tip = h("div", { class: "tooltip", role: "tooltip", hidden: true });
    document.body.appendChild(tip);
  }
  return tip;
}

function place(x: number, y: number): void {
  const t = el();
  const pad = 12;
  const r = t.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, x + pad);
  const top = y + pad + r.height > window.innerHeight ? y - r.height - pad : y + pad;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}

/** Tooltip rows: value first (strong), then the label. */
export function tipRows(title: string, rows: Array<[string, string]>): Child[] {
  return [h("div", { class: "tip-title" }, title), ...rows.map(([v, l]) => h("div", { class: "tip-row" }, h("strong", null, v), " ", h("span", null, l)))];
}

export function attachTooltip(target: Element, content: () => Child[]): void {
  const show = (x: number, y: number) => {
    const t = el();
    mount(t, ...content());
    t.hidden = false;
    place(x, y);
  };
  const hide = () => {
    el().hidden = true;
  };
  target.addEventListener("pointermove", (e) => show((e as PointerEvent).clientX, (e as PointerEvent).clientY));
  target.addEventListener("pointerleave", hide);
  target.addEventListener("focus", () => {
    const r = target.getBoundingClientRect();
    show(r.left + r.width / 2, r.top);
  });
  target.addEventListener("blur", hide);
}

export function hideTooltip(): void {
  if (tip) tip.hidden = true;
}
