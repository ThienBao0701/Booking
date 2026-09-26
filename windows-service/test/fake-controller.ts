/** Scriptable BrowserController for manager/API tests: per-selector delays, hangs and failures. */
import { type ActionOptions, type BrowserController, type ControllerSnapshot, type PageMetadata, type PageState, ControllerError } from "../src/automation/controller.ts";

export interface Behavior {
  failTimes?: number;
  delayMs?: number;
  /** Block until released (or aborted). */
  gate?: Promise<void>;
}

export class ScriptedController implements BrowserController {
  readonly name = "scripted";
  calls: string[] = [];
  behaviors = new Map<string, Behavior>();
  typed: Record<string, string> = {};
  url = "about:blank";
  launched = 0;
  closed = 0;

  async #act(label: string, key: string, o?: ActionOptions): Promise<void> {
    this.calls.push(label);
    const b = this.behaviors.get(key);
    if (!b) return;
    if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
    if (b.gate) {
      await Promise.race([
        b.gate,
        new Promise<never>((_, reject) => o?.signal?.addEventListener("abort", () => reject(new ControllerError("ABORTED", "aborted")))),
      ]);
    }
    if ((b.failTimes ?? 0) > 0) {
      b.failTimes = (b.failTimes as number) - 1;
      throw new ControllerError("ELEMENT_NOT_FOUND", `scripted failure at ${key}`, true);
    }
  }
  async launch(): Promise<void> {
    this.launched += 1;
  }
  async openTab(): Promise<string> {
    return "tab-1";
  }
  async closeTab(): Promise<void> {}
  async navigate(url: string, o?: ActionOptions): Promise<void> {
    await this.#act(`navigate ${url}`, url, o);
    this.url = url;
  }
  async reload(o?: ActionOptions): Promise<void> {
    await this.#act("reload", "reload", o);
  }
  async back(o?: ActionOptions): Promise<void> {
    await this.#act("back", "back", o);
  }
  async forward(o?: ActionOptions): Promise<void> {
    await this.#act("forward", "forward", o);
  }
  async click(s: string, o?: ActionOptions): Promise<void> {
    await this.#act(`click ${s}`, s, o);
  }
  async type(s: string, v: string, o?: ActionOptions): Promise<void> {
    await this.#act(`type ${s}`, s, o);
    this.typed[s] = v;
  }
  async select(s: string, v: string, o?: ActionOptions): Promise<void> {
    await this.#act(`select ${s}=${v}`, s, o);
  }
  async waitFor(s: string, o?: ActionOptions): Promise<void> {
    await this.#act(`waitFor ${s}`, s, o);
  }
  async captureState(): Promise<PageState> {
    return { url: this.url, tabId: "tab-1", fields: {}, entities: {}, server: {}, capturedAt: 0 };
  }
  async captureScreenshot() {
    return { supported: false, reason: "scripted" };
  }
  getCurrentUrl(): string {
    return this.url;
  }
  async getPageMetadata(): Promise<PageMetadata> {
    return { url: this.url, title: "", tabId: "tab-1" };
  }
  async snapshot(): Promise<ControllerSnapshot> {
    return { url: this.url };
  }
  async restore(s: ControllerSnapshot): Promise<void> {
    this.url = String(s.url);
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}
