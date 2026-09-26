/**
 * Mock Extranet bootstrap. Loopback by default.
 * Run: node --experimental-strip-types src/index.ts
 */

import { createMockServer } from "./api.ts";

const HOST = process.env.MOCK_EXTRANET_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MOCK_EXTRANET_PORT ?? 4599);

const { server } = createMockServer();

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  server.listen(PORT, HOST, () => {
    process.stdout.write(`mock-extranet listening on http://${HOST}:${PORT}\n`);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

export { createMockServer };
