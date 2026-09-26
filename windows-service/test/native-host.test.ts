/**
 * Native host (Phase 14): framing, origin check, handshake + version
 * negotiation, schema validation, route/header allowlists, relay to a real
 * service (authentication and origin validation unchanged), timeouts,
 * size limits, and the host as a real child process speaking stdio.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { CONTRACT_VERSION, NATIVE_MAX_TO_EXTENSION_BYTES, type HostToExtension } from "../src/shared.ts";
import { FrameDecoder, FrameError, encodeFrame } from "../src/native/framing.ts";
import { type NativeHostConfig, validateNativeHostConfig } from "../src/native/config.ts";
import { NativeHost, type Relay } from "../src/native/host.ts";
import { parseHostArgs } from "../src/native/main.ts";
import { TEST_TOKEN, startServiceHarness, type ServiceHarness } from "./helpers.ts";

const EXT = `chrome-extension://${"a".repeat(32)}/`;
const OTHER = `chrome-extension://${"b".repeat(32)}/`;
let svc: ServiceHarness;
before(async () => {
  svc = await startServiceHarness();
});
after(async () => {
  await svc.close();
});

function cfg(over: Partial<NativeHostConfig> = {}): NativeHostConfig {
  return { serviceUrl: svc.base, allowedOrigins: [EXT], timeoutMs: 2000, ...over };
}

/** A host wired to in-memory stdio; `send` writes frames, `next` reads them. */
function harness(opts: { origin?: string | undefined; config?: NativeHostConfig | { errors: string[] }; relay?: Relay; maxInFlight?: number } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new FrameDecoder(NATIVE_MAX_TO_EXTENSION_BYTES + 16);
  const queue: HostToExtension[] = [];
  const waiters: Array<(m: HostToExtension) => void> = [];
  let ended = false;
  output.on("data", (c: Buffer) => {
    for (const m of decoder.push(c) as HostToExtension[]) {
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    }
  });
  output.on("end", () => {
    ended = true;
  });
  const host = new NativeHost({
    input,
    output,
    callerOrigin: "origin" in opts ? opts.origin : EXT,
    config: opts.config ?? cfg(),
    ...(opts.relay ? { relay: opts.relay } : {}),
    ...(opts.maxInFlight ? { maxInFlight: opts.maxInFlight } : {}),
    probeTimeoutMs: 500,
  });
  const exit = host.run();
  return {
    exit,
    ended: () => ended,
    send: (m: unknown) => input.write(encodeFrame(m, 64 * 1024 * 1024)),
    raw: (b: Buffer) => input.write(b),
    next: () =>
      new Promise<HostToExtension>((resolve, reject) => {
        const q = queue.shift();
        if (q) return resolve(q);
        const t = setTimeout(() => reject(new Error("no message from host")), 5000);
        waiters.push((m) => {
          clearTimeout(t);
          resolve(m);
        });
      }),
    end: () => input.end(),
  };
}

const hello = { type: "hello", protocol: { min: 1, max: 1 }, extensionVersion: "0.1.0", contractVersion: CONTRACT_VERSION };
const auth = { authorization: `Bearer ${TEST_TOKEN}`, accept: "application/json" };

test("framing: split chunks, several frames per chunk, size limit, bad JSON", () => {
  const d = new FrameDecoder(1024);
  const a = encodeFrame({ a: 1 }, 1024);
  const b = encodeFrame({ b: "ü" }, 1024);
  const both = Buffer.concat([a, b]);
  assert.deepEqual(d.push(both.subarray(0, 3)), []);
  assert.deepEqual(d.push(both.subarray(3, a.length + 2)), [{ a: 1 }]);
  assert.deepEqual(d.push(both.subarray(a.length + 2)), [{ b: "ü" }]);
  assert.equal(d.pending, 0);
  assert.throws(() => encodeFrame({ x: "y".repeat(2000) }, 1024), FrameError);
  const big = Buffer.alloc(4);
  big.writeUInt32LE(4096, 0);
  assert.throws(() => new FrameDecoder(1024).push(big), (e: unknown) => e instanceof FrameError && e.code === "message_too_large");
  const junk = Buffer.from("not json");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(junk.length, 0);
  assert.throws(() => new FrameDecoder(1024).push(Buffer.concat([head, junk])), (e: unknown) => e instanceof FrameError && e.code === "invalid_message");
});

test("config is validated fail-closed", () => {
  assert.equal(validateNativeHostConfig({ serviceUrl: "http://127.0.0.1:4577", allowedOrigins: [EXT] }).ok, true);
  for (const bad of [
    null,
    { serviceUrl: "http://example.com:4577", allowedOrigins: [EXT] },
    { serviceUrl: "https://127.0.0.1:4577", allowedOrigins: [EXT] },
    { serviceUrl: "http://127.0.0.1:4577", allowedOrigins: [] },
    { serviceUrl: "http://127.0.0.1:4577", allowedOrigins: ["https://evil.example"] },
    { serviceUrl: "http://127.0.0.1:4577", allowedOrigins: ["chrome-extension://*/"] },
    { serviceUrl: "http://127.0.0.1:4577", allowedOrigins: [EXT], timeoutMs: 10 },
    { serviceUrl: "http://127.0.0.1:4577", allowedOrigins: [EXT], extra: 1 },
  ]) {
    assert.equal(validateNativeHostConfig(bad).ok, false, JSON.stringify(bad));
  }
});

test("argv: caller origin, --config, Windows --parent-window ignored", () => {
  assert.deepEqual(parseHostArgs(["--config", "C:\\x\\native-host.json", EXT, "--parent-window=1234"]), { configPath: "C:\\x\\native-host.json", callerOrigin: EXT });
  assert.equal(parseHostArgs([EXT]).callerOrigin, EXT);
});

test("a caller origin not in the config is refused before anything is read", async () => {
  for (const origin of [OTHER, undefined, "https://example.com/"]) {
    const h = harness({ origin });
    const m = await h.next();
    assert.equal(m.type, "error");
    assert.equal((m as { code: string }).code, "origin_not_allowed");
    assert.equal((m as { fatal: boolean }).fatal, true);
    assert.equal(await h.exit, 1);
  }
});

test("a missing or invalid config refuses every connection", async () => {
  const h = harness({ config: { errors: ["cannot read"] } });
  const m = await h.next();
  assert.equal((m as { code: string }).code, "host_misconfigured");
  assert.equal(await h.exit, 1);
});

test("handshake: requests need hello first; version negotiation; welcome reports the service", async () => {
  const h = harness();
  h.send({ type: "request", id: "r0", method: "GET", path: "/healthz", headers: {} });
  const early = await h.next();
  assert.deepEqual([early.type, (early as { code: string }).code, (early as { id: string }).id], ["error", "handshake_required", "r0"]);
  h.send({ type: "ping", id: "p1" });
  assert.deepEqual(await h.next(), { type: "pong", id: "p1" });
  h.send(hello);
  const w = await h.next();
  assert.equal(w.type, "welcome");
  if (w.type === "welcome") {
    assert.equal(w.protocol, 1);
    assert.equal(w.contractVersion, CONTRACT_VERSION);
    assert.deepEqual(w.service, { url: svc.base, reachable: true, safetyMode: "OBSERVE" });
  }
  h.send(hello);
  assert.equal(((await h.next()) as { code: string }).code, "already_handshaken");
  h.end();
  assert.equal(await h.exit, 0);

  const h2 = harness();
  h2.send({ ...hello, protocol: { min: 7, max: 9 } });
  const refused = await h2.next();
  assert.deepEqual([(refused as { code: string }).code, (refused as { fatal: boolean }).fatal], ["unsupported_protocol", true]);
  assert.equal(await h2.exit, 1);
});

test("relay: authenticated bridge calls reach the service; bad tokens get 401", async () => {
  const h = harness();
  h.send(hello);
  await h.next();
  h.send({ type: "request", id: "r1", method: "GET", path: "/v1/bridge/handshake", headers: auth });
  const ok = await h.next();
  assert.equal(ok.type, "response");
  assert.equal((ok as { status: number }).status, 200);
  assert.equal(((ok as { body: { service: string } }).body).service, "lab-service");
  h.send({ type: "request", id: "r2", method: "GET", path: "/v1/bridge/handshake", headers: { authorization: "Bearer wrong-token-wrong-token" } });
  assert.equal(((await h.next()) as { status: number }).status, 401);
  h.send({ type: "request", id: "r3", method: "POST", path: "/v1/sessions", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "session_native_1" }) });
  const created = await h.next();
  assert.ok([200, 201].includes((created as { status: number }).status), JSON.stringify(created));
  assert.equal(svc.store.hasSession("session_native_1"), true);
  h.end();
  await h.exit;
});

test("relay forwards the verified extension origin: the service's origin pinning still applies", async () => {
  svc.config.allowedOrigins = [OTHER.replace(/\/$/, "")];
  try {
    const h = harness();
    h.send(hello);
    await h.next();
    h.send({ type: "request", id: "r1", method: "GET", path: "/v1/bridge/handshake", headers: auth });
    assert.equal(((await h.next()) as { status: number }).status, 403, "extension origin not pinned on the service");
    h.end();
    await h.exit;
  } finally {
    svc.config.allowedOrigins = [];
  }
});

test("only bridge routes and headers are relayed; invalid messages are answered, not relayed", async () => {
  const seen: Array<{ path: string; headers: Record<string, string> }> = [];
  const relay: Relay = async (r) => {
    seen.push({ path: r.path, headers: r.headers });
    return { status: 200, body: { ok: true, status: "ok" } };
  };
  const h = harness({ relay });
  h.send(hello);
  await h.next();
  seen.length = 0;
  for (const [id, method, path] of [
    ["a", "GET", "/v1/sessions"],
    ["b", "POST", "/v1/replay/prepare"],
    ["c", "GET", "/v1/screenshots/x/image"],
    ["d", "POST", "/v1/sessions/../end"],
  ] as const) {
    h.send({ type: "request", id, method, path, headers: auth });
    const m = await h.next();
    assert.deepEqual([m.type, (m as { code: string }).code, (m as { id: string }).id], ["error", "route_not_allowed", id]);
  }
  h.send({ type: "request", id: "e", method: "POST", path: "/v1/events", headers: { ...auth, cookie: "s=1" }, body: "{}" });
  const inv = await h.next();
  assert.deepEqual([(inv as { code: string }).code, (inv as { id: string }).id, (inv as { fatal: boolean }).fatal], ["invalid_message", "e", false]);
  h.send({ type: "request", id: "f", method: "POST", path: "/v1/events", headers: auth, body: "{}" });
  assert.equal(((await h.next()) as { status: number }).status, 200);
  assert.deepEqual(seen.map((s) => s.path), ["/v1/events"], "nothing but the valid bridge call reached the relay");
  assert.deepEqual(Object.keys(seen[0]?.headers ?? {}).sort(), ["accept", "authorization"]);
  h.end();
  await h.exit;
});

test("relay errors: unreachable service, timeout, oversized response, busy", async () => {
  // Unreachable: a closed port.
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const h1 = harness({ config: cfg({ serviceUrl: `http://127.0.0.1:${deadPort}` }) });
  h1.send(hello);
  const w = await h1.next();
  assert.equal(w.type === "welcome" && w.service.reachable, false);
  h1.send({ type: "request", id: "u", method: "POST", path: "/v1/events", headers: auth, body: "{}" });
  const u = await h1.next();
  assert.deepEqual([(u as { code: string }).code, (u as { retryable: boolean }).retryable], ["service_unreachable", true]);
  h1.end();
  await h1.exit;

  // Timeout: a server that never answers.
  const hang: Server = createServer(() => undefined);
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  const hp = (hang.address() as AddressInfo).port;
  const h2 = harness({ config: cfg({ serviceUrl: `http://127.0.0.1:${hp}`, timeoutMs: 500 }) });
  h2.send(hello);
  await h2.next();
  h2.send({ type: "request", id: "t", method: "POST", path: "/v1/events", headers: auth, body: "{}" });
  const t = await h2.next();
  assert.deepEqual([(t as { code: string }).code, (t as { retryable: boolean }).retryable], ["timeout", true]);
  h2.end();
  await h2.exit;
  hang.closeAllConnections();
  await new Promise<void>((r) => hang.close(() => r()));

  // Oversized response: Chrome would refuse it, so the host answers with an error instead.
  const big: Server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ blob: "x".repeat(NATIVE_MAX_TO_EXTENSION_BYTES + 10) }));
  });
  await new Promise<void>((r) => big.listen(0, "127.0.0.1", r));
  const h3 = harness({ config: cfg({ serviceUrl: `http://127.0.0.1:${(big.address() as AddressInfo).port}` }) });
  h3.send(hello);
  await h3.next();
  h3.send({ type: "request", id: "big", method: "POST", path: "/v1/events", headers: auth, body: "{}" });
  assert.equal(((await h3.next()) as { code: string }).code, "response_too_large");
  h3.end();
  await h3.exit;
  await new Promise<void>((r) => big.close(() => r()));

  // Busy: in-flight cap.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const h4 = harness({ maxInFlight: 1, relay: async (r) => (r.path === "/healthz" ? { status: 200, body: {} } : (await gate, { status: 200, body: {} })) });
  h4.send(hello);
  await h4.next();
  h4.send({ type: "request", id: "x1", method: "POST", path: "/v1/events", headers: auth, body: "{}" });
  h4.send({ type: "request", id: "x2", method: "POST", path: "/v1/events", headers: auth, body: "{}" });
  const busy = await h4.next();
  assert.deepEqual([(busy as { code: string }).code, (busy as { id: string }).id], ["busy", "x2"]);
  release();
  assert.equal(((await h4.next()) as { id: string }).id, "x1");
  h4.end();
  await h4.exit;
});

test("a framing error is fatal (the stream cannot be resynchronised)", async () => {
  const h = harness();
  const head = Buffer.alloc(4);
  head.writeUInt32LE(3, 0);
  h.raw(Buffer.concat([head, Buffer.from("{{{")]));
  const m = await h.next();
  assert.deepEqual([(m as { code: string }).code, (m as { fatal: boolean }).fatal], ["invalid_message", true]);
  assert.equal(await h.exit, 1);
});

test("the host process speaks the Chrome protocol over stdio and logs without secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-nh-"));
  try {
    const cfgPath = join(dir, "native-host.json");
    writeFileSync(cfgPath, JSON.stringify({ serviceUrl: svc.base, allowedOrigins: [EXT], timeoutMs: 5000, logDir: join(dir, "logs") }));
    const main = fileURLToPath(new URL("../src/native/main.ts", import.meta.url));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "--config", cfgPath, EXT], { stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new FrameDecoder(2 * 1024 * 1024);
    const got: HostToExtension[] = [];
    const waiters: Array<() => void> = [];
    child.stdout.on("data", (c: Buffer) => {
      got.push(...(decoder.push(c) as HostToExtension[]));
      waiters.splice(0).forEach((w) => w());
    });
    const waitFor = async (n: number) => {
      const deadline = Date.now() + 10_000;
      while (got.length < n) {
        assert.ok(Date.now() < deadline, "host answered");
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 200);
        });
      }
    };
    child.stdin.write(encodeFrame(hello, 1024));
    child.stdin.write(encodeFrame({ type: "request", id: "h1", method: "GET", path: "/v1/bridge/handshake", headers: auth }, 4096));
    await waitFor(2);
    assert.equal(got[0]?.type, "welcome");
    assert.equal((got[1] as { status: number }).status, 200);
    const code = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
    child.stdin.end();
    assert.equal(await code, 0, "exits cleanly when Chrome closes the port");
    const log = readFileSync(join(dir, "logs", "native-host.log"), "utf8");
    assert.match(log, /"msg":"relayed"/);
    assert.ok(!log.includes(TEST_TOKEN), "the bearer token is never logged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
