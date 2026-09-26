/** Query/body parameter validation shared by the read routes. Invalid → 400, never 500. */

import { HttpError } from "../http.ts";

export const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Max ids accepted in one list parameter (runs, graphs, environment, reports). */
export const MAX_ANALYSIS_SESSIONS = 200;
const MAX_Q = 200;

export function intParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new HttpError(400, `invalid_${name}`);
  return n;
}

/** Signed integer within [min, max] (e.g. a timezone offset in minutes). */
export function boundedIntParam(url: URL, name: string, min: number, max: number): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `invalid_${name}`);
  return n;
}

export function enumParam<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new HttpError(400, `invalid_${name}`);
  return v as T;
}

export function idParam(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (!ID_RE.test(v)) throw new HttpError(400, `invalid_${name}`);
  return v;
}

export function searchParam(url: URL, name = "q"): string | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  if (v.length > MAX_Q) throw new HttpError(400, `invalid_${name}`);
  return v;
}

/** A list of session ids from a comma-separated string or a JSON array. */
export function sessionIdList(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = typeof raw === "string" ? raw.split(",").filter((s) => s.length > 0) : raw;
  if (!Array.isArray(list)) throw new HttpError(400, `${field}_must_be_list`);
  if (list.length > MAX_ANALYSIS_SESSIONS) throw new HttpError(400, `${field}_too_many`);
  for (const id of list) if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(400, `${field}_invalid_id`);
  return [...new Set(list as string[])];
}
