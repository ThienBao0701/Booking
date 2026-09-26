/**
 * Replay (Phase 13): plan a workflow as a dry run, review what it would do,
 * then start it with an explicit operator action and control it live.
 *
 * Before Start the page shows the target, the authorization decision (and the
 * browser allowlist), the workflow, the step count and the risk notice. Start
 * stays disabled until the operator ticks the acknowledgement; the service
 * additionally requires the plan's single-use confirmation token, which lives
 * only in this page's memory. Parameter values are sent for the run only.
 */

import { SAFETY_MODES, type ReplayControlAction, type ReplayLibraryEntry, type ReplayLogEntry, type ReplayPlanView, type ReplayPrepareResult, type ReplayRunStatus, type SafetyMode } from "../shared.ts";
import { ApiError } from "../api.ts";
import type { Ctx, PageRender } from "../context.ts";
import { type Child, h, mount } from "../dom.ts";
import { fmtClock, fmtDuration, fmtInt, fmtTime, shortId } from "../format.ts";
import { buildHash } from "../route.ts";
import { table } from "../components/table.ts";
import { button, card, chip, empty, kv, link, pageHeader, statusBadge } from "../components/ui.ts";

const POLL_MS = 1000;
const TERMINAL = new Set(["completed", "stopped"]);

/** Human-readable API failure (the replay routes return `{error, message}`). */
function problem(err: unknown): HTMLElement {
  let text = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError) {
    const msg = (err.details as { message?: unknown } | undefined)?.message;
    text = `${err.code}${typeof msg === "string" && msg !== err.code ? ` — ${msg}` : ""}`;
    const list = (err.details as { details?: unknown } | undefined)?.details;
    if (Array.isArray(list) && list.length) {
      return h("div", { class: "error-box", role: "alert" }, h("strong", null, text), h("ul", null, ...list.slice(0, 20).map((x) => h("li", null, String(x)))));
    }
  }
  return h("div", { class: "error-box", role: "alert" }, h("strong", null, "Refused: "), text);
}

function lines(v: string): string[] {
  return v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

export const renderReplay: PageRender = async (ctx, main) => {
  if (ctx.route.id) return renderRunView(ctx, main, ctx.route.id);
  const [lib, runs] = await Promise.all([ctx.api.replayWorkflows(), ctx.api.replayRuns()]);
  if (!ctx.alive()) return;
  const sessions = await ctx.recentSessions().catch(() => [] as string[]);
  if (!ctx.alive()) return;
  const serviceMode = lib.serviceMode;

  // ---- form ----
  const valid = lib.workflows.filter((w) => w.valid);
  const wfSel = h(
    "select",
    { id: "replay-workflow", name: "workflow" },
    ...(["examples", "library"] as const).map((src) => {
      const items = lib.workflows.filter((w) => w.source === src);
      if (!items.length) return null;
      return h(
        "optgroup",
        { label: src === "examples" ? "Bundled examples" : "Library (LAB_WORKFLOWS_DIR)" },
        ...items.map((w) => h("option", { value: w.id, disabled: !w.valid, selected: w.id === ctx.route.params.workflow }, `${w.name} · ${w.steps} steps${w.valid ? "" : " · invalid"}`)),
      );
    }),
    sessions.length ? h("optgroup", { label: "Draft from a recording (local mock)" }, ...sessions.slice(0, 30).map((id) => h("option", { value: `session:${id}` }, `recording ${shortId(id, 14)}`))) : null,
  ) as HTMLSelectElement;
  const modeSel = h("select", { id: "replay-mode", name: "mode" }, ...SAFETY_MODES.map((m) => h("option", { value: m, selected: m === "SIMULATE" }, m))) as HTMLSelectElement;
  const ctlSel = h("select", { id: "replay-controller", name: "controller" }, h("option", { value: "mock", selected: true }, "Mock controller (in-process, mock Extranet only)"), h("option", { value: "browser" }, "Real browser (Chromium, allowlisted origins)")) as HTMLSelectElement;
  const allow = h("textarea", { id: "replay-allow", rows: 2, spellcheck: "false", placeholder: "http://127.0.0.1:4599" }) as HTMLTextAreaElement;
  const resources = h("textarea", { id: "replay-resources", rows: 2, spellcheck: "false", placeholder: "optional: origins allowed for subresources only" }) as HTMLTextAreaElement;
  const browserFields = h(
    "div",
    { class: "replay-browser", hidden: true },
    h("label", { for: "replay-allow" }, "Allowed origins (navigation + requests), one per line"),
    allow,
    h("label", { for: "replay-resources" }, "Resource-only origins"),
    resources,
  );
  ctlSel.addEventListener("change", () => {
    browserFields.hidden = ctlSel.value !== "browser";
  });

  const paramBox = h("div", { class: "replay-params" });
  const paramInputs = new Map<string, HTMLInputElement>();
  const renderParams = (names: string[], values: Record<string, string> = {}) => {
    const keep = new Map([...paramInputs].map(([k, el]) => [k, el.value]));
    paramInputs.clear();
    if (!names.length) {
      mount(paramBox, h("p", { class: "muted small" }, "This workflow takes no parameters."));
      return;
    }
    mount(
      paramBox,
      h("p", { class: "muted small" }, "Test data for {{placeholders}}. Used for this run only; never stored or logged."),
      ...names.map((n) => {
        const input = h("input", { type: "text", id: `param-${n}`, name: n, autocomplete: "off", spellcheck: "false", maxlength: 2000, value: values[n] ?? keep.get(n) ?? "" }) as HTMLInputElement;
        paramInputs.set(n, input);
        return h("div", { class: "param-row" }, h("label", { for: `param-${n}` }, h("code", null, n)), input);
      }),
    );
  };
  mount(paramBox, h("p", { class: "muted small" }, "Parameters appear after the first dry run."));
  const exampleBtn = button("Load example parameters", () => {
    const id = wfSel.value;
    if (id.startsWith("session:")) return;
    void ctx.api
      .replayWorkflow(id)
      .then((r) => renderParams([...new Set([...paramInputs.keys(), ...Object.keys(r.exampleParams ?? {})])], r.exampleParams ?? {}))
      .catch((err) => mount(feedback, problem(err)));
  }, "btn-ghost");
  const syncExample = () => {
    const entry = valid.find((w) => w.id === wfSel.value);
    exampleBtn.hidden = !entry?.hasExampleParams;
  };
  wfSel.addEventListener("change", syncExample);
  syncExample();

  const feedback = h("div", { class: "feedback", role: "status", "aria-live": "polite" });
  const planBox = h("div", { id: "replay-plan" });
  let current: ReplayPrepareResult | undefined;

  const discardCurrent = async () => {
    const prev = current;
    current = undefined;
    if (prev) await ctx.api.replayDiscard(prev.plan.runId).catch(() => undefined);
  };

  const prepare = async () => {
    mount(feedback);
    await discardCurrent();
    const v = wfSel.value;
    if (!v) {
      mount(feedback, problem(new Error("Choose a workflow first.")));
      return;
    }
    const params: Record<string, string> = {};
    for (const [k, el] of paramInputs) if (el.value !== "") params[k] = el.value;
    try {
      const res = await ctx.api.replayPrepare({
        ...(v.startsWith("session:") ? { sessionId: v.slice(8) } : { workflowId: v }),
        mode: modeSel.value as SafetyMode,
        controller: ctlSel.value as "mock" | "browser",
        ...(ctlSel.value === "browser" ? { allowOrigins: lines(allow.value), resourceOrigins: lines(resources.value) } : {}),
        params,
      });
      if (!ctx.alive()) {
        void ctx.api.replayDiscard(res.plan.runId).catch(() => undefined);
        return;
      }
      current = res;
      renderParams(res.plan.requiredParams);
      mount(planBox, planPanel(ctx, res, discardCurrent));
      planBox.scrollIntoView?.({ block: "start" });
    } catch (err) {
      mount(planBox);
      mount(feedback, problem(err));
    }
  };

  mount(
    main,
    pageHeader("Replay", h("span", null, "Service safety mode ", chip(serviceMode), " — the ceiling for runs started here.")),
    serviceMode === "OBSERVE"
      ? h("aside", { class: "note", role: "note" }, h("strong", null, "Plan only. "), "The service runs in OBSERVE mode, so replays can be planned and reviewed but not executed. Restart the service with LAB_SAFETY_MODE=SIMULATE to run workflows against the local mock.")
      : null,
    card(
      "1 · Plan (dry run — nothing is executed)",
      valid.length === 0 && sessions.length === 0 ? empty("No valid workflows. Add JSON workflows to the library directory, or record a session first.") : null,
      h(
        "div",
        { class: "replay-form" },
        h("label", { for: "replay-workflow" }, "Workflow"),
        wfSel,
        h("label", { for: "replay-mode" }, "Safety mode"),
        modeSel,
        h("label", { for: "replay-controller" }, "Controller"),
        ctlSel,
      ),
      browserFields,
      h("h3", null, "Parameters"),
      paramBox,
      h("div", { class: "actions" }, button("Plan (dry run)", () => void prepare(), "btn-primary"), exampleBtn),
      feedback,
    ),
    planBox,
    card(
      "Runs in this service session",
      runs.runs.length === 0
        ? empty("No replays planned since the service started. Finished runs are also listed on the Runs page.")
        : table(
            runs.runs,
            [
              { title: "Run", cell: (r) => link(buildHash("replay", {}, r.runId), shortId(r.runId, 12)) },
              { title: "Workflow", cell: (r) => r.workflow },
              { title: "Phase", cell: (r) => statusBadge(r.phase === "prepared" ? "pending" : r.phase) },
              { title: "Controller", cell: (r) => r.controller },
              { title: "Progress", cell: (r) => `${r.progress.done} / ${r.progress.total}`, cls: "num" },
              { title: "Planned", cell: (r) => fmtTime(r.createdAt) },
            ],
            { onRow: (r) => ctx.go("replay", {}, r.runId), rowLabel: (r) => `Open replay ${r.runId}` },
          ),
    ),
  );
};

function targetView(plan: ReplayPlanView): Child {
  return plan.target.baseUrl ? h("span", null, chip(plan.target.kind), " ", h("code", null, plan.target.baseUrl)) : chip(plan.target.kind);
}

function authorizationView(plan: ReplayPlanView): HTMLElement {
  const a = plan.authorization;
  const rows: Array<[string, Child]> = [["Decision", h("span", null, statusBadge(a.allowed ? "passed" : "denied"), ` ${a.code} — ${a.reason}`)]];
  if (a.record) {
    rows.push(
      ["System", a.record.system],
      ["Owner", a.record.owner],
      ["Granted by", a.record.grantedBy],
      ["Acknowledged", fmtTime(a.record.acknowledgedAt)],
      ["Basis", a.record.note ?? "—"],
    );
  }
  if (a.browser) {
    rows.push(
      ["Browser allowlist", h("span", null, statusBadge(a.browser.allowed ? "passed" : "denied"), ` ${a.browser.code} — ${a.browser.reason}`)],
      ["Allowed origins", a.browser.origins.length ? h("ul", { class: "plain" }, ...a.browser.origins.map((o) => h("li", null, h("code", null, o)))) : "none"],
      ["Resource origins", a.browser.resourceOrigins.length ? a.browser.resourceOrigins.join(", ") : "none"],
    );
  }
  return kv(rows);
}

function stepsTable(plan: ReplayPlanView): HTMLElement {
  return table(plan.steps, [
    { title: "#", cell: (_s) => String(plan.steps.indexOf(_s) + 1), cls: "num" },
    { title: "Step", cell: (s) => h("code", null, s.id) },
    { title: "Action", cell: (s) => s.action },
    { title: "Target", cell: (s) => (s.target ? h("code", null, s.target) : "—") },
    { title: "Timeout", cell: (s) => fmtDuration(s.timeoutMs), cls: "num" },
    { title: "Retries", cell: (s) => fmtInt(s.retries), cls: "num" },
    { title: "Checkpoint", cell: (s) => (s.checkpoint ? "yes" : "") },
    { title: "Params", cell: (s) => s.params.join(", ") },
  ]);
}

/** The pre-start review: target, authorization, workflow, step count, risk notice, then the explicit start. */
function planPanel(ctx: Ctx, res: ReplayPrepareResult, discard: () => Promise<void>): HTMLElement {
  const { plan } = res;
  const ack = h("input", { type: "checkbox", id: "replay-ack", disabled: !plan.wouldExecute }) as HTMLInputElement;
  const startBtn = h("button", { type: "button", class: "btn btn-primary", id: "replay-start", disabled: true }, "Start replay") as HTMLButtonElement;
  const out = h("div", { class: "feedback", role: "status", "aria-live": "polite" });
  ack.addEventListener("change", () => {
    startBtn.disabled = !(ack.checked && plan.wouldExecute && res.confirmToken);
  });
  startBtn.addEventListener("click", () => {
    if (!ack.checked || !res.confirmToken) return;
    startBtn.disabled = true;
    void ctx.api
      .replayStart(plan.runId, res.confirmToken)
      .then(() => ctx.go("replay", {}, plan.runId))
      .catch((err) => {
        mount(out, problem(err));
      });
  });
  const discardBtn = button("Discard plan", () => {
    void discard().then(() => {
      const panel = document.getElementById("replay-plan");
      if (panel) mount(panel);
    });
  }, "btn-ghost");

  return h(
    "section",
    { class: "card replay-review", "aria-labelledby": "review-title" },
    h("h2", { class: "card-title", id: "review-title" }, "2 · Review before start"),
    kv([
      ["Target", targetView(plan)],
      ["Workflow", h("span", null, h("strong", null, plan.workflow), ` · version ${plan.version} · from ${plan.source}`)],
      ["Step count", h("strong", { id: "replay-step-count" }, fmtInt(plan.stepCount))],
      ["Mode", h("span", null, chip(plan.mode), " (service ceiling ", chip(plan.serviceMode), ")")],
      ["Controller", plan.controller === "browser" ? "Real browser (Chromium)" : "Mock controller"],
      ["Parameters", plan.requiredParams.length ? `${plan.requiredParams.join(", ")}${plan.missingParams.length ? ` — missing: ${plan.missingParams.join(", ")}` : ""}` : "none"],
      ["Plan expires", fmtClock(res.expiresAt)],
    ]),
    h("h3", null, "Authorization"),
    authorizationView(plan),
    h("h3", null, "Risk notice"),
    h("ul", { class: "risk", id: "replay-risk" }, ...plan.riskNotice.map((r) => h("li", null, r))),
    plan.blockers.length
      ? h("div", { class: "error-box", role: "alert", id: "replay-blockers" }, h("strong", null, "This plan cannot be started:"), h("ul", null, ...plan.blockers.map((b) => h("li", null, b))))
      : null,
    h("details", null, h("summary", null, `Steps (${plan.stepCount})`), stepsTable(plan)),
    h(
      "div",
      { class: "ack" },
      ack,
      h("label", { for: "replay-ack" }, "I reviewed the target, the authorization and the risk notice, and I want to execute this workflow now."),
    ),
    h("div", { class: "actions" }, startBtn, discardBtn),
    out,
  );
}

// ---- live run view ----

const CONTROLS: Array<{ action: ReplayControlAction; text: string; when: (s: ReplayRunStatus) => boolean }> = [
  { action: "pause", text: "Pause", when: (s) => s.state === "running" },
  { action: "resume", text: "Resume", when: (s) => s.state === "paused" && !s.busy },
  { action: "step", text: "Step", when: (s) => s.state === "paused" && !s.busy },
  { action: "retry", text: "Retry step", when: (s) => s.state === "failed" && !s.busy },
  { action: "checkpoint", text: "Checkpoint", when: (s) => (s.state === "paused" || s.state === "failed") && !s.busy },
  { action: "rollback", text: "Roll back", when: (s) => (s.state === "paused" || s.state === "failed") && !s.busy && s.checkpoints.length > 0 },
  { action: "stop", text: "Stop", when: (s) => s.phase !== "prepared" && !TERMINAL.has(s.state) },
];

async function renderRunView(ctx: Ctx, main: HTMLElement, id: string): Promise<void> {
  let status: ReplayRunStatus;
  try {
    status = await ctx.api.replayStatus(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      mount(
        main,
        pageHeader("Replay run", "Not active in this service session"),
        card(null, h("p", null, "This run is no longer held by the service (it finished more than an hour ago, or the service restarted). Its stored record, if it ran, is on the Runs page."), h("div", { class: "actions" }, link(buildHash("runs", {}, id), "Open stored run"), link(buildHash("replay"), "Plan a replay"))),
      );
      return;
    }
    throw err;
  }
  if (!ctx.alive()) return;

  const logs: ReplayLogEntry[] = [];
  const header = h("div");
  const progress = h("div", { class: "replay-progress" });
  const controls = h("div", { class: "actions replay-controls", role: "group", "aria-label": "Run controls" });
  const cpLabel = h("input", { type: "text", id: "cp-label", maxlength: 60, placeholder: "checkpoint label (optional)", autocomplete: "off" }) as HTMLInputElement;
  const cpSel = h("select", { id: "cp-select", "aria-label": "Checkpoint to roll back to" }) as HTMLSelectElement;
  const steps = h("div");
  const result = h("div", { id: "replay-result" });
  const logList = h("ol", { class: "replay-log", id: "replay-log", "aria-live": "off" });
  const out = h("div", { class: "feedback", role: "status", "aria-live": "polite" });

  const act = (action: ReplayControlAction) => {
    if (action === "stop" && !window.confirm("Stop this replay? The run ends and cannot be resumed.")) return;
    const arg = action === "checkpoint" ? (cpLabel.value.trim() ? { label: cpLabel.value.trim() } : {}) : action === "rollback" && cpSel.value ? { checkpointId: cpSel.value } : {};
    mount(out);
    void ctx.api
      .replayControl(id, action, arg)
      .then((s) => {
        if (action === "checkpoint") cpLabel.value = "";
        update(s);
      })
      .catch((err) => mount(out, problem(err)));
  };

  const update = (s: ReplayRunStatus) => {
    status = s;
    for (const l of s.logs) {
      if (logs.length && l.seq <= (logs[logs.length - 1] as ReplayLogEntry).seq) continue;
      logs.push(l);
      const text = l.message.startsWith(l.type) ? l.message.slice(l.type.length).trimStart() : l.message;
      logList.appendChild(h("li", { class: `log-${l.type.split(".")[0]}` }, h("span", { class: "log-time" }, fmtClock(l.at)), " ", h("span", { class: "log-type" }, l.type), " ", text));
    }
    // Keep the newest entry in view inside the log box (never scroll the page).
    logList.scrollTop = logList.scrollHeight;
    mount(header, pageHeader(`Replay ${shortId(id, 14)}`, h("span", null, statusBadge(s.phase === "prepared" ? "pending" : s.phase), ` ${s.plan.workflow} · ${s.plan.mode} · ${s.plan.controller}${s.busy ? " · step running…" : ""}`)));
    mount(
      progress,
      h("progress", { id: "replay-progress", max: Math.max(1, s.progress.total), value: s.progress.done, "aria-label": "Steps done" }),
      h("span", { class: "muted" }, ` ${s.progress.done} / ${s.progress.total} steps · cursor ${s.cursor}${s.startedAt ? ` · started ${fmtClock(s.startedAt)}` : ""}`),
    );
    const cps = s.checkpoints;
    mount(cpSel, ...cps.map((c, i) => h("option", { value: c, selected: i === cps.length - 1 }, c)));
    mount(
      controls,
      ...CONTROLS.map((c) => h("button", { type: "button", class: `btn${c.action === "stop" ? " btn-danger" : ""}`, "data-action": c.action, disabled: !c.when(s), on: { click: () => act(c.action) } }, c.text)),
      h("span", { class: "spacer" }),
      TERMINAL.has(s.state) ? null : cpLabel,
      cps.length && !TERMINAL.has(s.state) ? cpSel : null,
    );
    mount(
      steps,
      table(s.record.steps, [
        { title: "#", cell: (st) => String(s.record.steps.indexOf(st) + 1), cls: "num" },
        { title: "Step", cell: (st) => h("code", null, st.id) },
        { title: "Status", cell: (st) => statusBadge(st.status) },
        { title: "Attempts", cell: (st) => fmtInt(st.attempts), cls: "num" },
        { title: "Duration", cell: (st) => (st.startedAt && st.endedAt ? fmtDuration(st.endedAt - st.startedAt) : "—"), cls: "num" },
        { title: "Error", cell: (st) => st.error ?? "" },
      ]),
    );
    if (s.phase === "prepared") {
      mount(result, h("div", { class: "note", role: "note" }, "This plan was prepared but not started. Starting needs the review screen: plan it again from the Replay page."));
    } else if (TERMINAL.has(s.state) || s.state === "failed") {
      const ok = s.record.steps.filter((x) => x.status === "ok").length;
      const failed = s.record.steps.filter((x) => x.status === "failed").length;
      mount(
        result,
        card(
          "Result",
          kv([
            ["Outcome", statusBadge(s.record.status)],
            ["Steps ok / failed / total", `${ok} / ${failed} / ${s.record.steps.length}`],
            ["Duration", s.record.endedAt ? fmtDuration(s.record.endedAt - s.record.startedAt) : "—"],
            ["Last error", s.lastError ?? (s.record.steps.find((x) => x.status === "failed")?.error ?? "none")],
            ["Stored record", link(buildHash("runs", {}, id), "Open on the Runs page")],
          ]),
          s.state === "failed" ? h("p", { class: "muted small" }, "The run is paused on the failed step: retry it, roll back to a checkpoint, or stop the run.") : null,
        ),
      );
    } else mount(result);
  };

  mount(
    main,
    header,
    card("Progress", progress, controls, out),
    result,
    h(
      "div",
      { class: "grid-2" },
      card("Target & authorization", kv([["Target", targetView(status.plan)], ["Source", status.plan.source]]), authorizationView(status.plan)),
      card("Risk notice", h("ul", { class: "risk" }, ...status.plan.riskNotice.map((r) => h("li", null, r)))),
    ),
    card("Steps", steps),
    card("Log", h("p", { class: "muted small" }, "Redacted engine events. Parameter values are never logged."), logList),
  );
  update(status);

  // Poll until the run is finished (or the operator navigates away).
  const tick = async () => {
    if (!ctx.alive()) return;
    if (TERMINAL.has(status.state) && !status.busy) return;
    try {
      const last = logs.length ? (logs[logs.length - 1] as ReplayLogEntry).seq : 0;
      const s = await ctx.api.replayStatus(id, last);
      if (!ctx.alive()) return;
      update(s);
    } catch (err) {
      if (!ctx.alive()) return;
      mount(out, problem(err));
      if (err instanceof ApiError && err.status === 404) return;
    }
    setTimeout(() => void tick(), POLL_MS);
  };
  setTimeout(() => void tick(), POLL_MS);
}
