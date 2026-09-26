/**
 * Seed a lab store with realistic sessions for dashboard tests: several mock
 * flows (with environment facts), one irregular session, a screenshot record,
 * a replay run record, and persisted findings from the real analyzer.
 */
import type { Store } from "../../windows-service/src/db/store.ts";
import { AnalysisService } from "../../windows-service/src/analysis/service.ts";
import { ENV_A, SessionBuilder, mockFlow, persist } from "../../windows-service/test/analysis-fixtures.ts";

export const SEED_T0 = Date.now() - 3 * 86_400_000;

export interface Seeded {
  sessionIds: string[];
  oddId: string;
  runId: string;
}

export function seedLab(store: Store): Seeded {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const b = mockFlow(`dash-n${i}`, { t0: SEED_T0 + i * 3_600_000, pace: 1 + i * 0.15, env: { ...ENV_A, timezone: i === 3 ? "Asia/Ho_Chi_Minh" : ENV_A.timezone } });
    if (i === 1) {
      b.add("screenshot", { workflow: "REPORTING", metadata: { sha256: "a".repeat(64), bytes: 48_213, format: "png", trigger: "user" } });
    }
    persist(store, b);
    ids.push(b.id);
  }
  const odd = new SessionBuilder("dash-odd", { t0: SEED_T0 + 30 * 3_600_000 });
  odd.start({ ...ENV_A, language: "vi-VN" });
  odd.wait(1000).transition("LOGIN");
  odd.add("page_state", { workflow: "LOGIN", metadata: { view: "login", environment: { viewport: { width: 800, height: 600 }, screen: { width: 1920, height: 1080 }, device_pixel_ratio: 1, color_scheme: "light" } } });
  for (let i = 0; i < 5; i++) odd.wait(300).click("#login-submit", "LOGIN");
  odd.wait(400_000).transition("RATE_SETUP", "LOGIN");
  odd.add("error", { workflow: "RATE_SETUP", severity: "error", metadata: { message: "save failed <script>alert(1)</script>" } });
  odd.wait(1000).click("#rate-submit", "RATE_SETUP");
  odd.wait(9000).transition("RESERVATION", "RATE_SETUP");
  odd.wait(1000).click("#res-submit", "RESERVATION");
  odd.wait(500).end();
  persist(store, odd);
  ids.push(odd.id);

  const runId = "run_dashboard_seed";
  store.saveRun({
    runId,
    workflow: "mock-full-flow",
    mode: "SIMULATE",
    startedAt: SEED_T0 + 40 * 3_600_000,
    endedAt: SEED_T0 + 40 * 3_600_000 + 4200,
    status: "completed",
    checkpoints: ["cp-1"],
    sourceSessionId: "dash-n0",
    dryRun: false,
    target: { kind: "mock", baseUrl: "http://127.0.0.1:4599" },
    steps: [
      { id: "login", status: "ok", attempts: 1, startedAt: SEED_T0 + 40 * 3_600_000, endedAt: SEED_T0 + 40 * 3_600_000 + 900 },
      { id: "shot", status: "skipped", attempts: 1 },
    ],
  });
  new AnalysisService({ store }).run(ids);
  return { sessionIds: ids, oddId: odd.id, runId };
}
