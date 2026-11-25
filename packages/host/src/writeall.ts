/**
 * Every byte of a buffer to an open file. `write(2)` may take part of it and report the count: a full disk
 * often does, with the error only on the NEXT call. `writeSync` hands that count back and leaves the rest to
 * the caller, so a bare `writeSync(fd, buf)` is a file that is cut short with nothing thrown. This continues
 * until all of it is written; a call that takes nothing throws, never loops. What a write that failed half
 * way means (remove the file, refuse, take the line back out) is the caller's decision; how much of it is
 * in the file by then is on the error (`wroteBefore`).
 *
 * A whole new file by path needs none of this: `jsonstore.ts`'s `writeTextAtomic`, or `writeFileSync` (which
 * loops). `test/shortwrite.test.mjs` refuses a bare `writeSync` anywhere else in the host.
 */
import { writeSync } from "node:fs";

/** `fs.writeSync`'s shape: writes up to `length` bytes from `offset` and returns how many it wrote. */
export type WriteSome = (fd: number, buf: Uint8Array, offset: number, length: number) => number;

export function writeAll(fd: number, data: string | Uint8Array, write: WriteSome = writeSync): void {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let off = 0;
  try {
    while (off < buf.length) {
      const n = write(fd, buf, off, buf.length - off);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`a write took ${String(n)} of ${buf.length - off} bytes left`);
      off += n;
    }
  } catch (e) { wrote.set(e as object, off); throw e; }
}

const wrote = new WeakMap<object, number>();
/** How many bytes a failed `writeAll` had written before it threw `e`. */
export const wroteBefore = (e: unknown): number => wrote.get(e as object) ?? 0;
