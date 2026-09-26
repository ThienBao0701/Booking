/**
 * Dashboard shell: token bootstrap (fragment → sessionStorage), navigation,
 * hash router, theme. Pages render into <main>; data comes only from the
 * authenticated same-origin API.
 */

import { Api } from "./api.ts";
import type { Ctx, PageRender } from "./context.ts";
import { h, mount } from "./dom.ts";
import { type Page, buildHash, parseRoute } from "./route.ts";
import { isPlausibleToken } from "./token.ts";
import { readToken, storeToken } from "./session.ts";
import { closeDrawer, openEventDrawer } from "./components/drawer.ts";
import { hideTooltip } from "./components/tooltip.ts";
import { errorBox } from "./components/ui.ts";
import { renderOverview } from "./pages/overview.ts";
import { renderSessions } from "./pages/sessions.ts";
import { renderCompare } from "./pages/compare.ts";
import { renderTimeline } from "./pages/timeline.ts";
import { renderWorkflows } from "./pages/workflows.ts";
import { renderEvents } from "./pages/events.ts";
import { renderFindings } from "./pages/findings.ts";
import { renderEnvironment } from "./pages/environment.ts";
import { renderRuns } from "./pages/runs.ts";
import { renderScreenshots } from "./pages/screenshots.ts";
import { renderReports } from "./pages/reports.ts";
import { renderSettings } from "./pages/settings.ts";
import { applyTheme } from "./theme.ts";

const NAV: Array<[Page, string]> = [
  ["overview", "Overview"],
  ["sessions", "Sessions"],
  ["timeline", "Timeline"],
  ["workflows", "Workflows"],
  ["events", "Events"],
  ["findings", "Findings"],
  ["environment", "Environment"],
  ["runs", "Runs"],
  ["screenshots", "Screenshots"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

const PAGES: Record<Page, PageRender> = {
  overview: renderOverview,
  sessions: renderSessions,
  compare: renderCompare,
  timeline: renderTimeline,
  workflows: renderWorkflows,
  events: renderEvents,
  findings: renderFindings,
  environment: renderEnvironment,
  runs: renderRuns,
  screenshots: renderScreenshots,
  reports: renderReports,
  settings: renderSettings,
};

function signIn(app: HTMLElement, reason?: string): void {
  const input = h("input", { type: "password", id: "token", name: "token", autocomplete: "off", spellcheck: "false", required: true, "aria-describedby": "token-help" }) as HTMLInputElement;
  const status = h("p", { class: "muted", role: "status" }, reason ?? "");
  const form = h(
    "form",
    { class: "signin card" },
    h("h1", null, "Lab dashboard"),
    h("p", null, "Paste the service token to continue. It stays in this browser tab (sessionStorage) and is sent only to this local service."),
    h("label", { for: "token" }, "Service token"),
    input,
    h("p", { id: "token-help", class: "muted small" }, "Find it in <LAB_DATA_DIR>/auth-token.txt, or open the link printed by `pnpm run dashboard:url`."),
    h("button", { type: "submit", class: "btn btn-primary" }, "Open dashboard"),
    status,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!isPlausibleToken(t)) {
      mount(status, "That does not look like a service token.");
      return;
    }
    void new Api(t)
      .handshake()
      .then(() => {
        storeToken(t);
        start(app, t);
      })
      .catch(() => mount(status, "The service rejected this token."));
  });
  mount(app, h("div", { class: "signin-wrap" }, form));
  input.focus();
}

function start(app: HTMLElement, token: string): void {
  const api = new Api(token);
  api.onUnauthorized = () => signIn(app, "The token was rejected (it may have been rotated). Paste the current token.");
  const main = h("main", { id: "main", tabindex: -1 });
  const navLinks = NAV.map(([page, text]) => h("a", { href: buildHash(page), "data-page": page }, text));
  const search = h("input", { type: "search", placeholder: "Search events…", "aria-label": "Search events", maxlength: 200 }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && search.value.trim()) location.hash = buildHash("events", { q: search.value.trim() });
  });
  const mode = h("span", { class: "chip", title: "Service safety mode" }, "…");
  mount(
    app,
    h("a", { class: "skip", href: "#/overview", on: { click: (e) => { e.preventDefault(); main.focus(); } } }, "Skip to content"),
    h(
      "div",
      { class: "shell" },
      h(
        "nav",
        { class: "sidebar", "aria-label": "Pages" },
        h("div", { class: "brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, "◆"), "Automation Lab"),
        h("div", { class: "brand-sub" }, "Forensic dashboard · local"),
        ...navLinks,
      ),
      h("div", { class: "content" }, h("div", { class: "topbar" }, search, h("span", { class: "spacer" }), h("span", { class: "muted small" }, "Safety mode "), mode), main),
    ),
  );
  void api
    .health()
    .then((hl) => mount(mode, String(hl.safetyMode ?? "?")))
    .catch(() => mount(mode, "offline"));

  let cache: { at: number; ids: string[] } | undefined;
  let generation = 0;
  const render = async () => {
    const gen = ++generation;
    closeDrawer();
    hideTooltip();
    const route = parseRoute(location.hash);
    for (const a of navLinks) {
      const active = a.dataset.page === route.page || (route.page === "compare" && a.dataset.page === "sessions");
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    const ctx: Ctx = {
      api,
      route,
      now: Date.now(),
      alive: () => gen === generation,
      go: (page, params = {}, id) => {
        location.hash = buildHash(page, params, id);
      },
      setParams: (params) => {
        location.hash = buildHash(route.page, params, route.id);
      },
      openEvent: (id) => void openEventDrawer(api, id),
      recentSessions: async () => {
        if (!cache || Date.now() - cache.at > 30_000) cache = { at: Date.now(), ids: (await api.sessions({ limit: 100 })).sessions.map((x) => x.id) };
        return cache.ids;
      },
    };
    main.classList.add("refreshing");
    try {
      await PAGES[route.page](ctx, main);
    } catch (err) {
      if (ctx.alive()) mount(main, errorBox(err));
    } finally {
      if (ctx.alive()) main.classList.remove("refreshing");
    }
  };
  window.addEventListener("hashchange", () => void render());
  if (!location.hash || location.hash === "#") history.replaceState(null, "", `${location.pathname}#/overview`);
  void render();
}

applyTheme();
const app = document.getElementById("app") as HTMLElement;
const token = readToken();
if (token) start(app, token);
else signIn(app);
