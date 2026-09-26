import { test } from "node:test";
import assert from "node:assert/strict";

import { browserEnvironment, browserFamily, pageEnvironment } from "../src/common/environment.ts";
import { Recorder } from "../src/recorder/recorder.ts";
import { MemoryQueue } from "../src/recorder/queue.ts";
import { FakeSink, FakeTimers, deterministicIdEnv } from "./fakes.ts";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

test("browser family + major version only; the full UA string is never kept", () => {
  assert.deepEqual(browserFamily(CHROME_UA), { browser: "Chrome", browser_major: 131 });
  assert.deepEqual(browserFamily(`${CHROME_UA} Edg/130.0.0.0`), { browser: "Edge", browser_major: 130 });
  assert.deepEqual(browserFamily("curl/8"), {});
  assert.deepEqual(browserFamily(undefined), {});
  const env = browserEnvironment({ userAgent: CHROME_UA, language: "vi-VN", platform: "Win32", hardwareConcurrency: 8 }, "0.1.0", new Date(0));
  assert.equal(env.browser, "Chrome");
  assert.equal(env.platform, "Win32");
  assert.equal(env.language, "vi-VN");
  assert.equal(env.hardware_concurrency, 8);
  assert.equal(env.extension_version, "0.1.0");
  assert.equal(typeof env.timezone_offset_min, "number");
  assert.ok(!JSON.stringify(env).includes("Mozilla"), "no raw user-agent");
  // userAgentData platform wins when present.
  assert.equal(browserEnvironment({ platform: "Win32", userAgentData: { platform: "Windows" } }, undefined).platform, "Windows");
});

test("page environment: viewport, screen, pixel ratio, colour scheme", () => {
  const env = pageEnvironment({
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1.25,
    screen: { width: 1920, height: 1080 },
    matchMedia: (q) => ({ matches: q.includes("dark") }),
  });
  assert.deepEqual(env, {
    viewport: { width: 1280, height: 720 },
    screen: { width: 1920, height: 1080 },
    device_pixel_ratio: 1.25,
    color_scheme: "dark",
  });
  assert.deepEqual(pageEnvironment({ innerWidth: 1, innerHeight: 2 }), { viewport: { width: 1, height: 2 } });
});

test("session_start carries the environment only when supplied", async () => {
  const timers = new FakeTimers();
  const firstMetadata = async (environment?: Record<string, unknown>) => {
    const queue = new MemoryQueue();
    const r = new Recorder({ queue, sink: new FakeSink(), timers, idEnv: deterministicIdEnv(timers), batchSize: 10, flushIntervalMs: 1000 });
    r.startSession({ mode: "OBSERVE", target: { kind: "mock" }, ...(environment ? { environment } : {}) });
    await r.settled();
    const [ev] = await queue.peek(1);
    assert.equal(ev?.action, "session_start");
    return ev?.metadata;
  };
  assert.deepEqual(await firstMetadata({ browser: "Chrome", browser_major: 131 }), {
    mode: "OBSERVE",
    targetKind: "mock",
    environment: { browser: "Chrome", browser_major: 131 },
  });
  assert.deepEqual(await firstMetadata(), { mode: "OBSERVE", targetKind: "mock" });
});
