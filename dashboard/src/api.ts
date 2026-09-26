/**
 * Typed client for the local service API. Same origin; the bearer token is
 * attached to every call; no cookies. Response shapes are the shared contracts.
 */

import type {
  AnalysisResult,
  AnalysisRunSummary,
  EnvironmentReport,
  Finding,
  FindingDetail,
  ForensicReport,
  LabStats,
  ReplayControlAction,
  ReplayControllerKind,
  ReplayLibraryEntry,
  ReplayPrepareResult,
  ReplayRunListItem,
  ReplayRunStatus,
  ReplayRunSummary,
  RulesInfo,
  SafetyMode,
  ScreenshotRecord,
  ScreenshotSettings,
  ScreenshotUsage,
  RunRecord,
  SessionComparison,
  SessionRecord,
  SessionSummary,
  StoredEventRow,
  WorkflowGraph,
} from "./shared.ts";
import { apiQuery } from "./route.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, details?: unknown) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Q = Record<string, string | number | undefined | null>;

export class Api {
  #token: string;
  #fetch: typeof fetch;
  onUnauthorized: (() => void) | undefined;

  constructor(token: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      credentials: "omit",
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.();
      const code = (json as { error?: string } | undefined)?.error ?? "request_failed";
      throw new ApiError(res.status, code, json);
    }
    return json as T;
  }

  get<T>(path: string, q: Q = {}): Promise<T> {
    return this.#call<T>("GET", `${path}${apiQuery(q)}`);
  }

  /** Raw download (reports): the exact bytes (BOM included), decoded text, and the server-chosen file name. */
  async download(path: string, q: Q = {}): Promise<{ bytes: ArrayBuffer; text: string; filename: string; contentType: string }> {
    const res = await this.#fetch(`${path}${apiQuery(q)}`, { headers: { authorization: `Bearer ${this.#token}` }, cache: "no-store", credentials: "omit" });
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.();
      let code = "request_failed";
      try {
        code = ((await res.json()) as { error?: string }).error ?? code;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, code);
    }
    const cd = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? "lab-report";
    const bytes = await res.arrayBuffer();
    return { bytes, text: new TextDecoder().decode(bytes), filename, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  // ---- typed endpoints ----
  health = () => fetch("/healthz", { cache: "no-store" }).then((r) => r.json() as Promise<Record<string, unknown>>);
  handshake = () => this.get<Record<string, unknown>>("/v1/bridge/handshake");
  stats = (q: Q) => this.get<LabStats & { generated_at: number }>("/v1/stats", q);
  sessions = (q: Q) => this.get<{ total: number; sessions: SessionSummary[] }>("/v1/sessions", q);
  session = (id: string) => this.get<{ session: SessionRecord; eventCount: number }>(`/v1/sessions/${encodeURIComponent(id)}`);
  analysis = (id: string) => this.get<AnalysisResult>(`/v1/sessions/${encodeURIComponent(id)}/analysis`);
  events = (q: Q) => this.get<{ total: number; events: StoredEventRow[] }>("/v1/events", q);
  event = (id: string) => this.get<{ event: StoredEventRow }>(`/v1/events/${encodeURIComponent(id)}`);
  findings = (q: Q) => this.get<{ total: number; findings: Finding[] }>("/v1/findings", q);
  finding = (id: string) => this.get<FindingDetail>(`/v1/findings/${encodeURIComponent(id)}`);
  compare = (a: string, b: string) => this.get<SessionComparison>("/v1/analysis/compare", { a, b });
  graph = (sessions?: string[]) => this.get<WorkflowGraph>("/v1/analysis/graph", { sessions: sessions?.join(",") });
  environments = (sessions?: string[]) => this.get<{ environments: EnvironmentReport[] }>("/v1/analysis/environment", { sessions: sessions?.join(",") });
  runs = (q: Q) => this.get<{ total: number; runs: ReplayRunSummary[] }>("/v1/runs", q);
  run = (id: string) => this.get<{ run: RunRecord }>(`/v1/runs/${encodeURIComponent(id)}`);
  rules = () => this.get<RulesInfo>("/v1/analysis/rules");
  putRules = (rules: unknown) => this.#call<{ source: string; version: string; rules: number }>("PUT", "/v1/analysis/rules", rules);
  resetRules = () => this.#call<{ source: string; version: string }>("DELETE", "/v1/analysis/rules");
  report = (id: string, compare?: string) => this.get<ForensicReport>(`/v1/reports/sessions/${encodeURIComponent(id)}`, { format: "json", compare });
  reportFile = (id: string, q: Q) => this.download(`/v1/reports/sessions/${encodeURIComponent(id)}`, q);
  screenshots = (q: Q) => this.get<{ total: number; screenshots: ScreenshotRecord[] }>("/v1/screenshots", q);
  screenshotSettings = () => this.get<{ settings: ScreenshotSettings; usage: ScreenshotUsage; error: string | null }>("/v1/screenshots/settings");
  putScreenshotSettings = (s: ScreenshotSettings) => this.#call<{ settings: ScreenshotSettings; usage: ScreenshotUsage }>("PUT", "/v1/screenshots/settings", s);
  deleteScreenshot = (id: string) => this.#call<{ deleted: boolean }>("DELETE", `/v1/screenshots/${encodeURIComponent(id)}`);
  deleteSessionScreenshots = (sessionId: string) => this.#call<{ deleted: number }>("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}/screenshots`);
  applyScreenshotRetention = () => this.#call<{ deleted: number; orphans: number }>("POST", "/v1/screenshots/retention", {});
  /** The PNG as a blob: URL (fetched with the token). Revoke when done. */
  screenshotImage = async (id: string): Promise<string> => {
    const file = await this.download(`/v1/screenshots/${encodeURIComponent(id)}/image`);
    return URL.createObjectURL(new Blob([file.bytes], { type: "image/png" }));
  };
  // ---- dashboard replay (Phase 13) ----
  replayWorkflows = () => this.get<{ workflows: ReplayLibraryEntry[]; serviceMode: SafetyMode }>("/v1/replay/workflows");
  replayWorkflow = (id: string) => this.get<{ workflow: unknown; exampleParams: Record<string, string> | null }>(`/v1/replay/workflows/${encodeURIComponent(id)}`);
  /** Dry run: validates and authorizes; nothing executes. */
  replayPrepare = (body: {
    workflowId?: string;
    sessionId?: string;
    mode: SafetyMode;
    controller: ReplayControllerKind;
    allowOrigins?: string[];
    resourceOrigins?: string[];
    params?: Record<string, string>;
  }) => this.#call<ReplayPrepareResult>("POST", "/v1/replay/prepare", body);
  replayRuns = () => this.get<{ runs: ReplayRunListItem[]; serviceMode: SafetyMode }>("/v1/replay/runs");
  replayStatus = (id: string, since = 0) => this.get<ReplayRunStatus>(`/v1/replay/runs/${encodeURIComponent(id)}`, { since });
  /** Explicit operator action: the plan's single-use token plus the acknowledgement. */
  replayStart = (id: string, confirmToken: string) => this.#call<ReplayRunStatus>("POST", `/v1/replay/runs/${encodeURIComponent(id)}/start`, { confirmToken, acknowledge: true });
  replayControl = (id: string, action: ReplayControlAction, arg: { label?: string; checkpointId?: string } = {}) =>
    this.#call<ReplayRunStatus>("POST", `/v1/replay/runs/${encodeURIComponent(id)}/${action}`, arg);
  replayDiscard = (id: string) => this.#call<{ discarded: boolean }>("DELETE", `/v1/replay/runs/${encodeURIComponent(id)}`);
  runAnalysis = (sessionIds?: string[]) => this.#call<AnalysisRunSummary>("POST", "/v1/analysis/run", sessionIds ? { sessionIds } : {});
}
