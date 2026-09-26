/** What every page receives from the shell. */

import type { Api } from "./api.ts";
import type { Page, Route } from "./route.ts";

export interface Ctx {
  api: Api;
  route: Route;
  now: number;
  /** False once the user navigated away (drop late renders). */
  alive: () => boolean;
  go: (page: Page, params?: Record<string, string | number | undefined>, id?: string) => void;
  /** Same page and id, new parameters. */
  setParams: (params: Record<string, string>) => void;
  openEvent: (id: string) => void;
  /** Recent session ids (cached) for pickers. */
  recentSessions: () => Promise<string[]>;
}

export type PageRender = (ctx: Ctx, main: HTMLElement) => Promise<void>;
