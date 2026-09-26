/** Popup: status + session controls. All work happens in the service worker. */

import type { UiMessage } from "../common/messages.ts";

interface Status {
  ok: boolean;
  error?: string;
  recording: boolean;
  session: { sessionId: string } | null;
  stats: { recorded: number; delivered: number; queueSize: number; dropped: number; rejected: number; lastError: string | null; blocked: string | null };
  bridge: { state: string; detail: string | null };
  transport?: { mode: string; active: string; native: string; detail: string | null };
  health: { reachable: boolean; ok: boolean };
  config: { serviceUrl: string; paired: boolean };
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function call<T>(msg: UiMessage): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

function showError(text: string | null | undefined): void {
  const el = $("error");
  el.hidden = !text;
  el.textContent = text ?? "";
}

function showNotice(text: string): void {
  const el = $("notice");
  el.hidden = false;
  el.textContent = text;
}

async function refresh(): Promise<void> {
  const s = await call<Status>({ type: "lab/ui/status" });
  if (!s.ok) return showError(s.error ?? "status unavailable");
  const rec = $("rec");
  rec.textContent = s.recording ? "REC" : "idle";
  rec.classList.toggle("rec", s.recording);

  const svc = $("svc");
  svc.textContent = s.health.ok ? "healthy" : s.health.reachable ? "unhealthy" : "unreachable";
  svc.className = `v ${s.health.ok ? "ok" : "bad"}`;

  const bridge = $("bridge");
  bridge.textContent = s.config.paired ? s.bridge.state : "not paired";
  bridge.className = `v ${s.bridge.state === "connected" ? "ok" : s.config.paired ? "warn" : "bad"}`;

  const tr = $("transport");
  const t = s.transport;
  tr.textContent = !t ? "—" : t.active === "native" ? "native host" : t.mode === "auto" ? "HTTP (fallback)" : t.active === "http" ? "HTTP loopback" : t.active;
  tr.title = t?.detail ?? "";
  tr.className = `v ${t?.active === "native" || t?.mode === "http" ? "ok" : "warn"}`;

  $("session").textContent = s.session?.sessionId ?? "—";
  $("recorded").textContent = String(s.stats.recorded);
  $("delivered").textContent = String(s.stats.delivered);
  $("queued").textContent = String(s.stats.queueSize);
  $("dropped").textContent = `${s.stats.dropped} / ${s.stats.rejected}`;
  $("start").hidden = s.recording;
  $("stop").hidden = !s.recording;
  ($("capture") as HTMLButtonElement).disabled = !s.recording;
  showError(s.stats.blocked ? `Delivery paused (${s.stats.blocked}): ${s.bridge.detail ?? s.stats.lastError ?? ""}` : s.stats.lastError);
}

async function act(msg: UiMessage): Promise<void> {
  const r = await call<{ ok: boolean; error?: string }>(msg);
  if (!r.ok && r.error) showError(r.error);
  await refresh();
}

$("start").addEventListener("click", () => void act({ type: "lab/ui/start" }));
$("stop").addEventListener("click", () => void act({ type: "lab/ui/stop" }));
$("flush").addEventListener("click", () => void act({ type: "lab/ui/flush" }));
$("capture").addEventListener("click", () => {
  void (async () => {
    const r = await call<{ ok: boolean; error?: string; image?: { stored: boolean; reason?: string } }>({ type: "lab/ui/capture" });
    if (!r.ok && r.error) showError(r.error);
    else if (r.image) showNotice(r.image.stored ? "Screenshot recorded; image stored locally." : `Screenshot recorded (${r.image.reason ?? "hash only"}).`);
    await refresh();
  })();
});
$("options").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void refresh();
setInterval(() => void refresh(), 2000);
