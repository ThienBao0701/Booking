/**
 * Typed message protocol between content script, popup/options and the service
 * worker. Every inbound message is shape-checked before use (defense in depth).
 */

import type { ElementDescriptor, RecordedAction } from "../shared.ts";

/** Actions a content script may report. Tab/session/screenshot events originate in the service worker. */
export const CONTENT_ACTIONS = [
  "click",
  "change",
  "submit",
  "dom_change",
  "page_load",
  "page_state",
  "error",
] as const satisfies readonly RecordedAction[];
export type ContentAction = (typeof CONTENT_ACTIONS)[number];

export interface CapturePayload {
  action: ContentAction;
  /** Path only (no query / fragment). */
  page: string;
  /** Active SPA view, when the page exposes one (e.g. mock Extranet data-view). */
  view?: string;
  target?: ElementDescriptor;
  metadata: Record<string, unknown>;
}

export type ContentMessage = { type: "lab/capture"; payload: CapturePayload };

export type UiMessage =
  | { type: "lab/ui/status" }
  | { type: "lab/ui/start" }
  | { type: "lab/ui/stop" }
  | { type: "lab/ui/flush" }
  | { type: "lab/ui/capture" }
  | { type: "lab/ui/testConnection" };

/** chrome.storage.local key content scripts watch to know whether to record. */
export const RECORDING_FLAG_KEY = "lab.recording";
export interface RecordingFlag {
  active: boolean;
  sessionId?: string;
  domDebounceMs?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isContentMessage(m: unknown): m is ContentMessage {
  if (!isObj(m) || m.type !== "lab/capture" || !isObj(m.payload)) return false;
  const p = m.payload;
  return (
    typeof p.action === "string" &&
    (CONTENT_ACTIONS as readonly string[]).includes(p.action) &&
    typeof p.page === "string" &&
    p.page.length <= 2048 &&
    (p.view === undefined || typeof p.view === "string") &&
    (p.target === undefined || isObj(p.target)) &&
    isObj(p.metadata)
  );
}

const UI_TYPES = new Set([
  "lab/ui/status",
  "lab/ui/start",
  "lab/ui/stop",
  "lab/ui/flush",
  "lab/ui/capture",
  "lab/ui/testConnection",
]);

export function isUiMessage(m: unknown): m is UiMessage {
  return isObj(m) && typeof m.type === "string" && UI_TYPES.has(m.type);
}
