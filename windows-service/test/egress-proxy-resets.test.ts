/**
 * EgressProxy robustness (regression): a browser may reset a connection at
 * any moment — typically right after a 403. Resets on refused CONNECTs,
 * refused and allowed upgrades, tunnels and half-sent request bodies must be
 * absorbed by the proxy, never crash the process hosting it (the service),
 * and never weaken the policy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo, Socket, createServer as createTcpServer } from "node:net";

import { EgressProxy } from "../src/automation/browser/egress-proxy.ts";

async function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

function rawSocket(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    s.on("error", () => undefined); // the client side may see its own reset
    s.connect(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  });
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("client resets on refused CONNECT / upgrade, tunnels and request bodies never crash the proxy", { timeout: 20_000 }, async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  process.on("uncaughtException", onUncaught);

  // An allowed upstream (HTTP + raw TCP for tunnels) on loopback.
  const web = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => res.end("ok"));
    req.on("error", () => undefined);
  });
  const webPort = await listen(web);
  const tcp = createTcpServer((s) => {
    s.on("error", () => undefined);
    s.on("data", () => undefined);
  });
  const tcpPort = await listen(tcp);
  const allowed = new Set([`http://127.0.0.1:${webPort}`, `https://127.0.0.1:${tcpPort}`]);
  const blocked: string[] = [];
  const proxy = new EgressProxy({ allowOrigin: (o) => ({ allowed: allowed.has(o), reason: allowed.has(o) ? "allowlisted" : "not allowlisted" }), onBlocked: (b) => blocked.push(b.kind) });
  const proxyPort = Number(new URL(await proxy.start()).port);

  try {
    for (let i = 0; i < 20; i++) {
      // 1. refused CONNECT, reset immediately (before and after the 403)
      const a = await rawSocket(proxyPort);
      a.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n");
      if (i % 2) await tick(5);
      a.resetAndDestroy();
      // 2. refused WebSocket upgrade, reset
      const b = await rawSocket(proxyPort);
      b.write("GET http://evil.example/ws HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      if (i % 2) await tick(5);
      b.resetAndDestroy();
    }
    // 3. allowed tunnel, reset mid-stream
    const c = await rawSocket(proxyPort);
    c.write(`CONNECT 127.0.0.1:${tcpPort} HTTP/1.1\r\nHost: 127.0.0.1:${tcpPort}\r\n\r\n`);
    await tick(50);
    c.write("some tunnelled bytes");
    c.resetAndDestroy();
    // 4. allowed upgrade, reset mid-handshake
    const d = await rawSocket(proxyPort);
    d.write(`GET http://127.0.0.1:${webPort}/ws HTTP/1.1\r\nHost: 127.0.0.1:${webPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await tick(20);
    d.resetAndDestroy();
    // 5. allowed plain request, reset half-way through its body
    const e = await rawSocket(proxyPort);
    e.write(`POST http://127.0.0.1:${webPort}/upload HTTP/1.1\r\nHost: 127.0.0.1:${webPort}\r\nContent-Length: 100000\r\n\r\n${"x".repeat(1000)}`);
    await tick(30);
    e.resetAndDestroy();
    await tick(200);

    assert.deepEqual(uncaught, [], "no uncaught socket errors");
    assert.ok(blocked.filter((k) => k === "connect").length >= 1 && blocked.includes("upgrade"), "refusals were still recorded");
    // The proxy still works and still refuses.
    const ok = await fetchVia(proxyPort, `http://127.0.0.1:${webPort}/after`);
    assert.equal(ok, 200);
    assert.equal(await fetchVia(proxyPort, "http://evil.example/after"), 403);
  } finally {
    process.off("uncaughtException", onUncaught);
    await proxy.close();
    web.closeAllConnections();
    await new Promise<void>((r) => web.close(() => r()));
    await new Promise<void>((r) => tcp.close(() => r()));
  }
});

/** A proxied absolute-form GET (what a browser sends to an HTTP proxy); returns the status. */
async function fetchVia(proxyPort: number, url: string): Promise<number> {
  const s = await rawSocket(proxyPort);
  const u = new URL(url);
  return await new Promise<number>((resolve) => {
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) {
        resolve(Number(m[1]));
        s.destroy();
      }
    });
    s.write(`GET ${url} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
  });
}
