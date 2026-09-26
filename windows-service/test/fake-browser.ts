/**
 * In-memory BrowserAdapter for unit tests: pages are declared per URL with the
 * elements they contain; actions can navigate, issue requests, open dialogs,
 * be delayed or fail with a given error. Records every call so tests can prove
 * what the browser was (or was not) asked to do.
 */
import type {
  AdapterBrowser,
  AdapterContext,
  AdapterLaunchOptions,
  AdapterPage,
  AdapterRequest,
  BrowserAdapter,
  FieldObservation,
  PageEvents,
  SelectorSpec,
} from "../src/automation/browser/adapter.ts";

export interface FakeElement {
  visible?: boolean;
  /** Selecting an option / typing records the value here. */
  value?: string;
  options?: string[];
  field?: Omit<FieldObservation, "key" | "value"> & { key: string };
  /** On click: navigate to this URL (redirects / links). */
  navigatesTo?: string;
  /** On click: issue these sub-resource requests. */
  requests?: string[];
  /** On click: open a JS dialog. */
  dialog?: string;
}

export interface FakePageSpec {
  title?: string;
  status?: number;
  /** Sub-resources the page loads on navigation. */
  requests?: string[];
  /** Server-side redirect target. */
  redirectTo?: string;
  elements?: Record<string, FakeElement[]>;
}

export interface FakeWorld {
  pages: Record<string, FakePageSpec>;
  /** Delay (ms) applied to every page action. */
  delayMs?: number;
  /** Fail the next call of a method with this error. */
  failNext?: Partial<Record<"click" | "goto" | "fill" | "waitFor" | "launch" | "screenshot", Error>>;
}

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakePage implements AdapterPage {
  #ctx: FakeContext;
  #url = "about:blank";
  #history: string[] = ["about:blank"];
  #index = 0;
  #handlers: Partial<{ [K in keyof PageEvents]: Array<PageEvents[K]> }> = {};
  #elements = new Map<string, FakeElement[]>();
  closed = false;

  constructor(ctx: FakeContext) {
    this.#ctx = ctx;
  }

  #emit<E extends keyof PageEvents>(e: E, ...args: Parameters<PageEvents[E]>): void {
    for (const h of (this.#handlers[e] ?? []) as Array<(...a: unknown[]) => void>) h(...args);
  }

  async #step(method: keyof NonNullable<FakeWorld["failNext"]>): Promise<void> {
    this.#ctx.calls.push(method);
    if (this.#ctx.world.delayMs) await sleep(this.#ctx.world.delayMs);
    const err = this.#ctx.world.failNext?.[method];
    if (err) {
      delete this.#ctx.world.failNext?.[method];
      throw err;
    }
    if (this.closed) throw new Error("Target page, context or browser has been closed");
  }

  async #load(url: string): Promise<number | null> {
    if (!this.#ctx.request({ url, isNavigation: true, resourceType: "document" })) throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`);
    let spec = this.#ctx.world.pages[url];
    let finalUrl = url;
    if (spec?.redirectTo) {
      finalUrl = spec.redirectTo;
      spec = this.#ctx.world.pages[finalUrl];
    }
    this.#url = finalUrl;
    this.#elements = new Map(Object.entries(structuredClone(spec?.elements ?? {})));
    for (const r of spec?.requests ?? []) this.#ctx.request({ url: r, isNavigation: false, resourceType: "image" });
    this.#emit("load", finalUrl);
    return spec ? (spec.status ?? 200) : 404;
  }

  #find(s: SelectorSpec, requireVisible = true): FakeElement {
    const list = this.#elements.get(s.css) ?? [];
    if (list.length === 0) throw new Error(`Timeout 50ms exceeded waiting for locator('${s.css}')`);
    if (s.pick === "only" && list.length > 1) throw new Error(`strict mode violation: locator('${s.css}') resolved to ${list.length} elements`);
    const el = s.pick === "last" ? (list.at(-1) as FakeElement) : (list[0] as FakeElement);
    if (requireVisible && el.visible === false) throw new Error(`element is not visible: ${s.css}`);
    return el;
  }

  url(): string {
    return this.#url;
  }
  async title(): Promise<string> {
    return this.#ctx.world.pages[this.#url]?.title ?? "";
  }
  async goto(url: string): Promise<{ status: number | null }> {
    await this.#step("goto");
    const status = await this.#load(url);
    this.#history = [...this.#history.slice(0, this.#index + 1), this.#url];
    this.#index = this.#history.length - 1;
    return { status };
  }
  async reload(): Promise<{ status: number | null }> {
    return { status: await this.#load(this.#url) };
  }
  async goBack(): Promise<boolean> {
    if (this.#index <= 0) return false;
    this.#index -= 1;
    await this.#load(this.#history[this.#index] as string);
    return true;
  }
  async goForward(): Promise<boolean> {
    if (this.#index >= this.#history.length - 1) return false;
    this.#index += 1;
    await this.#load(this.#history[this.#index] as string);
    return true;
  }
  async click(s: SelectorSpec): Promise<void> {
    await this.#step("click");
    const el = this.#find(s);
    this.#ctx.clicked.push(`${s.css}${s.pick === "last" ? ":last" : ""}`);
    for (const r of el.requests ?? []) this.#ctx.request({ url: r, isNavigation: false, resourceType: "fetch" });
    if (el.dialog) this.#emit("dialog", { type: "alert", message: el.dialog });
    if (el.navigatesTo) {
      // like a link: the browser asks the router first; a blocked navigation leaves the page as is
      if (this.#ctx.request({ url: el.navigatesTo, isNavigation: true, resourceType: "document" })) {
        this.#ctx.navigations.push(el.navigatesTo);
        await this.#load(el.navigatesTo);
        this.#history = [...this.#history.slice(0, this.#index + 1), this.#url];
        this.#index = this.#history.length - 1;
      }
    }
  }
  async fill(s: SelectorSpec, value: string): Promise<void> {
    await this.#step("fill");
    this.#find(s).value = value;
  }
  async selectOption(s: SelectorSpec, value: string | undefined): Promise<string> {
    const el = this.#find(s);
    const opts = (el.options ?? []).filter((o) => o !== "");
    const chosen = value ?? opts.at(-1);
    if (chosen === undefined || !opts.includes(chosen)) throw new Error(`did not find some options: ${String(chosen)}`);
    el.value = chosen;
    return chosen;
  }
  async waitFor(s: SelectorSpec): Promise<void> {
    await this.#step("waitFor");
    this.#find(s);
  }
  async screenshot(): Promise<Uint8Array> {
    await this.#step("screenshot");
    return PNG_BYTES;
  }
  async fields(): Promise<FieldObservation[]> {
    const out: FieldObservation[] = [];
    for (const list of this.#elements.values()) {
      for (const el of list) {
        if (!el.field) continue;
        out.push({ ...el.field, ...(el.field.type !== "password" && el.value !== undefined ? { value: el.value } : {}) });
      }
    }
    return out;
  }
  on<E extends keyof PageEvents>(event: E, handler: PageEvents[E]): void {
    const list = (this.#handlers[event] ?? []) as Array<PageEvents[E]>;
    list.push(handler);
    (this.#handlers as Record<string, unknown>)[event] = list;
  }
  crash(): void {
    this.#emit("crash");
  }
  async close(): Promise<void> {
    this.closed = true;
    this.#emit("close");
  }
}

class FakeContext implements AdapterContext {
  world: FakeWorld;
  calls: string[];
  clicked: string[];
  navigations: string[] = [];
  requests: Array<{ url: string; allowed: boolean }> = [];
  pages: FakePage[] = [];
  #decide: ((r: AdapterRequest) => "continue" | "abort") | undefined;
  #onReq: Array<(phase: "start" | "end", r: AdapterRequest) => void> = [];

  constructor(world: FakeWorld, calls: string[], clicked: string[]) {
    this.world = world;
    this.calls = calls;
    this.clicked = clicked;
  }
  request(r: AdapterRequest): boolean {
    const allowed = (this.#decide?.(r) ?? "continue") === "continue";
    this.requests.push({ url: r.url, allowed });
    if (allowed) {
      for (const h of this.#onReq) h("start", r);
      for (const h of this.#onReq) h("end", r);
    }
    return allowed;
  }
  async route(decide: (r: AdapterRequest) => "continue" | "abort"): Promise<void> {
    this.#decide = decide;
  }
  onRequest(h: (phase: "start" | "end", r: AdapterRequest) => void): void {
    this.#onReq.push(h);
  }
  async newPage(): Promise<AdapterPage> {
    const p = new FakePage(this);
    this.pages.push(p);
    return p;
  }
  async close(): Promise<void> {
    for (const p of this.pages) p.closed = true;
  }
}

class FakeBrowser implements AdapterBrowser {
  context: FakeContext | undefined;
  connected = true;
  closedCalls = 0;
  #onDisc: Array<() => void> = [];
  #world: FakeWorld;
  #calls: string[];
  #clicked: string[];
  constructor(world: FakeWorld, calls: string[], clicked: string[]) {
    this.#world = world;
    this.#calls = calls;
    this.#clicked = clicked;
  }
  async newContext(o: { acceptDownloads: false }): Promise<AdapterContext> {
    this.#calls.push(`newContext:acceptDownloads=${String(o.acceptDownloads)}`);
    this.context = new FakeContext(this.#world, this.#calls, this.#clicked);
    return this.context;
  }
  isConnected(): boolean {
    return this.connected;
  }
  onDisconnected(h: () => void): void {
    this.#onDisc.push(h);
  }
  disconnect(): void {
    this.connected = false;
    for (const h of this.#onDisc) h();
  }
  version(): string {
    return "fake/1.0";
  }
  async close(): Promise<void> {
    this.closedCalls += 1;
    this.connected = false;
  }
}

export class FakeAdapter implements BrowserAdapter {
  readonly name = "fake";
  world: FakeWorld;
  calls: string[] = [];
  clicked: string[] = [];
  launches: AdapterLaunchOptions[] = [];
  browser: FakeBrowser | undefined;

  constructor(world: FakeWorld) {
    this.world = world;
  }
  async launch(o: AdapterLaunchOptions): Promise<AdapterBrowser> {
    this.launches.push(o);
    this.calls.push("launch");
    const err = this.world.failNext?.launch;
    if (err) {
      delete this.world.failNext?.launch;
      throw err;
    }
    this.browser = new FakeBrowser(this.world, this.calls, this.clicked);
    return this.browser;
  }
  get context(): FakeContext {
    return this.browser?.context as FakeContext;
  }
}
