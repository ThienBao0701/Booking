// Print the dashboard link for the local service (ADR-0006).
// The token travels in the URL fragment, which the browser never sends to any
// server; the dashboard moves it to sessionStorage and removes it from the
// address bar. Treat the printed link like the token itself.
//
// Run: pnpm run dashboard:url   (honours LAB_DATA_DIR, LAB_SERVICE_HOST, LAB_SERVICE_PORT, LAB_AUTH_TOKEN)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = process.env.LAB_DATA_DIR ?? "./.lab-runtime";
const host = process.env.LAB_SERVICE_HOST ?? "127.0.0.1";
const port = process.env.LAB_SERVICE_PORT ?? "4577";
const tokenPath = join(dataDir, "auth-token.txt");
const token = process.env.LAB_AUTH_TOKEN ?? (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "");
if (!token) {
  console.error(`No token found at ${tokenPath}. Start the service once (pnpm run start:service) or set LAB_DATA_DIR.`);
  process.exit(1);
}
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing to print a link for non-loopback host ${host}.`);
  process.exit(1);
}
const h = host === "::1" ? "[::1]" : host;
console.log(`http://${h}:${port}/dashboard/#token=${encodeURIComponent(token)}`);
