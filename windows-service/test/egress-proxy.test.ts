/** EgressProxy: the per-session enforcement point for the browser allowlist (real sockets, loopback only). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Server, createServer, request } from "node:http";
import { type AddressInfo, type Socket, connect, createServer as createTcpServer } from "node:net";

import { EgressProxy } from "../src/automation/browser/egress-proxy.ts";

function listen(s: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
}

async function withServers(fn: (ctx: { proxy: EgressProxy; okPort: number; badPort: number; hits: string[]; blocked: string[] }) => Promise<void>): Promise<void> {
  const hits: string[] = [];
  const ok = createServer((req, res) => {
    hits.push(`ok ${req.method} ${req.url} host=${req.headers.host} proxy-hdr=${String(req.headers["proxy-connection"] ?? "")}`);
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${badPort}/landing` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain", "x-upstream": "ok" });
    res.end("hello");
  });
  const bad = createServer((req, res) => {
    hits.push(`bad ${req.url}`);
    res.end("should never be reached");
  });
  const okPort = await listen(ok);
  const badPort = await listen(bad);
  const allowed = new Set([`http://127.0.0.1:${okPort}`, `https://127.0.0.1:${okPort}`]);
  const blocked: string[] = [];
  const proxy = new EgressProxy({
    allowOrigin: (o) => ({ allowed: allowed.has(o), reason: allowed.has(o) ? "ok" : "not allowlisted" }),
    onBlocked: (b) => blocked.push(`${b.kind} ${b.url}`),
  });
  await proxy.start();
  try {
    await fn({ proxy, okPort, badPort, hits, blocked });
  } finally {
    await proxy.close();
    await new Promise<void>((r) => ok.close(() => r()));
    await new Promise<void>((r) => bad.close(() => r()));
  }
}

function viaProxy(proxy: EgressProxy, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: p.hostname, port: p.port, method: "GET", path: url, headers: { host: new URL(url).host, "proxy-connection": "keep-alive", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function rawConnect(proxy: EgressProxy, target: string): Promise<{ status: string; socket: Socket }> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const s = connect(Number(p.port), p.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`));
    s.once("data", (d: Buffer) => resolve({ status: d.toString().split("\r\n")[0] ?? "", socket: s }));
    s.on("error", reject);
  });
}

test("binds loopback only", async () => {
  const proxy = new EgressProxy({ allowOrigin: () => ({ allowed: false, reason: "x" }) });
  const url = await proxy.start();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  await proxy.close();
});

test("HTTP: allowlisted origins are forwarded (hop-by-hop headers dropped); others get 403 and are never contacted", async () => {
  await withServers(async ({ proxy, okPort, badPort, hits, blocked }) => {
    const ok = await viaProxy(proxy, `http://127.0.0.1:${okPort}/page?q=1`);
    assert.deepEqual([ok.status, ok.body, ok.headers["x-upstream"]], [200, "hello", "ok"]);
    assert.match(hits[0] ?? "", /^ok GET \/page\?q=1 host=127\.0\.0\.1:\d+ proxy-hdr=$/, "Proxy-Connection is not forwarded");
    const bad = await viaProxy(proxy, `http://127.0.0.1:${badPort}/x`);
    assert.equal(bad.status, 403);
    // A redirect is passed back to the browser, whose next hop is checked again.
    const redirect = await viaProxy(proxy, `http://127.0.0.1:${okPort}/redirect`);
    assert.equal(redirect.status, 302);
    const hop = await viaProxy(proxy, String(redirect.headers.location));
    assert.equal(hop.status, 403);
    assert.ok(!hits.some((h) => h.startsWith("bad")), hits.join("\n"));
    assert.deepEqual(blocked, [`http http://127.0.0.1:${badPort}/x`, `http http://127.0.0.1:${badPort}/landing`]);
    assert.deepEqual(proxy.stats, { forwarded: 2, blocked: 2 });
  });
});

test("CONNECT: tunnels only to allowlisted https origins", async () => {
  const echo = createTcpServer((s) => s.pipe(s));
  const echoPort = await listen(echo);
  const allowed = `https://127.0.0.1:${echoPort}`;
  const blocked: string[] = [];
  const proxy = new EgressProxy({ allowOrigin: (o) => ({ allowed: o === allowed, reason: "not allowlisted" }), onBlocked: (b) => blocked.push(`${b.kind} ${b.url}`) });
  await proxy.start();
  try {
    const ok = await rawConnect(proxy, `127.0.0.1:${echoPort}`);
    assert.match(ok.status, /^HTTP\/1\.1 200/);
    const echoed = await new Promise<string>((r) => {
      ok.socket.once("data", (d: Buffer) => r(d.toString()));
      ok.socket.write("ping");
    });
    assert.equal(echoed, "ping");
    ok.socket.destroy();
    const denied = await rawConnect(proxy, "127.0.0.1:1");
    assert.match(denied.status, /^HTTP\/1\.1 403/);
    denied.socket.destroy();
    const malformed = await rawConnect(proxy, "evil.example");
    assert.match(malformed.status, /^HTTP\/1\.1 403/);
    malformed.socket.destroy();
    assert.equal(blocked.length, 2);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => echo.close(() => r()));
  }
});

test("WebSocket upgrades are checked like any other request; non-http schemes are refused", async () => {
  await withServers(async ({ proxy, badPort, hits, blocked }) => {
    const p = new URL(proxy.url);
    const status = await new Promise<string>((resolve, reject) => {
      const s = connect(Number(p.port), p.hostname, () =>
        s.write(`GET http://127.0.0.1:${badPort}/socket HTTP/1.1\r\nhost: 127.0.0.1:${badPort}\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n`),
      );
      s.once("data", (d: Buffer) => {
        resolve(d.toString().split("\r\n")[0] ?? "");
        s.destroy();
      });
      s.on("error", reject);
    });
    assert.match(status, /^HTTP\/1\.1 403/);
    const ftp = await viaProxy(proxy, "ftp://127.0.0.1/file").catch(() => ({ status: 0 }));
    assert.ok(ftp.status === 403 || ftp.status === 400, String(ftp.status));
    assert.ok(!hits.some((h) => h.startsWith("bad")));
    assert.ok(blocked.some((b) => b.startsWith("upgrade")));
  });
});
