/**
 * HTTP primitives shared by the API router and its route modules: JSON
 * responses with hardening headers, size-limited JSON bodies, typed client errors.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB per request

export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(json);
}

/** A client error with an HTTP status (request validation), never a 500. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "payload_too_large"));
        req.resume(); // drain without buffering so the 413 can be sent
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > maxBytes) return;
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
    req.on("error", reject);
  });
}
