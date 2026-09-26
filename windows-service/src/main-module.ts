/**
 * Portable "is this module the process entry point?" check.
 *
 * The naive `import.meta.url === \`file://${process.argv[1]}\`` is POSIX-only:
 * on Windows argv[1] is `C:\…\index.ts` while import.meta.url is
 * `file:///C:/…/index.ts`, so entry points would silently never start. It also
 * fails when launched through a symlink. Comparing real paths works everywhere.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(metaUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
