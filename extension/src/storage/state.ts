/** chrome.storage-backed persistence for config, the active session and bridge state. */

import { DEFAULT_CONFIG, type ExtensionConfig, validateConfig } from "../common/config.ts";
import { RECORDING_FLAG_KEY, type RecordingFlag } from "../common/messages.ts";
import type { SessionDescriptor } from "../recorder/recorder.ts";

export const CONFIG_KEY = "lab.config";
const SESSION_KEY = "lab.session";
const PENDING_ENDS_KEY = "lab.pendingEnds";
const TRACKED_TABS_KEY = "lab.trackedTabs";

export interface PersistedSession {
  desc: SessionDescriptor;
  nextSeq: number;
}

/** Load config; any invalid stored field falls back to its default (token kept). */
export async function loadConfig(): Promise<ExtensionConfig> {
  const raw = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as Partial<ExtensionConfig> | undefined;
  const merged = validateConfig({ ...DEFAULT_CONFIG, ...(raw ?? {}) });
  if (merged.ok) return merged.value;
  return { ...DEFAULT_CONFIG, token: typeof raw?.token === "string" ? raw.token : "" };
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

export async function loadSession(): Promise<PersistedSession | undefined> {
  return (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY] as PersistedSession | undefined;
}

export async function saveSession(s: PersistedSession | undefined): Promise<void> {
  if (s) await chrome.storage.local.set({ [SESSION_KEY]: s });
  else await chrome.storage.local.remove(SESSION_KEY);
}

export async function setRecordingFlag(flag: RecordingFlag): Promise<void> {
  await chrome.storage.local.set({ [RECORDING_FLAG_KEY]: flag });
}

export async function loadPendingEnds(): Promise<Array<{ sessionId: string; endedAt: number }>> {
  const v = (await chrome.storage.local.get(PENDING_ENDS_KEY))[PENDING_ENDS_KEY];
  return Array.isArray(v) ? (v as Array<{ sessionId: string; endedAt: number }>) : [];
}

export async function savePendingEnds(items: Array<{ sessionId: string; endedAt: number }>): Promise<void> {
  await chrome.storage.local.set({ [PENDING_ENDS_KEY]: items });
}

/** Tracked tabs live in session storage: cleared when the browser closes. */
export async function loadTrackedTabs(): Promise<Set<number>> {
  const v = (await chrome.storage.session.get(TRACKED_TABS_KEY))[TRACKED_TABS_KEY];
  return new Set(Array.isArray(v) ? (v as number[]) : []);
}

export async function saveTrackedTabs(tabs: Set<number>): Promise<void> {
  await chrome.storage.session.set({ [TRACKED_TABS_KEY]: [...tabs] });
}
