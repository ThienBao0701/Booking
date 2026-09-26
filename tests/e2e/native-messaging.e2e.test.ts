/**
 * E2E (Phase 14): Recorder → BridgeClient → NativeChannel → the REAL native
 * host process (started through the installed launcher exactly as Chrome
 * starts it: `<launcher> chrome-extension://<id>/`) → real lab service.
 * Covers delivery, host crash → reconnect, a refused extension id, and
 * uninstall → HTTP loopback fallback with nothing lost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Recorder } from "../../extension/src/recorder/recorder.ts";
import { MemoryQueue } from "../../extension/src/recorder/queue.ts";
import { BridgeClient, fetchTransport } from "../../extension/src/bridge/client.ts";
import { NativeChannel, type PortLike, autoTransport } from "../../extension/src/bridge/native-transport.ts";
import { FrameDecoder, encodeFrame } from "../../windows-service/src/native/framing.ts";
import { applyInstall, applyUninstall, planInstall, planUninstall } from "../../windows-service/src/native/install.ts";
import { NATIVE_MAX_TO_HOST_BYTES } from "../../shared/src/index.ts";
import { authedGet, startLabService } from "./harness.ts";

const HOST_ENTRY = fileURLToPath(new URL("../../windows-service/src/native/main.ts", import.meta.url));
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

/**
 * What Chrome does for connectNative: find the manifest, check allowed_origins,
 * spawn `path` with the caller origin, and frame messages on stdio.
 */
class ChromeLikePort implements PortLike {
  static lastError: string | undefined;
  child: ChildProcess | undefined;
  #msg: Array<(m: unknown) => void> = [];
  #disc: Array<() => void> = [];
  #gone = false;

  constructor(manifestPath: string, extensionId: string) {
    if (!existsSync(manifestPath)) {
      this.#fail("Specified native messaging host not found.");
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { path: string; allowed_origins: string[] };
    const origin = `chrome-extension://${extensionId}/`;
    if (!manifest.allowed_origins.includes(origin)) {
      this.#fail("Access to the specified native messaging host is forbidden.");
      return;
    }
    const child = spawn(manifest.path, [origin], { stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    const decoder = new FrameDecoder(1024 * 1024);
    child.stdout?.on("data", (c: Buffer) => {
      for (const m of decoder.push(c)) for (const f of this.#msg) f(m);
    });
    child.on("error", () => this.#fail("Error when communicating with the native messaging host."));
    child.on("exit", () => this.#fail("Native host has exited."));
  }

  #fail(why: string): void {
    if (this.#gone) return;
    this.#gone = true;
    // Like Chrome: the disconnect (with lastError) is delivered asynchronously.
    setTimeout(() => {
      ChromeLikePort.lastError = why;
      for (const f of this.#disc) f();
      ChromeLikePort.lastError = undefined;
      this.#dispatched = true;
    }, 0);
  }
  #dispatched = false;

  postMessage(msg: unknown): void {
    if (this.#dispatched) throw new Error("Attempting to use a disconnected port object");
    if (this.#gone || !this.child?.stdin?.writable) return; // Chrome drops messages to a host that is going away
    this.child.stdin.write(encodeFrame(msg, NATIVE_MAX_TO_HOST_BYTES));
  }
  disconnect(): void {
    this.#gone = true;
    this.child?.stdin?.end();
  }
  onMessage = { addListener: (f: (m: unknown) => void) => void this.#msg.push(f) };
  onDisconnect = { addListener: (f: () => void) => void this.#disc.push(f) };
}

test("recorder events travel extension → native host → service; crash → reconnect; uninstall → HTTP fallback", { timeout: 60_000 }, async () => {
  const svc = await startLabService();
  const dir = mkdtempSync(join(tmpdir(), "lab-e2e-native-"));
  const installDir = join(dir, "native-host");
  const logDir = join(dir, "logs");
  const ports: ChromeLikePort[] = [];
  try {
    const plan = planInstall({ platform: process.platform === "win32" ? "win32" : "linux", installDir, extensionIds: [EXT_ID], serviceUrl: svc.url, nodePath: process.execPath, hostEntry: HOST_ENTRY, logDir, browsers: [] });
    applyInstall({ ...plan, registry: [] });

    const native = new NativeChannel({
      connect: () => {
        const p = new ChromeLikePort(plan.manifestPath, EXT_ID);
        ports.push(p);
        return p;
      },
      lastError: () => ChromeLikePort.lastError,
      extensionVersion: "0.1.0",
      handshakeTimeoutMs: 10_000,
    });
    const link = autoTransport({ native, http: fetchTransport, retryNativeAfterMs: 0 });
    const bridge = new BridgeClient({ serviceUrl: svc.url, token: svc.token, transport: link.transport, timeoutMs: 10_000, reconnect: { baseMs: 50, maxMs: 200, auto: false } });
    const recorder = new Recorder({ queue: new MemoryQueue(), sink: bridge, batchSize: 25, flushIntervalMs: 60_000 });
    const s = recorder.startSession({ mode: "OBSERVE", target: { kind: "mock", host: "127.0.0.1" } });
    bridge.declareSession(s);

    // 1. Native delivery.
    recorder.record({ action: "page_state", page: "/", tabId: 1, view: "login", metadata: {} });
    recorder.record({ action: "click", page: "/", tabId: 1, view: "login", target: { selector: "#login-submit", label: "Log in" }, metadata: {} });
    assert.equal((await recorder.flush({ manual: true })).status, "ok");
    assert.equal(link.kind(), "native");
    assert.equal(native.status.welcome?.service.url, svc.url);
    const log = readFileSync(join(logDir, "native-host.log"), "utf8");
    assert.match(log, /"path":"\/v1\/events","status":20[02]/);
    assert.ok(!log.includes(svc.token), "the host never logs the token");

    // 2. The host crashes: in-flight work fails, the bridge retries, a new host is started.
    ports.at(-1)?.child?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    recorder.record({ action: "click", page: "/", tabId: 1, view: "reservations", target: { selector: "button[data-cancel]" }, metadata: {} });
    let r = await recorder.flush({ manual: true });
    if (r.status !== "ok") r = await recorder.flush({ manual: true });
    assert.equal(r.status, "ok");
    assert.equal(link.kind(), "native");
    assert.ok(ports.length >= 2, "reconnected by starting the host again");

    // 3. Uninstall: the host is gone → HTTP loopback fallback, nothing lost.
    native.close();
    const un = applyUninstall({ ...planUninstall({ platform: "linux", installDir, browsers: [] }), registryKeys: [] });
    assert.ok(un.removed.includes(plan.manifestPath));
    assert.equal(existsSync(installDir), false);
    recorder.record({ action: "page_state", page: "/", tabId: 1, view: "reports", metadata: {} });
    assert.equal((await recorder.flush({ manual: true })).status, "ok");
    assert.equal(link.kind(), "http");
    assert.match(link.fallbackReason() ?? "", /not found/);

    const stored = await authedGet<{ events: Array<{ id: string }> }>(svc, `/v1/sessions/${s.sessionId}/events`);
    assert.equal(stored.events.length, recorder.stats.recorded, "every event stored exactly once");
    assert.equal(new Set(stored.events.map((e) => e.id)).size, stored.events.length);
    recorder.dispose();
    bridge.close();
  } finally {
    for (const p of ports) p.child?.kill("SIGKILL");
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an extension id the host was not installed for is refused (and falls back to HTTP)", { timeout: 30_000 }, async () => {
  const svc = await startLabService();
  const dir = mkdtempSync(join(tmpdir(), "lab-e2e-native-"));
  try {
    const plan = planInstall({ platform: "linux", installDir: join(dir, "nh"), extensionIds: [EXT_ID], serviceUrl: svc.url, nodePath: process.execPath, hostEntry: HOST_ENTRY, logDir: join(dir, "logs"), browsers: [] });
    applyInstall(plan);
    // Chrome itself refuses other ids (allowed_origins); the host checks again if launched anyway.
    const other = "ponmlkjihgfedcbaponmlkjihgfedcba";
    const child = spawn(plan.launcherPath, [`chrome-extension://${other}/`], { stdio: ["pipe", "pipe", "ignore"] });
    const decoder = new FrameDecoder(1024 * 1024);
    const msgs: unknown[] = [];
    child.stdout.on("data", (c: Buffer) => msgs.push(...decoder.push(c)));
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    assert.equal(code, 1);
    assert.deepEqual((msgs[0] as { code: string }).code, "origin_not_allowed");

    const native = new NativeChannel({ connect: () => new ChromeLikePort(plan.manifestPath, other), lastError: () => ChromeLikePort.lastError, extensionVersion: "0.1.0" });
    const link = autoTransport({ native, http: fetchTransport });
    const bridge = new BridgeClient({ serviceUrl: svc.url, token: svc.token, transport: link.transport, reconnect: { baseMs: 50, maxMs: 200, auto: false } });
    assert.equal(await bridge.connect(), "connected");
    assert.equal(link.kind(), "http");
    assert.match(link.fallbackReason() ?? "", /forbidden/);
    bridge.close();
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
