/**
 * Event detail drawer. Shows one stored (redacted) event, its parsed payload
 * as text, and the findings that cite it — every finding links back to exact
 * event ids, and every event links forward to the findings that used it.
 */

import type { Api } from "../api.ts";
import { h, jsonBlock, mount } from "../dom.ts";
import { eventSummary, fmtTime, label, parseData } from "../format.ts";
import { buildHash } from "../route.ts";
import { errorBox, kv, link, loading, severityBadge, workflowChip } from "./ui.ts";

let root: HTMLElement | undefined;
let lastFocus: Element | null = null;

function ensure(): HTMLElement {
  if (root) return root;
  root = h("aside", { class: "drawer", role: "dialog", "aria-modal": "false", "aria-labelledby": "drawer-title", hidden: true });
  document.body.appendChild(root);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root && !root.hidden) closeDrawer();
  });
  return root;
}

export function closeDrawer(): void {
  if (!root || root.hidden) return;
  root.hidden = true;
  document.body.classList.remove("drawer-open");
  if (lastFocus instanceof HTMLElement) lastFocus.focus();
}

export async function openEventDrawer(api: Api, id: string): Promise<void> {
  const el = ensure();
  lastFocus = document.activeElement;
  const close = h("button", { type: "button", class: "btn btn-ghost drawer-close", "aria-label": "Close event details", on: { click: closeDrawer } }, "✕");
  mount(el, h("header", { class: "drawer-head" }, h("h2", { id: "drawer-title" }, "Event"), close), loading());
  el.hidden = false;
  document.body.classList.add("drawer-open");
  // Move focus after the triggering key event completes: focusing the close
  // button during an Enter keydown would let that same keypress activate it.
  setTimeout(() => close.focus(), 0);
  try {
    const { event } = await api.event(id);
    const data = parseData(event.data);
    const citing = (await api.findings({ session: event.session_id, limit: 500 })).findings.filter((f) => f.event_ids.includes(event.id) || f.evidence.some((e) => e.event_id === event.id));
    mount(
      el,
      h("header", { class: "drawer-head" }, h("h2", { id: "drawer-title" }, label(event.kind)), close),
      h("p", { class: "drawer-summary" }, eventSummary(event.kind, data)),
      kv([
        ["Event id", h("code", null, event.id)],
        ["Session", link(buildHash("sessions", {}, event.session_id), event.session_id)],
        ["Sequence", `#${event.seq}`],
        ["Time", fmtTime(event.ts)],
        ["Tab", event.tab_id === null ? "— (session)" : String(event.tab_id)],
        ["Kind / category", `${event.kind} / ${event.category}`],
        ["Workflow", workflowChip(event.workflow)],
        ["Severity", severityBadge(event.severity)],
        ["Redacted at rest", event.redacted === 1 ? "yes" : "no"],
      ]),
      h(
        "div",
        { class: "drawer-links" },
        link(buildHash("timeline", { session: event.session_id, focus: event.id }), "Show on timeline"),
        link(buildHash("events", { session: event.session_id }), "All events of this session"),
      ),
      h("h3", null, `Findings citing this event (${citing.length})`),
      citing.length
        ? h("ul", { class: "plain" }, ...citing.map((f) => h("li", null, severityBadge(f.severity), " ", link(buildHash("findings", {}, f.finding_id), f.title), h("span", { class: "muted" }, ` · ${f.rule_id}`))))
        : h("p", { class: "muted" }, "No persisted finding cites this event."),
      h("h3", null, "Payload (redacted)"),
      jsonBlock(data),
    );
  } catch (err) {
    mount(el, h("header", { class: "drawer-head" }, h("h2", { id: "drawer-title" }, "Event"), close), errorBox(err));
  }
  // Re-mounting the header drops focus; keep it inside the open drawer.
  if (!el.hidden && !el.contains(document.activeElement)) setTimeout(() => close.focus(), 0);
}
