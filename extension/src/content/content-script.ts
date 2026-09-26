/**
 * Content script (Phase 1/2). Runs in the ISOLATED world on recordable origins
 * only, and only captures while a session is active (chrome.storage flag).
 *
 * Captures — structure only, redacted at source (docs/06):
 *  - click (closest interactive element), change (field descriptor + filled bit,
 *    never values; sensitive fields not read at all), submit (form + field count);
 *  - DOM mutations → debounced counts/selectors summary (no text, no characterData);
 *  - page state: active SPA view (data-view) changes + readyState.
 *
 * Listeners are passive + capture-phase and do no heavy work, so the page UI is
 * never blocked (Component 16).
 */

import { RECORDING_FLAG_KEY, type CapturePayload, type RecordingFlag } from "../common/messages.ts";
import { Debouncer } from "../recorder/debounce.ts";
import { DomSummaryAccumulator, type MutationLike } from "../recorder/dom-summary.ts";
import { buildSelector, describeElement, describeField, findInteractive, isSensitiveElement } from "./capture.ts";
import { pageEnvironment } from "../common/environment.ts";

const DOM_MAX_WAIT_MS = 5000;
const OBSERVED_ATTRIBUTES = ["class", "hidden", "aria-hidden", "aria-expanded", "data-view", "disabled", "open"];

let active = false;
let observer: MutationObserver | undefined;
let domDebouncer: Debouncer | undefined;
let lastView: string | undefined;
const summary = new DomSummaryAccumulator();

function page(): string {
  return location.pathname || "/";
}

function currentView(): string | undefined {
  const el = document.querySelector<HTMLElement>(".view.active[data-view]");
  return el?.dataset.view ?? undefined;
}

function send(payload: CapturePayload): void {
  try {
    void chrome.runtime.sendMessage({ type: "lab/capture", payload }).catch(() => undefined);
  } catch {
    detach(); // extension reloaded: this context is invalidated
  }
}

function capture(action: CapturePayload["action"], rest: Omit<CapturePayload, "action" | "page" | "view">): void {
  const view = currentView();
  send({ action, page: page(), ...(view !== undefined ? { view } : {}), ...rest });
}

function checkView(): void {
  const view = currentView();
  if (view === lastView) return;
  lastView = view;
  capture("page_state", { metadata: { readyState: document.readyState, view: view ?? null } });
}

function onClick(e: MouseEvent): void {
  const el = findInteractive(e.target instanceof Element ? e.target : null);
  if (!el) return;
  capture("click", { target: describeElement(el), metadata: {} });
  queueMicrotask(checkView);
}

function onChange(e: Event): void {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
  // Sensitive fields are never read — not even to compute "filled".
  const sensitive = isSensitiveElement(el);
  let filled = false;
  if (!sensitive) {
    filled = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value.length > 0;
  }
  const { target, metadata } = describeField(el, filled);
  capture("change", { target, metadata });
}

function onSubmit(e: SubmitEvent): void {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  capture("submit", { target: describeElement(form), metadata: { fields: form.elements.length } });
}

function toMutationLike(r: MutationRecord): MutationLike {
  const node = r.target instanceof Element ? r.target : r.target.parentElement;
  return {
    type: r.type,
    addedNodes: r.addedNodes.length,
    removedNodes: r.removedNodes.length,
    attributeName: r.attributeName,
    ...(node ? { targetSelector: buildSelector(node) } : {}),
  };
}

function emitDomSummary(): void {
  const s = summary.drain();
  if (s) capture("dom_change", { metadata: { ...s } });
  checkView();
}

function attach(flag: RecordingFlag): void {
  if (active) return;
  active = true;
  document.addEventListener("click", onClick, { capture: true, passive: true });
  document.addEventListener("change", onChange, { capture: true, passive: true });
  document.addEventListener("submit", onSubmit, { capture: true, passive: true });
  domDebouncer = new Debouncer(emitDomSummary, flag.domDebounceMs ?? 500, DOM_MAX_WAIT_MS);
  observer = new MutationObserver((records) => {
    summary.add(records.map(toMutationLike));
    domDebouncer?.trigger();
  });
  observer.observe(document.body ?? document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: OBSERVED_ATTRIBUTES,
  });
  lastView = currentView();
  capture("page_state", {
    metadata: { readyState: document.readyState, view: lastView ?? null, environment: pageEnvironment(window) },
  });
}

function detach(): void {
  if (!active) return;
  active = false;
  document.removeEventListener("click", onClick, { capture: true });
  document.removeEventListener("change", onChange, { capture: true });
  document.removeEventListener("submit", onSubmit, { capture: true });
  observer?.disconnect();
  observer = undefined;
  domDebouncer?.cancel();
  summary.drain();
}

void chrome.storage.local.get(RECORDING_FLAG_KEY).then((r) => {
  const flag = r[RECORDING_FLAG_KEY] as RecordingFlag | undefined;
  if (flag?.active) attach(flag);
});

chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[RECORDING_FLAG_KEY];
  if (area !== "local" || !change) return;
  const flag = change.newValue as RecordingFlag | undefined;
  if (flag?.active) attach(flag);
  else detach();
});
