/** Environment reports across sessions; values that differ from the most common one are marked (≠), not only coloured. */

import type { EnvironmentReport } from "../shared.ts";
import type { PageRender } from "../context.ts";
import { type Child, h, mount } from "../dom.ts";
import { fmtDuration, fmtInt, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { modeOf } from "../data.ts";
import { filterBar } from "../components/filters.ts";
import { table } from "../components/table.ts";
import { empty, link, pageHeader } from "../components/ui.ts";

type Field = { title: string; get: (e: EnvironmentReport) => unknown; show: (e: EnvironmentReport) => string };

const size = (v: { width: number; height: number } | undefined) => (v ? `${v.width} × ${v.height}` : "—");
const FIELDS: Field[] = [
  { title: "Browser", get: (e) => (e.browser ? `${e.browser} ${e.browser_major ?? ""}` : undefined), show: (e) => (e.browser ? `${e.browser} ${e.browser_major ?? ""}`.trim() : "—") },
  { title: "Platform", get: (e) => e.platform, show: (e) => e.platform ?? "—" },
  { title: "Language", get: (e) => e.language, show: (e) => e.language ?? "—" },
  { title: "Timezone", get: (e) => e.timezone, show: (e) => e.timezone ?? "—" },
  { title: "Viewport", get: (e) => e.viewport, show: (e) => size(e.viewport) },
  { title: "Screen", get: (e) => e.screen, show: (e) => size(e.screen) },
  { title: "Pixel ratio", get: (e) => e.device_pixel_ratio, show: (e) => (e.device_pixel_ratio === undefined ? "—" : String(e.device_pixel_ratio)) },
  { title: "Colour scheme", get: (e) => e.color_scheme, show: (e) => e.color_scheme ?? "—" },
  { title: "Extension", get: (e) => e.extension_version, show: (e) => e.extension_version ?? "—" },
];

export const renderEnvironment: PageRender = async (ctx, main) => {
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const ids = await ctx.recentSessions();
  const list = p.session ? [p.session] : (await ctx.api.sessions({ from, to, limit: 200 })).sessions.map((s) => s.id);
  const envs = list.length ? (await ctx.api.environments(list)).environments : [];
  if (!ctx.alive()) return;
  const captured = envs.filter((e) => e.captured);
  const modes = FIELDS.map((f) => modeOf(captured, f.get));
  mount(
    main,
    pageHeader("Environment", `Recorded browser and page facts for ${fmtInt(envs.length)} session(s); ${fmtInt(captured.length)} with a capture. Nothing is inferred or altered.`),
    filterBar({ params: p, show: ["range", "session"], sessions: ids, onChange: ctx.setParams }),
    envs.length === 0
      ? empty("No sessions in this selection.")
      : table(envs, [
          { title: "Session", cell: (e) => link(buildHash("sessions", {}, e.session_id), shortId(e.session_id, 10)) },
          {
            title: "Captured",
            cell: (e) =>
              e.captured ? h("button", { type: "button", class: "linklike", on: { click: () => ctx.openEvent(e.source_event_ids[0] ?? "") } }, `yes (${e.source_event_ids.length} event${e.source_event_ids.length === 1 ? "" : "s"})`) : h("span", { class: "muted" }, "no"),
          },
          ...FIELDS.map((f, i) => ({
            title: f.title,
            cell: (e: EnvironmentReport): Child => {
              const v = f.get(e);
              const differs = e.captured && v !== undefined && modes[i] !== undefined && JSON.stringify(v) !== modes[i];
              return differs ? h("span", { class: "differs", title: "differs from the most common value" }, h("span", { "aria-hidden": "true" }, "≠ "), f.show(e)) : f.show(e);
            },
          })),
          { title: "Duration", cell: (e) => fmtDuration(e.session_duration_ms), cls: "num" },
        ]),
    h("p", { class: "muted small" }, "≠ marks a value that differs from the most common value among captured sessions in this selection. Sessions recorded before environment capture existed show “no”."),
  );
};
