/**
 * Chrome Native Messaging framing: each message is a 32-bit length in native
 * byte order followed by that many bytes of UTF-8 JSON. The stream cannot be
 * resynchronised after a bad frame, so framing errors are fatal.
 */

import { endianness } from "node:os";

const LE = endianness() === "LE";

export class FrameError extends Error {
  readonly code: "message_too_large" | "invalid_message";
  constructor(code: "message_too_large" | "invalid_message", message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

export function encodeFrame(msg: unknown, maxBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > maxBytes) throw new FrameError("message_too_large", `frame of ${body.length} bytes exceeds ${maxBytes}`);
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length, 0);
  else head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Incremental decoder: push stdin chunks, get whole messages back. */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);
  #max: number;

  constructor(maxBytes: number) {
    this.#max = maxBytes;
  }

  /** Bytes received but not yet part of a whole frame. */
  get pending(): number {
    return this.#buf.length;
  }

  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.#buf.length >= 4) {
      const n = LE ? this.#buf.readUInt32LE(0) : this.#buf.readUInt32BE(0);
      if (n > this.#max) throw new FrameError("message_too_large", `incoming frame of ${n} bytes exceeds ${this.#max}`);
      if (this.#buf.length < 4 + n) break;
      const raw = this.#buf.subarray(4, 4 + n).toString("utf8");
      this.#buf = this.#buf.subarray(4 + n);
      try {
        out.push(JSON.parse(raw));
      } catch {
        throw new FrameError("invalid_message", "frame is not valid JSON");
      }
    }
    return out;
  }
}
