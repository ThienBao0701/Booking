/**
 * Settings: service status, analysis rule configuration (validated in the
 * browser with the shared validator, then fail-closed again by the service),
 * display theme and sign-out.
 */

import { validateRuleSet } from "../shared.ts";
import type { PageRender } from "../context.ts";
import { h, mount } from "../dom.ts";
import { fmtDuration, label } from "../format.ts";
import { table } from "../components/table.ts";
import { button, card, chip, errorBox, kv, pageHeader, severityBadge } from "../components/ui.ts";
import { type Theme, getTheme, setTheme } from "../theme.ts";
import { signOut } from "../session.ts";

export const renderSettings: PageRender = async (ctx, main) => {
  const [health, handshake, rules, shots] = await Promise.all([ctx.api.health(), ctx.api.handshake(), ctx.api.rules(), ctx.api.screenshotSettings()]);
  if (!ctx.alive()) return;

  // Screenshot storage (Phase 12): off by default; explicit switch + limits.
  const MB = 1024 * 1024;
  const sEnabled = h("input", { type: "checkbox", id: "shot-enabled", checked: shots.settings.enabled }) as HTMLInputElement;
  const sDays = h("input", { type: "number", id: "shot-days", min: 1, max: 365, value: shots.settings.retentionDays }) as HTMLInputElement;
  const sImage = h("input", { type: "number", id: "shot-image", min: 1, max: 20, step: 1, value: Math.round(shots.settings.maxImageBytes / MB) }) as HTMLInputElement;
  const sTotal = h("input", { type: "number", id: "shot-total", min: 1, max: 10240, step: 1, value: Math.round(shots.settings.maxTotalBytes / MB) }) as HTMLInputElement;
  const sFeedback = h("div", { class: "feedback", role: "status", "aria-live": "polite" });
  const saveShots = () => {
    const next = { enabled: sEnabled.checked, retentionDays: Number(sDays.value), maxImageBytes: Number(sImage.value) * MB, maxTotalBytes: Number(sTotal.value) * MB };
    if (next.enabled && !shots.settings.enabled && !window.confirm("Store screenshot images on this machine? Screenshots can show personal or confidential data; they are kept locally and deleted after the retention period.")) return;
    void ctx.api
      .putScreenshotSettings(next)
      .then((r) => mount(sFeedback, h("p", { class: "ok-box" }, `Saved: storage ${r.settings.enabled ? "enabled" : "disabled"}.`)))
      .catch((err) => mount(sFeedback, errorBox(err)));
  };
  const retentionNow = () => {
    void ctx.api
      .applyScreenshotRetention()
      .then((r) => mount(sFeedback, h("p", { class: "ok-box" }, `Retention applied: ${r.deleted} image(s), ${r.orphans} orphaned file(s) removed.`)))
      .catch((err) => mount(sFeedback, errorBox(err)));
  };

  const editor = h("textarea", { class: "rules-editor", rows: 18, spellcheck: "false", "aria-label": "Rule set JSON" }) as HTMLTextAreaElement;
  editor.value = JSON.stringify(rules.rules, null, 2);
  const feedback = h("div", { class: "feedback", role: "status", "aria-live": "polite" });
  const parse = (): unknown => {
    try {
      return JSON.parse(editor.value);
    } catch (err) {
      mount(feedback, h("p", { class: "error-box" }, `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return undefined;
    }
  };
  const validate = (): boolean => {
    const input = parse();
    if (input === undefined) return false;
    const v = validateRuleSet(input);
    if (!v.ok) {
      mount(feedback, h("div", { class: "error-box" }, h("strong", null, `${v.errors.length} problem(s) — the rule set would be rejected:`), h("ul", null, ...v.errors.slice(0, 50).map((e) => h("li", null, e)))));
      return false;
    }
    mount(feedback, h("p", { class: "ok-box" }, `Valid: ${v.value.rules.length} rule(s).`));
    return true;
  };
  const save = () => {
    if (!validate()) return;
    void ctx.api
      .putRules(parse())
      .then((r) => {
        mount(feedback, h("p", { class: "ok-box" }, `Saved ${r.rules} rule(s) (version ${r.version}). New analyses use them; use “Re-run analysis” on a session to refresh its findings.`));
      })
      .catch((err) => mount(feedback, errorBox(err)));
  };
  const reset = () => {
    if (!window.confirm("Replace the custom rule set with the built-in rules?")) return;
    void ctx.api
      .resetRules()
      .then(() => ctx.setParams({ t: String(Date.now()) }))
      .catch((err) => mount(feedback, errorBox(err)));
  };

  const themeSel = h("select", { "aria-label": "Theme" }, ...(["system", "light", "dark"] as Theme[]).map((t) => h("option", { value: t, selected: t === getTheme() }, label(t)))) as HTMLSelectElement;
  themeSel.addEventListener("change", () => setTheme(themeSel.value as Theme));

  mount(
    main,
    pageHeader("Settings"),
    h(
      "div",
      { class: "grid-2" },
      card("Service", kv([
        ["Status", String(health.status ?? "?")],
        ["Uptime", fmtDuration(Number(health.uptimeMs ?? 0))],
        ["Safety mode", chip(String(health.safetyMode ?? "?"))],
        ["Lab version", String(handshake.labVersion ?? "?")],
        ["Contract version", String(handshake.contractVersion ?? "?")],
        ["Schema version", String(health.schemaVersion ?? "?")],
        ["Live subscribers", String(health.busSubscribers ?? 0)],
      ])),
      card("Display & session", kv([
        ["Theme", themeSel],
        ["Token", h("span", null, "held in this tab only ", button("Sign out", signOut, "btn-ghost"))],
      ])),
    ),
    card(
      "Screenshot storage",
      h("p", { class: "muted small" }, "Off by default. When on, the extension uploads the PNG of each screenshot the operator captures, and replay screenshot steps are kept. Images stay on this machine, need the token to view, and are deleted after the retention period."),
      kv([
        ["Store images", h("label", null, sEnabled, " enabled")],
        ["Retention (days)", sDays],
        ["Max image size (MiB)", sImage],
        ["Storage budget (MiB)", sTotal],
        ["In use", `${shots.usage.count} image(s), ${(shots.usage.bytes / MB).toFixed(1)} MiB`],
        ["Load problem", shots.error ?? "none"],
      ]),
      h("div", { class: "actions" }, button("Save screenshot settings", saveShots, "btn-primary"), button("Apply retention now", retentionNow, "btn-ghost")),
      sFeedback,
    ),
    card(
      "Analysis rules",
      kv([
        ["Source", rules.source === "custom" ? chip("custom (data dir)") : chip("built-in")],
        ["Version", h("code", null, rules.version)],
        ["Rules", `${rules.rules.rules.length} (${rules.rules.rules.filter((r) => r.enabled !== false).length} enabled)`],
        ["Load problem", rules.error ?? "none"],
      ]),
      table(rules.rules.rules, [
        { title: "Rule", cell: (r) => h("code", null, r.id) },
        { title: "On", cell: (r) => (r.enabled === false ? "off" : "on") },
        { title: "Condition", cell: (r) => r.when.type },
        { title: "Category", cell: (r) => label(r.category) },
        { title: "Severity", cell: (r) => severityBadge(r.severity) },
        { title: "Base confidence", cell: (r) => String(r.confidence), cls: "num" },
        { title: "Title", cell: (r) => r.title },
      ]),
      h("h3", null, "Edit rule set (JSON)"),
      h("p", { class: "muted small" }, "Rules are validated fail-closed: unknown fields, invalid regexes, confidence of 1.0, unknown placeholders, and wording that presents a finding as proof of platform enforcement are rejected."),
      editor,
      h("div", { class: "actions" }, button("Validate", () => void validate()), button("Save", save, "btn-primary"), button("Reset to built-in rules", reset, "btn-ghost")),
      feedback,
    ),
  );
};
