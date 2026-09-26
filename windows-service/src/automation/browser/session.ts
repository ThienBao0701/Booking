/**
 * BrowserSession (Phase 11): one launched browser + one isolated context bound
 * to a BrowserTargetPolicy. Owns tab management and page lifecycle:
 *   - every request is checked against the policy before it leaves the browser
 *     (blocked requests are aborted and logged — origin + path only);
 *   - in-flight requests are tracked so actions can wait for the page to settle;
 *   - JavaScript dialogs are dismissed (and logged) so a run never hangs;
 *   - crashes, closed tabs and a disconnected browser surface as classified errors.
 * Downloads are refused. Nothing about the browser is disguised.
 */

import { redactText } from "../../shared.ts";
import type { AdapterBrowser, AdapterContext, AdapterPage, AdapterRequest, BrowserAdapter } from "./adapter.ts";
import { BrowserError, classifyError } from "./errors.ts";
import type { BrowserTargetPolicy } from "./target-policy.ts";
import { EgressProxy } from "./egress-proxy.ts";

export interface SessionLaunchOptions {
  headless?: boolean;
  executablePath?: string | undefined;
  launchTimeoutMs?: number;
  /** Route all browser traffic through a loopback EgressProxy (default true). */
  egressProxy?: boolean;
}

export interface SessionLogEntry {
  at: number;
  type: "launched" | "tab.opened" | "tab.closed" | "tab.crashed" | "loaded" | "dialog.dismissed" | "request.blocked" | "disconnected" | "closed";
  tabId?: string;
  detail?: string;
}

export interface BlockedRequest {
  at: number;
  /** Origin + path (query and fragment dropped, redacted). */
  url: string;
  isNavigation: boolean;
  resourceType: string;
  reason: string;
}

interface Tab {
  id: string;
  page: AdapterPage;
  crashed: boolean;
  closed: boolean;
}

const MAX_LOG = 500;
const MAX_BLOCKED = 200;

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return redactText(`${u.origin}${u.pathname}`).slice(0, 300);
  } catch {
    return redactText(url.split(/[?#]/)[0] ?? "").slice(0, 300);
  }
}

export class BrowserSession {
  readonly policy: BrowserTargetPolicy;
  readonly adapterName: string;
  #browser: AdapterBrowser;
  #context: AdapterContext;
  #proxy: EgressProxy | undefined;
  #tabs = new Map<string, Tab>();
  #active: string | undefined;
  #seq = 0;
  #pending = new Set<AdapterRequest>();
  #lastActivity = 0;
  #closed = false;
  #disconnected = false;
  #log: SessionLogEntry[] = [];
  #blocked: BlockedRequest[] = [];
  #blockedCount = 0;
  #blockedNavigations = 0;
  #clock: () => number;

  private constructor(adapterName: string, policy: BrowserTargetPolicy, browser: AdapterBrowser, context: AdapterContext, clock: () => number) {
    this.adapterName = adapterName;
    this.policy = policy;
    this.#browser = browser;
    this.#context = context;
    this.#clock = clock;
    this.#lastActivity = clock();
  }

  /**
   * Launch a browser for an already-authorized policy. The target is re-checked
   * against the allowlist before the adapter is touched.
   */
  static async start(adapter: BrowserAdapter, policy: BrowserTargetPolicy, opts: SessionLaunchOptions = {}, clock: () => number = Date.now): Promise<BrowserSession> {
    const pre = policy.checkNavigation(policy.baseUrl);
    if (!pre.allowed) throw new BrowserError("NAVIGATION_BLOCKED", "navigation_blocked", pre.reason);
    // Egress enforcement: every hop (redirects, tunnels, WebSockets) is checked here.
    let blockedEarly: Array<{ url: string; kind: string; reason: string }> = [];
    let session: BrowserSession | undefined;
    const proxy =
      opts.egressProxy === false
        ? undefined
        : new EgressProxy({
            allowOrigin: (origin) => policy.checkEgress(origin),
            onBlocked: (b) => (session ? session.#egressBlocked(b) : blockedEarly.push(b)),
          });
    if (proxy) await proxy.start();
    let browser: AdapterBrowser;
    try {
      browser = await adapter.launch({ headless: opts.headless ?? true, executablePath: opts.executablePath, timeoutMs: opts.launchTimeoutMs ?? 30_000, proxyServer: proxy?.url });
    } catch (err) {
      await proxy?.close();
      const e = classifyError(err);
      throw new BrowserError(e.code === "UNSUPPORTED" ? "UNSUPPORTED" : "TARGET_ERROR", e.category === "unknown" ? "launch_failed" : e.category, `browser launch failed: ${e.message}`);
    }
    let context: AdapterContext;
    try {
      context = await browser.newContext({ acceptDownloads: false });
    } catch (err) {
      await browser.close().catch(() => undefined);
      await proxy?.close();
      throw classifyError(err);
    }
    const s = new BrowserSession(adapter.name, policy, browser, context, clock);
    s.#proxy = proxy;
    session = s;
    for (const b of blockedEarly) s.#egressBlocked(b);
    blockedEarly = [];
    browser.onDisconnected(() => {
      s.#disconnected = true;
      s.#note({ type: "disconnected" });
    });
    await context.route((req) => s.#decide(req));
    context.onRequest((phase, req) => {
      s.#lastActivity = s.#clock();
      if (phase === "start") s.#pending.add(req);
      else s.#pending.delete(req);
    });
    s.#note({ type: "launched", detail: `${adapter.name} ${browser.version()}` });
    return s;
  }

  #decide(req: AdapterRequest): "continue" | "abort" {
    const d = this.policy.checkRequest(req.url, req.isNavigation);
    if (d.allowed) return "continue";
    this.#blockedCount += 1;
    if (req.isNavigation) this.#blockedNavigations += 1;
    const entry: BlockedRequest = { at: this.#clock(), url: displayUrl(req.url), isNavigation: req.isNavigation, resourceType: req.resourceType, reason: d.code };
    this.#blocked.push(entry);
    if (this.#blocked.length > MAX_BLOCKED) this.#blocked.shift();
    this.#note({ type: "request.blocked", detail: `${entry.resourceType} ${entry.url} (${d.code})` });
    return "abort";
  }

  /** A connection the egress proxy refused (redirect hop, tunnel, upgrade, ...). */
  #egressBlocked(b: { url: string; kind: string; reason: string }): void {
    this.#blockedCount += 1;
    const entry: BlockedRequest = { at: this.#clock(), url: displayUrl(b.url), isNavigation: false, resourceType: `egress:${b.kind}`, reason: "ORIGIN_NOT_ALLOWED" };
    this.#blocked.push(entry);
    if (this.#blocked.length > MAX_BLOCKED) this.#blocked.shift();
    this.#note({ type: "request.blocked", detail: `${entry.resourceType} ${entry.url}` });
  }

  /** Egress proxy counters (undefined when the session runs without one). */
  get egress(): { forwarded: number; blocked: number } | undefined {
    return this.#proxy?.stats;
  }

  #note(e: Omit<SessionLogEntry, "at">): void {
    this.#log.push({ at: this.#clock(), ...e });
    if (this.#log.length > MAX_LOG) this.#log.shift();
  }

  get log(): readonly SessionLogEntry[] {
    return this.#log;
  }
  get blocked(): readonly BlockedRequest[] {
    return this.#blocked;
  }
  get blockedCount(): number {
    return this.#blockedCount;
  }
  /** Blocked top-level navigations so far (an action that raises this fails). */
  get blockedNavigations(): number {
    return this.#blockedNavigations;
  }
  get activeTabId(): string | undefined {
    return this.#active;
  }
  get tabIds(): string[] {
    return [...this.#tabs.keys()];
  }
  get closed(): boolean {
    return this.#closed;
  }

  assertAlive(): void {
    if (this.#closed) throw new BrowserError("NOT_LAUNCHED", "browser_closed", "the browser session is closed");
    if (this.#disconnected || !this.#browser.isConnected()) throw new BrowserError("TARGET_ERROR", "browser_closed", "the browser has disconnected");
  }

  async openTab(): Promise<string> {
    this.assertAlive();
    let page: AdapterPage;
    try {
      page = await this.#context.newPage();
    } catch (err) {
      throw classifyError(err);
    }
    const id = `tab-${++this.#seq}`;
    const tab: Tab = { id, page, crashed: false, closed: false };
    page.on("close", () => {
      tab.closed = true;
      if (this.#tabs.get(id) === tab) {
        this.#tabs.delete(id);
        if (this.#active === id) this.#active = [...this.#tabs.keys()].at(-1);
        this.#note({ type: "tab.closed", tabId: id });
      }
    });
    page.on("crash", () => {
      tab.crashed = true;
      this.#note({ type: "tab.crashed", tabId: id });
    });
    page.on("dialog", (d) => this.#note({ type: "dialog.dismissed", tabId: id, detail: `${d.type}: ${redactText(d.message).slice(0, 200)}` }));
    page.on("load", (url) => this.#note({ type: "loaded", tabId: id, detail: displayUrl(url) }));
    this.#tabs.set(id, tab);
    this.#active = id;
    this.#note({ type: "tab.opened", tabId: id });
    return id;
  }

  async closeTab(id?: string): Promise<void> {
    this.assertAlive();
    const tabId = id ?? this.#active;
    const tab = tabId ? this.#tabs.get(tabId) : undefined;
    if (!tab) throw new BrowserError("NO_TAB", "unknown", `no such tab: ${String(tabId)}`);
    this.#tabs.delete(tab.id);
    if (this.#active === tab.id) this.#active = [...this.#tabs.keys()].at(-1);
    this.#note({ type: "tab.closed", tabId: tab.id });
    await tab.page.close().catch(() => undefined);
  }

  /** Make an existing tab the active one. */
  activate(id: string): void {
    if (!this.#tabs.has(id)) throw new BrowserError("NO_TAB", "unknown", `no such tab: ${id}`);
    this.#active = id;
  }

  /** The active tab's page (throws when there is none, it crashed, or the browser is gone). */
  page(): { id: string; page: AdapterPage } {
    this.assertAlive();
    const tab = this.#active ? this.#tabs.get(this.#active) : undefined;
    if (!tab || tab.closed) throw new BrowserError("NO_TAB", "unknown", "no open tab");
    if (tab.crashed) throw new BrowserError("TARGET_ERROR", "page_crashed", `tab ${tab.id} crashed`);
    return { id: tab.id, page: tab.page };
  }

  /**
   * Wait until no request has been in flight for `idleMs` (bounded by
   * `timeoutMs`; returns quietly at the bound — the next action decides).
   */
  async settle(timeoutMs: number, signal?: AbortSignal, idleMs = 150): Promise<void> {
    const deadline = this.#clock() + Math.max(0, timeoutMs);
    for (;;) {
      if (signal?.aborted) return;
      const now = this.#clock();
      if (this.#pending.size === 0 && now - this.#lastActivity >= idleMs) return;
      if (now >= deadline) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#tabs.clear();
    this.#active = undefined;
    await this.#context.close().catch(() => undefined);
    await this.#browser.close().catch(() => undefined);
    await this.#proxy?.close().catch(() => undefined);
    this.#note({ type: "closed" });
  }
}
