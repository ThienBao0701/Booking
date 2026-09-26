/**
 * MockExtranetController — BrowserController for the local mock Extranet.
 *
 * It drives the mock's page model (mock-page-map.ts) with browser semantics,
 * talking to the mock over HTTP exactly as the page's own client script does:
 *   - only elements of the active view are visible / interactable;
 *   - navigation loads the page; reload resets unsaved inputs; back/forward
 *     walk the tab history;
 *   - <select> values must be existing options; typing into a <select> fails;
 *   - an action the server rejects fails the step (like the UI's alert);
 *   - `$last` / `$last.<kind>` references bind to the entity most recently
 *     created by this controller (recordings never contain entity ids).
 *
 * Safety: refuses any non-loopback base URL and blocks navigation to any other
 * origin — it can only ever drive the local mock.
 */

import { isLoopbackUrl, redactValue } from "../shared.ts";
import {
  type ActionOptions,
  type BrowserController,
  type ControllerSnapshot,
  type LaunchOptions,
  type PageMetadata,
  type PageState,
  type ScreenshotResult,
  ControllerError,
} from "./controller.ts";
import {
  DEFAULT_VIEW,
  GLOBAL_IDS,
  MOCK_APP_MARKER,
  OPTION_SOURCES,
  VIEWS,
  type ActionSpec,
  type EntityKind,
  type FieldSpec,
  type ViewSpec,
  findView,
} from "./mock-page-map.ts";

type Fetch = typeof globalThis.fetch;

export interface MockControllerOptions {
  fetch?: Fetch;
  /** waitFor polling interval (default 50 ms). */
  pollMs?: number;
  /** waitFor timeout when none is given (default 5000 ms). */
  defaultTimeoutMs?: number;
}

interface HistoryEntry {
  url: string;
}

interface TabState {
  id: string;
  history: HistoryEntry[];
  index: number;
  /** Loaded document: undefined = blank/error page (no app elements). */
  view: string | undefined;
  title: string;
  status: number | undefined;
  fields: Record<string, string>;
  reportGenerated: boolean;
}

type Parsed =
  | { kind: "id"; id: string; attr?: { name: string; op: "exists" | "eq" | "nonEmpty"; value?: string } }
  | { kind: "action"; dataAction: string }
  | { kind: "nav"; view: string }
  | { kind: "panel"; view: string }
  | { kind: "cancel"; ref: string | undefined }
  | { kind: "unknown"; raw: string };

const Q = `["']?`;

/** Parse the selector dialects used by recordings and authored workflows. */
export function parseSelector(raw: string): Parsed {
  let s = raw.trim().replace(/^#nav\s+/, "");
  const idm = /^#([\w-]+)(.*)$/.exec(s);
  if (idm) {
    const id = idm[1] as string;
    const rest = (idm[2] ?? "").trim();
    if (rest === "") return { kind: "id", id };
    const nonEmpty = new RegExp(`^\\[([\\w-]+)\\]:not\\(\\[\\1=${Q}${Q}\\]\\)$`).exec(rest);
    if (nonEmpty) return { kind: "id", id, attr: { name: nonEmpty[1] as string, op: "nonEmpty" } };
    const eq = new RegExp(`^\\[([\\w-]+)=${Q}([^"'\\]]*)${Q}\\]$`).exec(rest);
    if (eq) return { kind: "id", id, attr: { name: eq[1] as string, op: "eq", value: eq[2] as string } };
    const ex = /^\[([\w-]+)\]$/.exec(rest);
    if (ex) return { kind: "id", id, attr: { name: ex[1] as string, op: "exists" } };
    return { kind: "unknown", raw };
  }
  s = s.replace(/^(?:button|div|a|span|section|input|select|textarea)(?=[[.])/, "");
  let m = new RegExp(`^\\.view(?:\\.active)?\\[data-view=${Q}([\\w-]+)${Q}\\]$`).exec(s);
  if (m) return { kind: "panel", view: m[1] as string };
  m = new RegExp(`^\\[data-action=${Q}([\\w-]+)${Q}\\]$`).exec(s);
  if (m) return { kind: "action", dataAction: m[1] as string };
  m = new RegExp(`^\\[data-view=${Q}([\\w-]+)${Q}\\]$`).exec(s);
  if (m) return { kind: "nav", view: m[1] as string };
  m = new RegExp(`^\\[data-cancel(?:=${Q}([^"'\\]]+)${Q})?\\]$`).exec(s);
  if (m) return { kind: "cancel", ref: m[1] };
  return { kind: "unknown", raw };
}

function originOf(url: string): string {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? (m[1] as string).toLowerCase() : "";
}

export class MockExtranetController implements BrowserController {
  readonly name = "mock-extranet";
  #fetch: Fetch;
  #pollMs: number;
  #defaultTimeoutMs: number;
  #origin = "";
  #launched = false;
  #tabs = new Map<string, TabState>();
  #active: string | undefined;
  #tabSeq = 0;
  #lastIds: Partial<Record<EntityKind, string>> = {};
  #actor: string | undefined;

  constructor(opts: MockControllerOptions = {}) {
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#pollMs = opts.pollMs ?? 50;
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? 5000;
  }

  // ---- infrastructure ----

  async #http(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    opts: ActionOptions | undefined,
  ): Promise<{ status: number; contentType: string; text: string; json: unknown }> {
    if (opts?.signal?.aborted) throw new ControllerError("ABORTED", "action aborted");
    let res: Response;
    try {
      res = await this.#fetch(this.#origin + path, {
        method,
        redirect: "error",
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (opts?.signal?.aborted) throw new ControllerError("ABORTED", "action aborted");
      throw new ControllerError("TARGET_ERROR", `mock unreachable (${method} ${path}): ${String(err)}`, true);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", text, json };
  }

  #requireLaunched(): void {
    if (!this.#launched) throw new ControllerError("NOT_LAUNCHED", "controller not launched");
  }

  #tab(): TabState {
    this.#requireLaunched();
    const t = this.#active ? this.#tabs.get(this.#active) : undefined;
    if (!t) throw new ControllerError("NO_TAB", "no active tab");
    return t;
  }

  #resolveUrl(url: string): { url: string; path: string } {
    const abs = /^https?:\/\//i.test(url) ? url : this.#origin + (url.startsWith("/") ? url : `/${url}`);
    if (originOf(abs) !== this.#origin) {
      throw new ControllerError("NAVIGATION_BLOCKED", `navigation outside the authorized origin is blocked: ${url}`);
    }
    const path = abs.slice(this.#origin.length) || "/";
    return { url: abs, path };
  }

  async #load(tab: TabState, url: string, opts: ActionOptions | undefined): Promise<void> {
    const { path } = this.#resolveUrl(url);
    const res = await this.#http("GET", path.replace(/#.*$/, "") || "/", undefined, opts);
    const isApp = res.status === 200 && res.contentType.includes("text/html") && res.text.includes(MOCK_APP_MARKER);
    tab.status = res.status;
    tab.view = isApp ? DEFAULT_VIEW : undefined;
    tab.title = isApp ? (/<title>([^<]*)<\/title>/i.exec(res.text)?.[1] ?? "") : `HTTP ${res.status}`;
    tab.fields = {};
    tab.reportGenerated = false;
  }

  async #options(kind: EntityKind, opts: ActionOptions | undefined): Promise<Array<{ id: string; status?: string }>> {
    const src = OPTION_SOURCES[kind];
    if (!src) return [];
    const res = await this.#http("GET", src.path, undefined, opts);
    const list = (res.json as Record<string, unknown> | undefined)?.[src.key];
    return Array.isArray(list) ? (list as Array<{ id: string; status?: string }>) : [];
  }

  #resolveRef(value: string, contextKind: EntityKind | undefined): string {
    const m = /^\$last(?:\.(\w+))?$/.exec(value);
    if (!m) return value;
    const kind = (m[1] ?? contextKind) as EntityKind | undefined;
    const id = kind ? this.#lastIds[kind] : undefined;
    if (!id) throw new ControllerError("UNRESOLVED_REFERENCE", `${value}: no ${kind ?? "entity"} has been created in this run`);
    return id;
  }

  #fieldIn(view: ViewSpec | undefined, id: string): FieldSpec | undefined {
    return view?.fields.find((f) => f.id === id);
  }

  #locate(id: string): { view: ViewSpec | undefined; field?: FieldSpec; action?: ActionSpec; global: boolean } | undefined {
    if (GLOBAL_IDS.includes(id)) return { view: undefined, global: true };
    for (const v of VIEWS) {
      const field = v.fields.find((f) => f.id === id);
      if (field) return { view: v, field, global: false };
      const action = v.actions.find((a) => a.id === id);
      if (action) return { view: v, action, global: false };
      if (v.staticIds.includes(id)) return { view: v, global: false };
    }
    return undefined;
  }

  /** Visibility of a parsed selector in the active tab (Playwright-style "visible"). */
  async #visible(tab: TabState, p: Parsed, opts: ActionOptions | undefined): Promise<boolean> {
    if (tab.view === undefined) return false; // blank / error page: no app elements
    switch (p.kind) {
      case "id": {
        const loc = this.#locate(p.id);
        if (!loc) return false;
        if (!loc.global && loc.view?.name !== tab.view) return false;
        if (!p.attr) return true;
        const value =
          p.id === "actor" && p.attr.name === "data-actor"
            ? this.#actor ?? ""
            : p.id === "report-out" && p.attr.name === "data-report"
              ? tab.reportGenerated
                ? "1"
                : ""
              : undefined;
        if (value === undefined) return false;
        if (p.attr.op === "exists") return true;
        if (p.attr.op === "nonEmpty") return value !== "";
        return value === p.attr.value;
      }
      case "action": {
        const view = VIEWS.find((v) => v.actions.some((a) => a.dataAction === p.dataAction));
        return view?.name === tab.view;
      }
      case "nav":
        return findView(p.view) !== undefined;
      case "panel":
        return tab.view === p.view;
      case "cancel": {
        if (tab.view !== "reservations") return false;
        const rows = await this.#options("reservation", opts);
        if (p.ref === undefined) return rows.length > 0;
        try {
          const id = this.#resolveRef(p.ref, "reservation");
          return rows.some((r) => r.id === id);
        } catch {
          return false;
        }
      }
      case "unknown":
        return false;
    }
  }

  // ---- BrowserController ----

  async launch(opts: LaunchOptions): Promise<void> {
    if (!isLoopbackUrl(opts.baseUrl)) {
      throw new ControllerError("NAVIGATION_BLOCKED", `MockExtranetController only drives a local mock; refusing ${opts.baseUrl}`);
    }
    this.#origin = originOf(opts.baseUrl);
    const health = await this.#http("GET", "/healthz", undefined, undefined);
    if (health.status !== 200 || (health.json as { status?: string } | undefined)?.status !== "ok") {
      throw new ControllerError("TARGET_ERROR", `mock at ${this.#origin} is not healthy (HTTP ${health.status})`, true);
    }
    const page = await this.#http("GET", "/", undefined, undefined);
    if (!page.text.includes(MOCK_APP_MARKER)) {
      throw new ControllerError("TARGET_ERROR", `${this.#origin} does not serve the mock Extranet app`);
    }
    this.#launched = true;
    this.#tabs.clear();
    this.#lastIds = {};
    this.#actor = undefined;
    await this.openTab();
  }

  async openTab(url?: string, opts?: ActionOptions): Promise<string> {
    this.#requireLaunched();
    const id = `tab-${++this.#tabSeq}`;
    this.#tabs.set(id, { id, history: [], index: -1, view: undefined, title: "", status: undefined, fields: {}, reportGenerated: false });
    this.#active = id;
    if (url !== undefined) await this.navigate(url, opts);
    return id;
  }

  async closeTab(tabId?: string): Promise<void> {
    this.#requireLaunched();
    const id = tabId ?? this.#active;
    if (!id || !this.#tabs.delete(id)) throw new ControllerError("NO_TAB", `no such tab: ${String(id)}`);
    if (this.#active === id) this.#active = [...this.#tabs.keys()].at(-1);
  }

  async navigate(url: string, opts?: ActionOptions): Promise<void> {
    this.#requireLaunched();
    if (!this.#active) await this.openTab();
    const tab = this.#tab();
    const { url: abs } = this.#resolveUrl(url);
    await this.#load(tab, abs, opts);
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push({ url: abs });
    tab.index = tab.history.length - 1;
  }

  async reload(opts?: ActionOptions): Promise<void> {
    const tab = this.#tab();
    const entry = tab.history[tab.index];
    if (!entry) throw new ControllerError("NO_HISTORY", "nothing to reload");
    await this.#load(tab, entry.url, opts);
  }

  async back(opts?: ActionOptions): Promise<void> {
    const tab = this.#tab();
    const entry = tab.history[tab.index - 1];
    if (!entry) throw new ControllerError("NO_HISTORY", "no previous page in this tab");
    await this.#load(tab, entry.url, opts);
    tab.index -= 1;
  }

  async forward(opts?: ActionOptions): Promise<void> {
    const tab = this.#tab();
    const entry = tab.history[tab.index + 1];
    if (!entry) throw new ControllerError("NO_HISTORY", "no next page in this tab");
    await this.#load(tab, entry.url, opts);
    tab.index += 1;
  }

  async click(selector: string, opts?: ActionOptions): Promise<void> {
    const tab = this.#tab();
    const p = parseSelector(selector);
    if (p.kind === "unknown") throw new ControllerError("ELEMENT_NOT_FOUND", `no element matches ${selector}`);
    if (!(await this.#visible(tab, p, opts))) {
      const exists = p.kind !== "id" || this.#locate(p.id) !== undefined;
      throw new ControllerError(exists ? "NOT_VISIBLE" : "ELEMENT_NOT_FOUND", `${selector} is not visible in the current view (${tab.view ?? "no page"})`);
    }

    if (p.kind === "nav") {
      tab.view = p.view;
      return;
    }
    if (p.kind === "cancel") {
      const rows = await this.#options("reservation", opts);
      const id = p.ref === undefined ? rows[0]?.id : this.#resolveRef(p.ref, "reservation");
      if (!id) throw new ControllerError("ELEMENT_NOT_FOUND", "no reservation row to cancel");
      await this.#submit({ path: `/api/reservations/${encodeURIComponent(id)}/cancel`, body: {} }, opts);
      return;
    }
    const action =
      p.kind === "action"
        ? VIEWS.flatMap((v) => v.actions).find((a) => a.dataAction === p.dataAction)
        : p.kind === "id"
          ? this.#locate(p.id)?.action
          : undefined;
    if (!action) return; // clicking a field, table or panel has no side effect

    const view = findView(tab.view ?? "");
    const selectDefaults = new Map<string, string>();
    for (const f of view?.fields ?? []) {
      if (f.tag === "select" && f.options && tab.fields[f.id] === undefined) {
        selectDefaults.set(f.id, (await this.#options(f.options, opts))[0]?.id ?? "");
      }
    }
    const read = (id: string): string =>
      tab.fields[id] ?? selectDefaults.get(id) ?? this.#fieldIn(view, id)?.defaultValue ?? "";
    const json = await this.#submit(action.request(read), opts);

    if (action.creates) {
      const created = (json as Record<string, { id?: string }> | undefined)?.[action.creates.responseKey];
      if (created?.id) this.#lastIds[action.creates.kind] = created.id;
    }
    if (action.effect === "login") this.#actor = read("login-username");
    if (action.effect === "report") tab.reportGenerated = true;
  }

  async #submit(req: { path: string; body: Record<string, unknown> }, opts: ActionOptions | undefined): Promise<unknown> {
    const res = await this.#http("POST", req.path, req.body, opts);
    if (res.status < 200 || res.status >= 300) {
      const msg = (res.json as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
      throw new ControllerError("TARGET_ERROR", `${req.path} rejected: ${msg}`, res.status >= 500 || res.status === 429);
    }
    return res.json;
  }

  async #field(selector: string, want: "text" | "select", opts: ActionOptions | undefined): Promise<{ tab: TabState; field: FieldSpec }> {
    const tab = this.#tab();
    const p = parseSelector(selector);
    const loc = p.kind === "id" && !p.attr ? this.#locate(p.id) : undefined;
    if (!loc) throw new ControllerError("ELEMENT_NOT_FOUND", `no element matches ${selector}`);
    if (!(await this.#visible(tab, p, opts))) throw new ControllerError("NOT_VISIBLE", `${selector} is not visible in the current view (${tab.view ?? "no page"})`);
    const field = loc.field;
    if (!field) throw new ControllerError("WRONG_ELEMENT", `${selector} is not a form field`);
    if (want === "select" && field.tag !== "select") throw new ControllerError("WRONG_ELEMENT", `${selector} is not a <select>`);
    if (want === "text" && field.tag === "select") throw new ControllerError("WRONG_ELEMENT", `${selector} is a <select>; use select`);
    return { tab, field };
  }

  async type(selector: string, value: string, opts?: ActionOptions): Promise<void> {
    const { tab, field } = await this.#field(selector, "text", opts);
    tab.fields[field.id] = this.#resolveRef(value, undefined);
  }

  async select(selector: string, value: string, opts?: ActionOptions): Promise<void> {
    const { tab, field } = await this.#field(selector, "select", opts);
    const id = this.#resolveRef(value, field.options);
    const options = field.options ? await this.#options(field.options, opts) : [];
    if (!options.some((o) => o.id === id)) {
      throw new ControllerError("OPTION_NOT_FOUND", `${selector} has no option "${id}"`);
    }
    tab.fields[field.id] = id;
  }

  async waitFor(selector: string, opts?: ActionOptions): Promise<void> {
    const tab = this.#tab();
    const p = parseSelector(selector);
    const deadline = Date.now() + (opts?.timeoutMs ?? this.#defaultTimeoutMs);
    for (;;) {
      if (opts?.signal?.aborted) throw new ControllerError("ABORTED", "waitFor aborted");
      if (await this.#visible(tab, p, opts)) return;
      if (Date.now() >= deadline) throw new ControllerError("TIMEOUT", `timed out waiting for ${selector}`, true);
      await new Promise((r) => setTimeout(r, this.#pollMs));
    }
  }

  async captureState(opts?: ActionOptions): Promise<PageState> {
    const tab = this.#tab();
    const [properties, rooms, reservations] = await Promise.all([
      this.#options("property", opts),
      this.#options("room", opts),
      this.#options("reservation", opts),
    ]);
    const events = await this.#http("GET", "/api/events?since=1000000000", undefined, opts);
    const entities: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#lastIds)) if (v) entities[k] = v;
    return {
      url: this.getCurrentUrl(),
      tabId: tab.id,
      ...(tab.view !== undefined ? { view: tab.view } : {}),
      fields: redactValue({ ...tab.fields }),
      entities,
      server: {
        properties: properties.length,
        rooms: rooms.length,
        reservations: reservations.length,
        confirmed: reservations.filter((r) => r.status === "confirmed").length,
        cancelled: reservations.filter((r) => r.status === "cancelled").length,
        events: Number((events.json as { total?: number } | undefined)?.total ?? 0),
      },
      capturedAt: Date.now(),
    };
  }

  async captureScreenshot(): Promise<ScreenshotResult> {
    return {
      supported: false,
      reason: "MockExtranetController drives the page model over HTTP and has no rendering surface; use a browser-backed controller for screenshots",
    };
  }

  getCurrentUrl(): string {
    const tab = this.#active ? this.#tabs.get(this.#active) : undefined;
    return tab?.history[tab.index]?.url ?? "about:blank";
  }

  async getPageMetadata(): Promise<PageMetadata> {
    const tab = this.#tab();
    return {
      url: this.getCurrentUrl(),
      title: tab.title,
      tabId: tab.id,
      ...(tab.view !== undefined ? { app: "mock-extranet", view: tab.view } : {}),
      ...(tab.status !== undefined ? { status: tab.status } : {}),
    };
  }

  async snapshot(): Promise<ControllerSnapshot> {
    return structuredClone({
      tabs: [...this.#tabs.values()],
      active: this.#active ?? null,
      lastIds: this.#lastIds,
      actor: this.#actor ?? null,
      tabSeq: this.#tabSeq,
    });
  }

  async restore(snapshot: ControllerSnapshot): Promise<void> {
    const s = structuredClone(snapshot) as {
      tabs: TabState[];
      active: string | null;
      lastIds: Partial<Record<EntityKind, string>>;
      actor: string | null;
      tabSeq: number;
    };
    this.#tabs = new Map(s.tabs.map((t) => [t.id, t]));
    this.#active = s.active ?? undefined;
    this.#lastIds = s.lastIds;
    this.#actor = s.actor ?? undefined;
    this.#tabSeq = s.tabSeq;
  }

  async close(): Promise<void> {
    this.#tabs.clear();
    this.#active = undefined;
    this.#launched = false;
  }
}
