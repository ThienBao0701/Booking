/**
 * MV3 service worker (Phase 1): owns the recorder, the bridge and all
 * lifecycle wiring.
 *
 *  - session lifecycle: start/stop from the popup; the active session survives
 *    worker restarts (persisted descriptor + seq with a safety gap);
 *  - tab lifecycle + navigation: only tabs on recordable origins (loopback or an
 *    operator-granted origin) are tracked; leaving scope is recorded without
 *    recording where the tab went;
 *  - content captures: validated, re-scoped by the *sender* URL (not the page's
 *    claim), then recorded;
 *  - delivery: debounced/batched by the recorder, backstopped by a 30 s alarm;
 *    reconnect triggers an immediate flush;
 *  - transparency: a "REC" badge is shown whenever recording is active.
 *
 * Listeners are registered synchronously at top level (MV3 requirement); state is
 * loaded lazily through `ctx()`.
 */

import { isRecordableUrl, originToMatchPattern, type ExtensionConfig } from "../common/config.ts";
import { isContentMessage, isUiMessage, type ContentMessage, type UiMessage } from "../common/messages.ts";
import { pagePath, urlHost } from "../common/paths.ts";
import { browserEnvironment, type NavigatorLike } from "../common/environment.ts";
import { BridgeClient, type BridgeState, type Transport, fetchTransport } from "../bridge/client.ts";
import { type AutoTransport, NativeChannel, type PortLike, autoTransport } from "../bridge/native-transport.ts";
import { Debouncer } from "../recorder/debounce.ts";
import { Recorder } from "../recorder/recorder.ts";
import { IdbQueue } from "../storage/idb-queue.ts";
import * as store from "../storage/state.ts";

const FLUSH_ALARM = "lab-flush";
/** On worker restart, resume seq this far ahead so ordering stays strictly increasing. */
const SEQ_RESTART_GAP = 1000;
const TARGET_SCRIPT_ID = "lab-target-origins";

interface Ctx {
  config: ExtensionConfig;
  recorder: Recorder;
  bridge: BridgeClient;
  trackedTabs: Set<number>;
  bridgeState: BridgeState;
  bridgeDetail: string | undefined;
  /** Phase 14: the transport the bridge uses (native host, HTTP loopback, or auto). */
  link: { transport: Transport; native: NativeChannel | undefined; auto: AutoTransport | undefined };
  persistSeq: Debouncer;
}

let ctxPromise: Promise<Ctx> | undefined;
function ctx(): Promise<Ctx> {
  ctxPromise ??= init();
  return ctxPromise;
}

/** Native messaging (Phase 14) with HTTP loopback kept as the fallback. */
function makeLink(config: ExtensionConfig): Ctx["link"] {
  if (config.transport === "http") return { transport: fetchTransport, native: undefined, auto: undefined };
  const native = new NativeChannel({
    connect: (name) => chrome.runtime.connectNative(name) as unknown as PortLike,
    lastError: () => chrome.runtime.lastError?.message,
    extensionVersion: chrome.runtime.getManifest().version,
  });
  if (config.transport === "native") return { transport: native.transport, native, auto: undefined };
  const auto = autoTransport({ native, http: fetchTransport });
  return { transport: auto.transport, native, auto };
}

function transportInfo(c: Ctx): { mode: string; active: string; native: string; detail: string | null } {
  const native = c.link.native?.status;
  return {
    mode: c.config.transport,
    active: c.link.auto ? c.link.auto.kind() : c.config.transport,
    native: native?.state ?? "off",
    detail: c.link.auto?.fallbackReason() ?? native?.detail ?? null,
  };
}

function makeBridge(c: Ctx, config: ExtensionConfig): BridgeClient {
  c.link?.native?.close();
  c.link = makeLink(config);
  return new BridgeClient({
    serviceUrl: config.serviceUrl,
    token: config.token,
    transport: c.link.transport,
    onStateChange: (s, detail) => {
      c.bridgeState = s;
      c.bridgeDetail = detail;
      void updateBadge(c);
    },
    onReconnect: () => void c.recorder.flush({ manual: true }),
  });
}

async function init(): Promise<Ctx> {
  const config = await store.loadConfig();
  const c = {
    config,
    trackedTabs: await store.loadTrackedTabs(),
    bridgeState: "idle",
    bridgeDetail: undefined,
  } as Ctx;
  c.bridge = makeBridge(c, config);
  c.recorder = new Recorder({
    queue: new IdbQueue(),
    sink: c.bridge,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    maxQueue: config.maxQueue,
  });
  c.persistSeq = new Debouncer(() => void persistSession(c), 1000, 5000);

  const persisted = await store.loadSession();
  if (persisted) {
    c.recorder.restoreSession(persisted.desc, persisted.nextSeq + SEQ_RESTART_GAP);
    c.bridge.declareSession(persisted.desc);
  }
  c.bridge.restorePendingEnds(await store.loadPendingEnds());
  await ensureAlarm();
  await updateBadge(c);
  return c;
}

async function persistSession(c: Ctx): Promise<void> {
  const desc = c.recorder.session;
  await store.saveSession(desc ? { desc, nextSeq: c.recorder.stats.nextSeq } : undefined);
}

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(FLUSH_ALARM))) {
    await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 0.5 });
  }
}

async function updateBadge(c: Ctx): Promise<void> {
  const recording = c.recorder.session !== undefined;
  const degraded = recording && c.bridgeState !== "connected" && c.bridgeState !== "idle" && c.bridgeState !== "connecting";
  await chrome.action.setBadgeText({ text: recording ? "REC" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: degraded ? "#b26a00" : "#c62828" });
  await chrome.action.setTitle({
    title: recording
      ? `Recording (session ${c.recorder.session?.sessionId ?? ""}) — bridge: ${c.bridgeState}`
      : "Browser Automation Lab — not recording",
  });
}

/** Register the content script for operator-granted target origins (loopback is static in the manifest). */
async function syncTargetScripts(origins: readonly string[]): Promise<void> {
  const patterns: string[] = [];
  for (const o of origins) {
    const pattern = originToMatchPattern(o);
    if (!patterns.includes(pattern) && (await chrome.permissions.contains({ origins: [pattern] }))) patterns.push(pattern);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [TARGET_SCRIPT_ID] });
  if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [TARGET_SCRIPT_ID] });
  if (patterns.length > 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: TARGET_SCRIPT_ID,
        matches: patterns,
        js: ["content/content-script.js"],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  }
}

function track(c: Ctx, tabId: number): void {
  if (c.trackedTabs.has(tabId)) return;
  c.trackedTabs.add(tabId);
  void store.saveTrackedTabs(c.trackedTabs);
}

function untrack(c: Ctx, tabId: number): void {
  if (!c.trackedTabs.delete(tabId)) return;
  void store.saveTrackedTabs(c.trackedTabs);
}

function recorded(c: Ctx): void {
  c.persistSeq.trigger();
}

// ---- content captures ----

async function onCapture(msg: ContentMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  const c = await ctx();
  if (!c.recorder.session) return;
  const url = sender.url ?? sender.tab?.url; // the browser's view of the frame, not the page's claim
  if (!isRecordableUrl(url, c.config.targetOrigins)) return;
  const tabId = sender.tab?.id;
  if (tabId !== undefined) track(c, tabId);
  const p = msg.payload;
  c.recorder.record({
    action: p.action,
    page: pagePath(url),
    tabId,
    view: p.view,
    target: p.target,
    metadata: p.metadata,
  });
  recorded(c);
}

// ---- UI commands ----

async function onUi(msg: UiMessage): Promise<unknown> {
  const c = await ctx();
  switch (msg.type) {
    case "lab/ui/status": {
      const health = await c.bridge.health();
      return {
        ok: true,
        recording: c.recorder.session !== undefined,
        session: c.recorder.session ?? null,
        stats: c.recorder.stats,
        bridge: { state: c.bridgeState, detail: c.bridgeDetail ?? null },
        transport: transportInfo(c),
        health,
        config: { serviceUrl: c.config.serviceUrl, paired: c.config.token.length > 0, targetOrigins: c.config.targetOrigins },
      };
    }
    case "lab/ui/start": {
      if (c.recorder.session) return { ok: true, session: c.recorder.session };
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const host = isRecordableUrl(tab?.url, c.config.targetOrigins) ? urlHost(tab?.url) : undefined;
      const desc = c.recorder.startSession({
        mode: c.config.safetyMode,
        target: { kind: "observe", ...(host ? { host } : {}) },
        environment: browserEnvironment(navigator as NavigatorLike, chrome.runtime.getManifest().version),
      });
      c.bridge.declareSession(desc);
      if (tab?.id !== undefined && host) track(c, tab.id);
      await persistSession(c);
      await store.setRecordingFlag({ active: true, sessionId: desc.sessionId, domDebounceMs: c.config.domDebounceMs });
      await updateBadge(c);
      void c.recorder.flush({ manual: true });
      return { ok: true, session: desc };
    }
    case "lab/ui/stop": {
      await store.setRecordingFlag({ active: false });
      const ended = await c.recorder.endSession();
      if (ended) {
        await c.bridge.endSession(ended.sessionId, Date.now());
        await store.savePendingEnds(c.bridge.pendingEnds);
      }
      c.persistSeq.cancel();
      await store.saveSession(undefined);
      await updateBadge(c);
      return { ok: true, ended: ended ?? null, stats: c.recorder.stats };
    }
    case "lab/ui/flush":
      return { ok: true, result: await c.recorder.flush({ manual: true }), stats: c.recorder.stats };
    case "lab/ui/capture": {
      if (!c.recorder.session) return { ok: false, error: "not recording" };
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id === undefined || !isRecordableUrl(tab.url, c.config.targetOrigins)) {
        return { ok: false, error: "active tab is not a recordable origin" };
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      const ev = c.recorder.record({
        action: "screenshot",
        page: pagePath(tab.url),
        tabId: tab.id,
        metadata: { sha256, bytes: bytes.length, format: "png", trigger: "user" },
      });
      recorded(c);
      // Phase 12: the image itself is uploaded only if the service has storage
      // enabled (off by default); the event (hash + size) is always recorded.
      let image: { stored: boolean; reason?: string } = { stored: false, reason: "not uploaded" };
      const info = await c.bridge.handshake().catch(() => undefined);
      if (ev && info?.screenshots.enabled && bytes.length <= info.screenshots.maxImageBytes) {
        await c.recorder.flush({ manual: true }); // the event must exist before its image
        image = await c.bridge.uploadScreenshot({ sessionId: ev.session_id, eventId: ev.event_id, sha256, dataBase64: base64 });
      } else if (info && !info.screenshots.enabled) {
        image = { stored: false, reason: "storage disabled in the service (hash only)" };
      } else if (info) {
        image = { stored: false, reason: "image larger than the service limit (hash only)" };
      }
      return { ok: true, sha256, bytes: bytes.length, image };
    }
    case "lab/ui/testConnection": {
      const health = await c.bridge.health();
      const state = await c.bridge.connect();
      return { ok: state === "connected", health, state, detail: c.bridgeDetail ?? null };
    }
  }
}

// ---- listeners (top level) ----

chrome.runtime.onInstalled.addListener(() => {
  void ctx().then(async (c) => {
    await ensureAlarm();
    await syncTargetScripts(c.config.targetOrigins);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void ctx().then((c) => c.bridge.connect());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== FLUSH_ALARM) return;
  void ctx().then(async (c) => {
    if (c.bridgeState === "offline") await c.bridge.connect();
    await c.recorder.flush();
    await store.savePendingEnds(c.bridge.pendingEnds);
  });
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // only our own extension contexts
  if (isContentMessage(msg)) {
    void onCapture(msg, sender);
    return false;
  }
  if (isUiMessage(msg)) {
    onUi(msg).then(sendResponse, (err: unknown) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  void ctx().then((c) => {
    if (!c.recorder.session) return;
    const url = info.url ?? tab.url;
    if (!isRecordableUrl(url, c.config.targetOrigins)) {
      if (info.url && c.trackedTabs.has(tabId)) {
        // Left the recordable scope: note it, but do not record where it went.
        c.recorder.record({ action: "navigate", page: "/", tabId, metadata: { leftScope: true } });
        untrack(c, tabId);
        recorded(c);
      }
      return;
    }
    track(c, tabId);
    if (info.url) c.recorder.record({ action: "navigate", page: pagePath(url), tabId, metadata: { host: urlHost(url) ?? null } });
    if (info.status === "complete") c.recorder.record({ action: "page_load", page: pagePath(url), tabId, metadata: {} });
    recorded(c);
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  void ctx().then((c) => {
    if (!c.recorder.session || tab.id === undefined) return;
    const openedFromTracked = tab.openerTabId !== undefined && c.trackedTabs.has(tab.openerTabId);
    if (!openedFromTracked && !isRecordableUrl(tab.pendingUrl ?? tab.url, c.config.targetOrigins)) return;
    track(c, tab.id);
    c.recorder.record({ action: "tab_created", page: pagePath(tab.pendingUrl ?? tab.url), tabId: tab.id, metadata: { openedFromTracked } });
    recorded(c);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ctx().then((c) => {
    if (!c.recorder.session || !c.trackedTabs.has(tabId)) return;
    c.recorder.record({ action: "tab_activated", page: "/", tabId, metadata: {} });
    recorded(c);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ctx().then((c) => {
    if (!c.trackedTabs.has(tabId)) return;
    if (c.recorder.session) {
      c.recorder.record({ action: "tab_closed", page: "/", tabId, metadata: {} });
      recorded(c);
    }
    untrack(c, tabId);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[store.CONFIG_KEY]) return;
  void ctx().then(async (c) => {
    const next = await store.loadConfig();
    const bridgeChanged = next.serviceUrl !== c.config.serviceUrl || next.token !== c.config.token || next.transport !== c.config.transport;
    c.config = next;
    if (bridgeChanged) {
      const pending = c.bridge.pendingEnds;
      c.bridge.close();
      c.bridge = makeBridge(c, next);
      c.bridge.restorePendingEnds(pending);
      if (c.recorder.session) c.bridge.declareSession(c.recorder.session);
      c.recorder.setSink(c.bridge);
      void c.recorder.flush({ manual: true });
    }
    await syncTargetScripts(next.targetOrigins);
  });
});

chrome.permissions.onRemoved.addListener(() => {
  void ctx().then((c) => syncTargetScripts(c.config.targetOrigins));
});
