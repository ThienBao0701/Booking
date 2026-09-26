/**
 * BrowserAdapterController (Phase 11): the existing BrowserController interface
 * over a real browser (BrowserSession + BrowserAdapter), gated by a
 * BrowserTargetPolicy.
 *
 * Order of checks: the policy object only exists for an authorized target
 * (shared evaluateReplay + explicit allowlist); `launch()` re-verifies that the
 * launch URL is the policy's target before any browser starts; every
 * navigation is checked before it is issued; every request is checked in the
 * session; after navigations the landing URL is re-checked (redirects).
 *
 * Reference rule for recordings: `$last` / `$last.<kind>` in an attribute
 * selector (e.g. `button[data-cancel="$last"]`) or as a <select> value binds to
 * the LAST matching element / non-empty option in document order.
 *
 * State capture never reads password or sensitive fields, and redacts the rest.
 * An action that triggers a navigation outside the allowlist fails with
 * NAVIGATION_BLOCKED (the request is aborted in the browser; if the tab ended
 * up on an error or foreign page it is moved to about:blank).
 *
 * The browser keeps its ordinary identity; nothing is spoofed.
 */

import { createHash } from "node:crypto";

import { isSensitiveField, redactFieldValue } from "../../shared.ts";
import {
  type ActionOptions,
  type BrowserController,
  type ControllerSnapshot,
  type LaunchOptions,
  type PageMetadata,
  type PageState,
  type ScreenshotResult,
} from "../controller.ts";
import type { BrowserAdapter, SelectorSpec } from "./adapter.ts";
import { BrowserError, classifyError } from "./errors.ts";
import { BrowserSession, type SessionLogEntry } from "./session.ts";
import { type BrowserTargetPolicy, originOf } from "./target-policy.ts";

export interface BrowserControllerOptions {
  adapter: BrowserAdapter;
  policy: BrowserTargetPolicy;
  headless?: boolean;
  executablePath?: string | undefined;
  /** Per-action timeout when the caller gives none (10 s). */
  defaultTimeoutMs?: number;
  /** Max wait for in-flight requests to settle after an action (2 s; 0 = off). */
  settleMs?: number;
  launchTimeoutMs?: number;
  /** Route all browser traffic through the session's egress proxy (default true; off only for in-memory adapters). */
  egressProxy?: boolean;
  clock?: () => number;
}

const LAST_ATTR = /(\[[\w:-]+)\s*=\s*(["'])\$last(?:\.\w+)?\2\s*\]/g;
const LAST_VALUE = /^\$last(?:\.\w+)?$/;
const NEVER_CAPTURE_TYPES = new Set(["password", "hidden", "file"]);

/** Translate a step selector to a SelectorSpec, applying the `$last` rule. */
export function resolveSelector(selector: string): SelectorSpec {
  if (typeof selector !== "string" || selector.trim() === "") throw new BrowserError("ELEMENT_NOT_FOUND", "element_missing", "empty selector");
  LAST_ATTR.lastIndex = 0;
  if (!LAST_ATTR.test(selector)) return { css: selector, pick: "only" };
  return { css: selector.replace(LAST_ATTR, "$1]"), pick: "last" };
}

export class BrowserAdapterController implements BrowserController {
  readonly name: string;
  #o: BrowserControllerOptions;
  #session: BrowserSession | undefined;
  #status = new Map<string, number | null>();

  constructor(opts: BrowserControllerOptions) {
    this.#o = opts;
    this.name = `browser:${opts.adapter.name}`;
  }

  get session(): BrowserSession | undefined {
    return this.#session;
  }
  /** Session diagnostics (tabs, loads, dialogs, blocked requests). */
  get log(): readonly SessionLogEntry[] {
    return this.#session?.log ?? [];
  }

  #s(): BrowserSession {
    if (!this.#session) throw new BrowserError("NOT_LAUNCHED", "unknown", "browser controller is not launched");
    return this.#session;
  }

  /** Timeout + cancellation + classification around one action. */
  async #act<T>(opts: ActionOptions | undefined, fn: (timeoutMs: number) => Promise<T>): Promise<T> {
    const signal = opts?.signal;
    if (signal?.aborted) throw new BrowserError("ABORTED", "aborted", "action aborted before it started");
    const timeoutMs = opts?.timeoutMs ?? this.#o.defaultTimeoutMs ?? 10_000;
    const work = fn(timeoutMs);
    if (!signal) {
      try {
        return await work;
      } catch (err) {
        throw classifyError(err);
      }
    }
    work.catch(() => undefined); // an aborted action may still settle later
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new BrowserError("ABORTED", "aborted", "action aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (err) {
      throw classifyError(err);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #settle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const cap = this.#o.settleMs ?? 2000;
    if (cap > 0) await this.#s().settle(Math.min(cap, timeoutMs), signal);
  }

  /** After any navigation: the page must still be on an allowlisted origin. */
  async #checkLanding(id: string, url: string, timeoutMs: number): Promise<void> {
    const d = this.#s().policy.checkNavigation(url);
    if (d.allowed) return;
    if (url.startsWith("chrome-error://")) {
      // The browser shows its error page for a navigation the session aborted.
      await this.#s().page().page.goto("about:blank", { timeoutMs }).catch(() => undefined);
      this.#status.set(id, null);
      throw new BrowserError("NAVIGATION_BLOCKED", "navigation_blocked", "the navigation was blocked (outside the allowlist)");
    }
    await this.#s().page().page.goto("about:blank", { timeoutMs }).catch(() => undefined);
    this.#status.set(id, null);
    throw new BrowserError("NAVIGATION_BLOCKED", "navigation_blocked", `landed outside the allowlist (redirect?): ${d.reason}`);
  }

  async launch(opts: LaunchOptions): Promise<void> {
    const policy = this.#o.policy;
    // Before any browser process: the launch URL must be the authorized, allowlisted target.
    if (originOf(opts.baseUrl) !== policy.targetOrigin) {
      throw new BrowserError("NAVIGATION_BLOCKED", "navigation_blocked", `launch URL ${opts.baseUrl} is not the authorized target ${policy.targetOrigin}`);
    }
    const pre = policy.checkNavigation(opts.baseUrl);
    if (!pre.allowed) throw new BrowserError("NAVIGATION_BLOCKED", "navigation_blocked", pre.reason);
    if (this.#session && !this.#session.closed) await this.#session.close();
    this.#session = await BrowserSession.start(this.#o.adapter, policy, {
      headless: this.#o.headless ?? true,
      executablePath: this.#o.executablePath,
      launchTimeoutMs: this.#o.launchTimeoutMs ?? 30_000,
      egressProxy: this.#o.egressProxy ?? true,
    }, this.#o.clock);
    this.#status.clear();
    await this.#session.openTab();
  }

  async openTab(url?: string, opts?: ActionOptions): Promise<string> {
    const id = await this.#act(opts, () => this.#s().openTab());
    if (url !== undefined) await this.navigate(url, opts);
    return id;
  }

  async closeTab(tabId?: string): Promise<void> {
    await this.#s().closeTab(tabId);
  }

  async navigate(url: string, opts?: ActionOptions): Promise<void> {
    const s = this.#s();
    const abs = s.policy.resolve(url);
    const d = s.policy.checkNavigation(abs); // before the request is issued
    if (!d.allowed) throw new BrowserError("NAVIGATION_BLOCKED", "navigation_blocked", d.reason);
    await this.#act(opts, async (t) => {
      const { id, page } = s.page();
      const r = await page.goto(abs, { timeoutMs: t });
      this.#status.set(id, r.status);
      await this.#checkLanding(id, page.url(), t);
      await this.#settle(t, opts?.signal);
    });
  }

  async reload(opts?: ActionOptions): Promise<void> {
    await this.#act(opts, async (t) => {
      const { id, page } = this.#s().page();
      if (page.url() === "about:blank") throw new BrowserError("NO_HISTORY", "unknown", "nothing to reload");
      const r = await page.reload({ timeoutMs: t });
      this.#status.set(id, r.status);
      await this.#checkLanding(id, page.url(), t);
      await this.#settle(t, opts?.signal);
    });
  }

  async back(opts?: ActionOptions): Promise<void> {
    await this.#history("back", opts);
  }

  async forward(opts?: ActionOptions): Promise<void> {
    await this.#history("forward", opts);
  }

  async #history(dir: "back" | "forward", opts?: ActionOptions): Promise<void> {
    await this.#act(opts, async (t) => {
      const { id, page } = this.#s().page();
      const moved = dir === "back" ? await page.goBack({ timeoutMs: t }) : await page.goForward({ timeoutMs: t });
      if (!moved) throw new BrowserError("NO_HISTORY", "unknown", `no ${dir === "back" ? "previous" : "next"} page in this tab`);
      await this.#checkLanding(id, page.url(), t);
      await this.#settle(t, opts?.signal);
    });
  }

  async click(selector: string, opts?: ActionOptions): Promise<void> {
    const spec = resolveSelector(selector);
    await this.#act(opts, async (t) => {
      const s = this.#s();
      const { id, page } = s.page();
      const blockedBefore = s.blockedNavigations;
      await page.click(spec, { timeoutMs: t });
      await this.#settle(t, opts?.signal);
      await this.#checkLanding(id, page.url(), t);
      if (s.blockedNavigations > blockedBefore) {
        const last = s.blocked.filter((b) => b.isNavigation).at(-1);
        throw new BrowserError("NAVIGATION_BLOCKED", "navigation_blocked", `the action tried to navigate outside the allowlist: ${last?.url ?? "unknown"}`);
      }
    });
  }

  async type(selector: string, value: string, opts?: ActionOptions): Promise<void> {
    const spec = resolveSelector(selector);
    await this.#act(opts, async (t) => {
      await this.#s().page().page.fill(spec, value, { timeoutMs: t });
    });
  }

  async select(selector: string, value: string, opts?: ActionOptions): Promise<void> {
    const spec = resolveSelector(selector);
    await this.#act(opts, async (t) => {
      await this.#s().page().page.selectOption(spec, LAST_VALUE.test(value) ? undefined : value, { timeoutMs: t });
      await this.#settle(t, opts?.signal);
    });
  }

  async waitFor(selector: string, opts?: ActionOptions): Promise<void> {
    const spec = resolveSelector(selector);
    await this.#act(opts, async (t) => {
      await this.#s().page().page.waitFor(spec, { timeoutMs: t });
    });
  }

  async captureState(opts?: ActionOptions): Promise<PageState> {
    return await this.#act(opts, async () => {
      const { id, page } = this.#s().page();
      const fields: Record<string, string> = {};
      for (const f of await page.fields()) {
        const descriptor = { name: f.name, id: f.id, type: f.type, autocomplete: f.autocomplete };
        if (NEVER_CAPTURE_TYPES.has(f.type.toLowerCase()) || isSensitiveField(descriptor)) continue;
        const v = redactFieldValue(descriptor, f.value);
        if (v !== undefined) fields[f.key] = v;
      }
      return { url: page.url(), tabId: id, fields, entities: {}, server: {}, capturedAt: (this.#o.clock ?? Date.now)() };
    });
  }

  async captureScreenshot(opts?: ActionOptions): Promise<ScreenshotResult> {
    return await this.#act(opts, async (t) => {
      const data = await this.#s().page().page.screenshot({ timeoutMs: t });
      return { supported: true, mimeType: "image/png", data, sha256: createHash("sha256").update(data).digest("hex") };
    });
  }

  getCurrentUrl(): string {
    try {
      return this.#s().page().page.url();
    } catch {
      return "about:blank";
    }
  }

  async getPageMetadata(opts?: ActionOptions): Promise<PageMetadata> {
    return await this.#act(opts, async () => {
      const { id, page } = this.#s().page();
      const status = this.#status.get(id);
      return { url: page.url(), title: await page.title(), tabId: id, ...(status !== undefined && status !== null ? { status } : {}) };
    });
  }

  /** Checkpoint: the active tab's URL. Restoring navigates back to it (form input is not restored). */
  async snapshot(): Promise<ControllerSnapshot> {
    const s = this.#s();
    return { activeTab: s.activeTabId ?? null, url: this.getCurrentUrl() };
  }

  async restore(snapshot: ControllerSnapshot): Promise<void> {
    const url = typeof snapshot.url === "string" ? snapshot.url : "about:blank";
    const s = this.#s();
    if (typeof snapshot.activeTab === "string" && s.tabIds.includes(snapshot.activeTab)) s.activate(snapshot.activeTab);
    if (url === "about:blank") return;
    await this.navigate(url);
  }

  async close(): Promise<void> {
    await this.#session?.close();
  }
}
