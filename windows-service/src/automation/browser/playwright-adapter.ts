/**
 * PlaywrightAdapter (Phase 11): BrowserAdapter over playwright-core driving
 * Chromium through CDP. playwright-core is an OPTIONAL dependency, loaded
 * lazily, so the service keeps zero runtime dependencies; without it the
 * adapter reports UNSUPPORTED.
 *
 * Deliberately plain: no extra launch arguments, no user-agent or navigator
 * changes, no automation-indicator suppression. Service workers are blocked so
 * every request passes the session's allowlist routing; downloads are refused.
 */

import { existsSync } from "node:fs";

import type { AdapterBrowser, AdapterContext, AdapterLaunchOptions, AdapterPage, AdapterRequest, BrowserAdapter, FieldObservation, PageEvents, SelectorSpec } from "./adapter.ts";
import { BrowserError } from "./errors.ts";

// Minimal structural types for the parts of playwright-core used here.
interface PwRequest {
  url(): string;
  isNavigationRequest(): boolean;
  resourceType(): string;
}
interface PwRoute {
  request(): PwRequest;
  continue(): Promise<void>;
  abort(code?: string): Promise<void>;
}
interface PwLocator {
  click(o: { timeout: number }): Promise<void>;
  fill(v: string, o: { timeout: number }): Promise<void>;
  selectOption(v: string, o: { timeout: number }): Promise<string[]>;
  waitFor(o: { state: "visible" | "attached"; timeout: number }): Promise<void>;
  evaluate<R>(fn: (el: unknown) => R): Promise<R>;
  last(): PwLocator;
}
interface PwResponse {
  status(): number;
}
interface PwDialog {
  type(): string;
  message(): string;
  dismiss(): Promise<void>;
}
interface PwPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, o: { timeout: number; waitUntil: "load" }): Promise<PwResponse | null>;
  reload(o: { timeout: number; waitUntil: "load" }): Promise<PwResponse | null>;
  goBack(o: { timeout: number; waitUntil: "load" }): Promise<PwResponse | null>;
  goForward(o: { timeout: number; waitUntil: "load" }): Promise<PwResponse | null>;
  locator(css: string): PwLocator;
  screenshot(o: { type: "png"; timeout: number }): Promise<Uint8Array>;
  evaluate<R>(fn: () => R): Promise<R>;
  on(ev: "close" | "crash" | "load", h: () => void): void;
  on(ev: "dialog", h: (d: PwDialog) => void): void;
  close(): Promise<void>;
}
interface PwContext {
  route(pattern: string, h: (r: PwRoute) => Promise<void>): Promise<void>;
  on(ev: "request" | "requestfinished" | "requestfailed", h: (r: PwRequest) => void): void;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(o: { acceptDownloads: boolean; serviceWorkers: "block" }): Promise<PwContext>;
  isConnected(): boolean;
  on(ev: "disconnected", h: () => void): void;
  version(): string;
  close(): Promise<void>;
}
interface PwModule {
  chromium: {
    launch(o: { headless: boolean; executablePath?: string; timeout: number; proxy?: { server: string; bypass: string } }): Promise<PwBrowser>;
    executablePath(): string;
  };
}

function locate(page: PwPage, s: SelectorSpec): PwLocator {
  const l = page.locator(s.css);
  return s.pick === "last" ? l.last() : l;
}

/** Runs in the page: form controls with values (password values never leave the page). */
function collectFields(): FieldObservation[] {
  type El = { tagName: string; id?: string; getAttribute(n: string): string | null; value?: string; checked?: boolean };
  const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<El> } }).document;
  const out: FieldObservation[] = [];
  const els = Array.from(doc.querySelectorAll("input, select, textarea"));
  els.forEach((el, i) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? (tag === "input" ? "text" : tag)).toLowerCase();
    const name = el.getAttribute("name") ?? undefined;
    const id = el.id || undefined;
    const autocomplete = el.getAttribute("autocomplete") ?? undefined;
    const key = id ?? name ?? `${tag}[${i}]`;
    const obs: FieldObservation = { key, tag, type, ...(name ? { name } : {}), ...(id ? { id } : {}), ...(autocomplete ? { autocomplete } : {}) };
    if (type !== "password" && type !== "hidden" && type !== "file") {
      obs.value = type === "checkbox" || type === "radio" ? (el.checked ? "checked" : "") : String(el.value ?? "").slice(0, 200);
    }
    out.push(obs);
  });
  return out;
}

class PlaywrightPage implements AdapterPage {
  #p: PwPage;
  constructor(p: PwPage) {
    this.#p = p;
  }
  url(): string {
    return this.#p.url();
  }
  title(): Promise<string> {
    return this.#p.title();
  }
  async goto(url: string, o: { timeoutMs: number }): Promise<{ status: number | null }> {
    const r = await this.#p.goto(url, { timeout: o.timeoutMs, waitUntil: "load" });
    return { status: r ? r.status() : null };
  }
  async reload(o: { timeoutMs: number }): Promise<{ status: number | null }> {
    const r = await this.#p.reload({ timeout: o.timeoutMs, waitUntil: "load" });
    return { status: r ? r.status() : null };
  }
  async goBack(o: { timeoutMs: number }): Promise<boolean> {
    const before = this.#p.url();
    const r = await this.#p.goBack({ timeout: o.timeoutMs, waitUntil: "load" });
    return r !== null || this.#p.url() !== before;
  }
  async goForward(o: { timeoutMs: number }): Promise<boolean> {
    const before = this.#p.url();
    const r = await this.#p.goForward({ timeout: o.timeoutMs, waitUntil: "load" });
    return r !== null || this.#p.url() !== before;
  }
  async click(s: SelectorSpec, o: { timeoutMs: number }): Promise<void> {
    await locate(this.#p, s).click({ timeout: o.timeoutMs });
  }
  async fill(s: SelectorSpec, value: string, o: { timeoutMs: number }): Promise<void> {
    await locate(this.#p, s).fill(value, { timeout: o.timeoutMs });
  }
  async selectOption(s: SelectorSpec, value: string | undefined, o: { timeoutMs: number }): Promise<string> {
    const loc = locate(this.#p, s);
    const deadline = Date.now() + o.timeoutMs;
    await loc.waitFor({ state: "attached", timeout: o.timeoutMs });
    let chosen = value;
    while (chosen === undefined) {
      const last = await loc.evaluate((el) => {
        const opts = Array.from((el as { options?: ArrayLike<{ value: string }> }).options ?? []).filter((x) => x.value !== "");
        return opts.length > 0 ? (opts[opts.length - 1] as { value: string }).value : null;
      });
      if (last !== null) chosen = last;
      else if (Date.now() >= deadline) throw new Error(`option not found: ${s.css} has no selectable option`);
      else await new Promise((r) => setTimeout(r, 50));
    }
    const picked = await loc.selectOption(chosen, { timeout: Math.max(1, deadline - Date.now()) });
    if (picked.length === 0) throw new Error(`did not find some options: ${chosen}`);
    return chosen;
  }
  async waitFor(s: SelectorSpec, o: { timeoutMs: number }): Promise<void> {
    await locate(this.#p, s).waitFor({ state: "visible", timeout: o.timeoutMs });
  }
  async screenshot(o: { timeoutMs: number }): Promise<Uint8Array> {
    return new Uint8Array(await this.#p.screenshot({ type: "png", timeout: o.timeoutMs }));
  }
  fields(): Promise<FieldObservation[]> {
    return this.#p.evaluate(collectFields);
  }
  on<E extends keyof PageEvents>(event: E, handler: PageEvents[E]): void {
    if (event === "dialog") {
      this.#p.on("dialog", (d) => {
        (handler as PageEvents["dialog"])({ type: d.type(), message: d.message() });
        void d.dismiss().catch(() => undefined);
      });
    } else if (event === "load") {
      this.#p.on("load", () => (handler as PageEvents["load"])(this.#p.url()));
    } else {
      this.#p.on(event as "close" | "crash", handler as () => void);
    }
  }
  close(): Promise<void> {
    return this.#p.close();
  }
}

class PlaywrightContext implements AdapterContext {
  #c: PwContext;
  #reqs = new WeakMap<PwRequest, AdapterRequest>();
  constructor(c: PwContext) {
    this.#c = c;
  }
  #wrap(r: PwRequest): AdapterRequest {
    let a = this.#reqs.get(r);
    if (!a) {
      a = { url: r.url(), isNavigation: r.isNavigationRequest(), resourceType: r.resourceType() };
      this.#reqs.set(r, a);
    }
    return a;
  }
  async route(decide: (req: AdapterRequest) => "continue" | "abort"): Promise<void> {
    await this.#c.route("**/*", async (route) => {
      const verdict = decide(this.#wrap(route.request()));
      if (verdict === "continue") await route.continue().catch(() => undefined);
      else await route.abort("blockedbyclient").catch(() => undefined);
    });
  }
  onRequest(handler: (phase: "start" | "end", req: AdapterRequest) => void): void {
    this.#c.on("request", (r) => handler("start", this.#wrap(r)));
    this.#c.on("requestfinished", (r) => handler("end", this.#wrap(r)));
    this.#c.on("requestfailed", (r) => handler("end", this.#wrap(r)));
  }
  async newPage(): Promise<AdapterPage> {
    return new PlaywrightPage(await this.#c.newPage());
  }
  close(): Promise<void> {
    return this.#c.close();
  }
}

class PlaywrightBrowser implements AdapterBrowser {
  #b: PwBrowser;
  constructor(b: PwBrowser) {
    this.#b = b;
  }
  async newContext(o: { acceptDownloads: false }): Promise<AdapterContext> {
    return new PlaywrightContext(await this.#b.newContext({ acceptDownloads: o.acceptDownloads, serviceWorkers: "block" }));
  }
  isConnected(): boolean {
    return this.#b.isConnected();
  }
  onDisconnected(handler: () => void): void {
    this.#b.on("disconnected", handler);
  }
  version(): string {
    return this.#b.version();
  }
  close(): Promise<void> {
    return this.#b.close();
  }
}

export interface PlaywrightAdapterOptions {
  /** Module loader (tests); default: dynamic import of playwright-core. */
  load?: () => Promise<unknown>;
}

export class PlaywrightAdapter implements BrowserAdapter {
  readonly name = "playwright-chromium";
  #load: () => Promise<unknown>;

  constructor(opts: PlaywrightAdapterOptions = {}) {
    this.#load = opts.load ?? (() => import("playwright-core"));
  }

  async launch(o: AdapterLaunchOptions): Promise<AdapterBrowser> {
    let pw: PwModule;
    try {
      pw = (await this.#load()) as PwModule;
    } catch {
      throw new BrowserError("UNSUPPORTED", "unsupported", "playwright-core is not installed; install it (pnpm install) or use the mock controller");
    }
    let executablePath = o.executablePath;
    if (executablePath === undefined) {
      const bundled = pw.chromium.executablePath();
      if (bundled && existsSync(bundled)) executablePath = bundled;
    }
    if (executablePath !== undefined && !existsSync(executablePath)) {
      throw new BrowserError("TARGET_ERROR", "launch_failed", `browser executable not found: ${executablePath}`);
    }
    const b = await pw.chromium.launch({
      headless: o.headless,
      timeout: o.timeoutMs,
      ...(executablePath ? { executablePath } : {}),
      // "<-loopback>": loopback traffic goes through the egress proxy too (no implicit bypass).
      ...(o.proxyServer ? { proxy: { server: o.proxyServer, bypass: "<-loopback>" } } : {}),
    });
    return new PlaywrightBrowser(b);
  }
}
