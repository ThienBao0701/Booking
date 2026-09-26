/**
 * Structured JSON logging with size-based rolling (Component 2/13/16).
 * Zero dependencies. Never logs secrets; callers pass already-safe fields.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  dir: string;
  level: LogLevel;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  /** Also echo to stdout (default true). */
  stdout?: boolean;
}

export class Logger {
  #dir: string;
  #level: LogLevel;
  #file: string;
  #maxBytes: number;
  #maxFiles: number;
  #stdout: boolean;

  constructor(opts: LoggerOptions) {
    this.#dir = opts.dir;
    this.#level = opts.level;
    this.#file = join(opts.dir, opts.fileName ?? "service.log");
    this.#maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.#maxFiles = opts.maxFiles ?? 5;
    this.#stdout = opts.stdout ?? true;
    mkdirSync(this.#dir, { recursive: true });
  }

  #roll(): void {
    try {
      if (!existsSync(this.#file)) return;
      const { size } = statSync(this.#file);
      if (size < this.#maxBytes) return;
      // shift .N -> .N+1
      for (let i = this.#maxFiles - 1; i >= 1; i--) {
        const from = `${this.#file}.${i}`;
        const to = `${this.#file}.${i + 1}`;
        if (existsSync(from)) renameSync(from, to);
      }
      renameSync(this.#file, `${this.#file}.1`);
    } catch {
      // rolling is best-effort; never throw from the logger
    }
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.#level]) return;
    const line = JSON.stringify({ ts: Date.now(), level, msg, ...fields });
    if (this.#stdout) {
      const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
      stream.write(line + "\n");
    }
    try {
      this.#roll();
      appendFileSync(this.#file, line + "\n");
    } catch {
      // disk full / permission: do not crash the service on a log write
    }
  }

  debug(msg: string, f?: Record<string, unknown>): void { this.log("debug", msg, f); }
  info(msg: string, f?: Record<string, unknown>): void { this.log("info", msg, f); }
  warn(msg: string, f?: Record<string, unknown>): void { this.log("warn", msg, f); }
  error(msg: string, f?: Record<string, unknown>): void { this.log("error", msg, f); }
}
