/**
 * Portable entry-point check (same as windows-service/src/main-module.ts; kept
 * local because packages may not import each other and shared must stay free of
 * node: builtins). Compares real paths so it works on Windows and via symlinks.
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
