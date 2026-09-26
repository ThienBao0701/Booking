/**
 * The extension's service worker, once its extension APIs are usable.
 *
 * Right after launch Chromium can report the worker before `chrome.storage` /
 * `chrome.runtime.id` are bound in it (observed: undefined for a few hundred
 * ms), so evaluating immediately races. Wait until the bindings exist.
 */
import type { BrowserContext, Worker } from "playwright-core";

export async function extensionServiceWorker(context: BrowserContext, timeoutMs = 15_000): Promise<Worker> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const worker = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://")) ?? (await context.waitForEvent("serviceworker", { timeout: timeoutMs }));
    const ready = await worker.evaluate(() => typeof chrome !== "undefined" && typeof chrome.storage?.local !== "undefined" && typeof chrome.runtime?.id === "string").catch(() => false);
    if (ready) return worker;
    if (Date.now() > deadline) throw new Error("extension service worker did not become ready");
    await new Promise((r) => setTimeout(r, 100));
  }
}
