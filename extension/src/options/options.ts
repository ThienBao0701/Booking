/** Options: pairing, recordable origins (runtime-granted, exact origins only), recording settings. */

import { type ExtensionConfig, normalizeOrigin, originToMatchPattern, validateConfig } from "../common/config.ts";
import type { UiMessage } from "../common/messages.ts";
import { loadConfig, saveConfig } from "../storage/state.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

let config: ExtensionConfig;

function out(text: string): void {
  const el = $("out");
  el.hidden = false;
  el.textContent = text;
}

function render(): void {
  input("serviceUrl").value = config.serviceUrl;
  input("token").value = config.token;
  $<HTMLSelectElement>("safetyMode").value = config.safetyMode;
  input("batchSize").value = String(config.batchSize);
  input("flushIntervalMs").value = String(config.flushIntervalMs);
  input("domDebounceMs").value = String(config.domDebounceMs);
  input("maxQueue").value = String(config.maxQueue);
  const list = $("origins");
  list.replaceChildren(
    ...config.targetOrigins.map((o) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = o;
      const rm = document.createElement("button");
      rm.textContent = "Remove";
      rm.addEventListener("click", () => void removeOrigin(o));
      li.append(span, rm);
      return li;
    }),
  );
}

function readForm(): Partial<ExtensionConfig> {
  return {
    ...config,
    serviceUrl: input("serviceUrl").value.trim(),
    token: input("token").value.trim(),
    safetyMode: $<HTMLSelectElement>("safetyMode").value as ExtensionConfig["safetyMode"],
    batchSize: Number(input("batchSize").value),
    flushIntervalMs: Number(input("flushIntervalMs").value),
    domDebounceMs: Number(input("domDebounceMs").value),
    maxQueue: Number(input("maxQueue").value),
  };
}

async function persist(next: Partial<ExtensionConfig>): Promise<boolean> {
  const v = validateConfig(next);
  if (!v.ok) {
    out(`Not saved:\n- ${v.errors.join("\n- ")}`);
    return false;
  }
  config = v.value;
  await saveConfig(config);
  render();
  return true;
}

async function addOrigin(): Promise<void> {
  const origin = normalizeOrigin(input("origin").value);
  if (!origin) return out("Enter an exact origin such as https://staging.example.com (no paths or wildcards).");
  // Must run inside the click gesture: Chrome shows its own grant prompt for this origin only.
  const granted = await chrome.permissions.request({ origins: [originToMatchPattern(origin)] });
  if (!granted) return out(`Access to ${origin} was not granted.`);
  if (await persist({ ...config, targetOrigins: [...config.targetOrigins, origin] })) {
    input("origin").value = "";
    out(`Recording enabled for ${origin}.`);
  }
}

async function removeOrigin(origin: string): Promise<void> {
  const remaining = config.targetOrigins.filter((o) => o !== origin);
  const pattern = originToMatchPattern(origin);
  if (!remaining.some((o) => originToMatchPattern(o) === pattern)) {
    await chrome.permissions.remove({ origins: [pattern] });
  }
  await persist({ ...config, targetOrigins: remaining });
  out(`Removed ${origin}.`);
}

$("save").addEventListener("click", () => {
  void persist(readForm()).then((ok) => ok && out("Saved."));
});
$("test").addEventListener("click", () => {
  void (async () => {
    if (!(await persist(readForm()))) return;
    const r = (await chrome.runtime.sendMessage({ type: "lab/ui/testConnection" } satisfies UiMessage)) as Record<string, unknown>;
    out(JSON.stringify(r, null, 2));
  })();
});
$("addOrigin").addEventListener("click", () => void addOrigin());

void loadConfig().then((c) => {
  config = c;
  render();
});
