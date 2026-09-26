import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWatchdog, acquireLock } from "../src/watchdog.ts";

test("single-instance lock rejects a second holder", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-lock-"));
  try {
    acquireLock(dir);
    assert.throws(() => acquireLock(dir), /another watchdog is running/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restarts a crashing child and gives up after maxRestarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-wd-"));
  const entry = join(dir, "crash.ts");
  writeFileSync(entry, "process.exit(1);\n");
  const events: string[] = [];
  try {
    await new Promise<void>((resolve) => {
      startWatchdog({
        dataDir: dir,
        entry,
        maxRestarts: 2,
        minBackoffMs: 20,
        maxBackoffMs: 40,
        healthyUptimeMs: 60_000,
        onEvent: (e) => {
          events.push(e.type);
          if (e.type === "stopped") resolve();
        },
      });
    });
    const spawns = events.filter((e) => e === "spawn").length;
    assert.equal(spawns, 3, `expected 3 spawns (initial + 2 restarts), got ${spawns}`);
    assert.ok(events.includes("give_up"));
    assert.ok(events.includes("stopped"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
