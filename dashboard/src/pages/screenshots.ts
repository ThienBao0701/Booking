/**
 * Screenshots: stored images (when storage is enabled in Settings) and the
 * hash-only capture records of every user-triggered screenshot. Images are
 * fetched with the token and shown as blob URLs; delete one or a session's.
 */

import type { ScreenshotRecord } from "../shared.ts";
import type { Ctx, PageRender } from "../context.ts";
import { type Child, h, mount } from "../dom.ts";
import { fmtBytes, fmtInt, fmtTime, parseData, shortId } from "../format.ts";
import { buildHash, resolveRange } from "../route.ts";
import { filterBar } from "../components/filters.ts";
import { pager, table } from "../components/table.ts";
import { button, card, empty, errorBox, kv, link, pageHeader, workflowChip } from "../components/ui.ts";

const PAGE = 24;
let blobUrls: string[] = [];

function releaseBlobs(): void {
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls = [];
}

function imageCard(ctx: Ctx, r: ScreenshotRecord, onDelete: () => void): HTMLElement {
  const img = h("img", { class: "shot-img", alt: `Screenshot ${r.sha256.slice(0, 12)} (${r.width}×${r.height})`, width: r.width, height: r.height, loading: "lazy" }) as HTMLImageElement;
  const status = h("span", { class: "muted small", role: "status" });
  void ctx.api
    .screenshotImage(r.id)
    .then((url) => {
      if (!ctx.alive()) return URL.revokeObjectURL(url);
      blobUrls.push(url);
      img.src = url;
    })
    .catch((err) => mount(status, errorBox(err)));
  const del = button("Delete", () => {
    if (!window.confirm("Delete this screenshot image? The recorded event (hash only) is kept.")) return;
    void ctx.api.deleteScreenshot(r.id).then(onDelete).catch((err) => mount(status, errorBox(err)));
  }, "btn-ghost");
  del.setAttribute("data-delete", r.id);
  return h(
    "figure",
    { class: "shot", "data-shot": r.id },
    h("a", { href: "#/screenshots", class: "shot-frame", on: { click: (e) => { e.preventDefault(); if (img.src) window.open(img.src, "_blank", "noopener"); } } }, img),
    h(
      "figcaption",
      null,
      h("div", null, fmtTime(r.ts), " · ", r.source === "replay" ? `replay ${shortId(r.run_id ?? "", 8)} / ${r.step_id ?? ""}` : "capture"),
      h("div", { class: "muted small" }, `${r.width}×${r.height} · ${fmtBytes(r.bytes)} · sha256 ${r.sha256.slice(0, 12)}`),
      h(
        "div",
        { class: "shot-actions" },
        r.session_id ? link(buildHash("sessions", {}, r.session_id), shortId(r.session_id, 10)) : null,
        r.workflow ? workflowChip(r.workflow) : null,
        r.event_id ? h("button", { type: "button", class: "linklike small", on: { click: () => ctx.openEvent(r.event_id as string) } }, "event") : null,
        del,
      ),
      status,
    ),
  );
}

export const renderScreenshots: PageRender = async (ctx, main) => {
  releaseBlobs();
  const p = ctx.route.params;
  const { from, to } = resolveRange(p, ctx.now);
  const offset = Number(p.offset ?? 0) || 0;
  const [ids, cfg, stored, records] = await Promise.all([
    ctx.recentSessions(),
    ctx.api.screenshotSettings(),
    ctx.api.screenshots({ session: p.session, from, to, limit: PAGE, offset }),
    ctx.api.events({ kind: "SCREENSHOT", session: p.session, from, to, limit: 50 }),
  ]);
  if (!ctx.alive()) return;
  const refresh = () => ctx.setParams({ ...p, t: String(Date.now()) });
  const md = (data: string) => (parseData(data).metadata ?? {}) as Record<string, unknown>;
  const storedByEvent = new Map(stored.screenshots.filter((s) => s.event_id).map((s) => [s.event_id as string, s]));
  const s = cfg.settings;
  const children: Child[] = [
    pageHeader(
      "Screenshots",
      `${fmtInt(stored.total)} stored image(s) · ${fmtInt(records.total)} capture record(s).`,
      p.session
        ? button("Delete this session's images", () => {
            if (!window.confirm(`Delete every stored screenshot image of session ${p.session}?`)) return;
            void ctx.api.deleteSessionScreenshots(p.session as string).then(refresh);
          }, "btn-ghost")
        : null,
    ),
    h(
      "p",
      { class: "note", role: "note" },
      s.enabled
        ? `Image storage is ON: PNGs up to ${fmtBytes(s.maxImageBytes)}, kept ${s.retentionDays} day(s), ${fmtBytes(cfg.usage.bytes)} of ${fmtBytes(s.maxTotalBytes)} used. `
        : "Image storage is OFF (default): only a capture record (time, page, size) is kept for each screenshot. ",
      "Screenshots are taken only on an explicit operator action. ",
      link(buildHash("settings"), "Change in Settings"),
    ),
    filterBar({ params: p, show: ["range", "session"], sessions: ids, onChange: ctx.setParams }),
    stored.screenshots.length
      ? h("div", { class: "shot-grid" }, ...stored.screenshots.map((r) => imageCard(ctx, r, refresh)))
      : empty(s.enabled ? "No stored images in this selection yet." : "No stored images."),
    stored.total > PAGE ? pager(stored.total, offset, PAGE, (o) => ctx.setParams({ ...p, offset: String(o) })) : null,
    card(
      "Capture records",
      records.events.length === 0
        ? empty("No screenshot records. Use “Capture screenshot” in the extension popup while recording.")
        : table(
            records.events,
            [
              { title: "Time", cell: (e) => fmtTime(e.ts) },
              { title: "Session", cell: (e) => link(buildHash("sessions", {}, e.session_id), shortId(e.session_id, 8)) },
              { title: "Workflow", cell: (e) => workflowChip(e.workflow) },
              {
                title: "SHA-256",
                // The event's hash field is masked at rest by the privacy redaction; stored images carry the service-computed digest.
                cell: (e) => (storedByEvent.get(e.id) ? h("code", { class: "small", title: storedByEvent.get(e.id)?.sha256 }, (storedByEvent.get(e.id)?.sha256 ?? "").slice(0, 16)) : h("span", { class: "muted small" }, "masked")),
              },
              { title: "Size", cell: (e) => fmtBytes(typeof md(e.data).bytes === "number" ? (md(e.data).bytes as number) : null), cls: "num" },
              { title: "Image", cell: (e) => (storedByEvent.has(e.id) ? "stored" : h("span", { class: "muted" }, "not stored")) },
            ],
            { onRow: (e) => ctx.openEvent(e.id), rowLabel: (e) => `Open screenshot record ${e.id}` },
          ),
    ),
    card("Storage", kv([
      ["Status", s.enabled ? "enabled" : "disabled"],
      ["Images / files", `${fmtInt(cfg.usage.count)} / ${fmtInt(cfg.usage.files)}`],
      ["Used", `${fmtBytes(cfg.usage.bytes)} of ${fmtBytes(s.maxTotalBytes)}`],
      ["Oldest", cfg.usage.oldest ? fmtTime(cfg.usage.oldest) : "—"],
    ])),
  ];
  mount(main, ...children);
};
