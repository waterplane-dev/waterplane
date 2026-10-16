/**
 * The series file's torn tail, mended before the engine reads it.
 *
 * The engine appends rows with one `appendFileSync` of `row + "\n"` per batch. A run stopped
 * mid-write (our own `worker.terminate()` at the step cap, a killed window, a full disk) can leave
 * a last line with no newline that is not JSON — and then every `status` and `update` after it dies
 * on `JSON.parse` ("Unterminated string in JSON") for ever, because the engine reads every line.
 *
 * Only the TRAILING segment after the last "\n" is ever touched, and only in two ways:
 *  - non-empty and not JSON → cut off exactly (truncate to the byte after the last "\n"); the row
 *    it was is measured again by the next `update`, which carries on from the last whole row;
 *  - a whole row that only lost its "\n" → the "\n" is written, so the next append does not glue
 *    two rows into one bad line.
 * Every earlier line is left as it is: a bad line in the middle is not a torn write, and the
 * engine's own error says so.
 */
import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";

export const TORN_TAIL_NOTE = "The last row was cut off by a stopped run and was dropped; it will be measured again.";

const CHUNK = 64 * 1024;

/** "cut" = a partial last line was dropped; "newline" = a whole last row got its "\n"; null = nothing to mend (or no file). */
export function mendSeriesTail(file: string): "cut" | "newline" | null {
  let fd: number;
  try {
    fd = openSync(file, "r+");
  } catch {
    return null; // no series yet (or unreadable: the engine's own read says why)
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    // Walk back from the end in chunks to the last "\n", collecting the tail.
    const parts: Buffer[] = [];
    let end = size;
    let nl = -1;
    while (end > 0 && nl < 0) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const i = buf.lastIndexOf(0x0a);
      if (i >= 0) {
        nl = start + i;
        parts.unshift(buf.subarray(i + 1));
      } else {
        parts.unshift(buf);
      }
      end = start;
    }
    const tail = Buffer.concat(parts).toString("utf8");
    if (!tail.trim()) return null; // ends in "\n" (or only whitespace after it): whole
    try {
      JSON.parse(tail);
    } catch {
      ftruncateSync(fd, nl + 1); // nl === -1 (one torn line, no row before it) → 0
      return "cut";
    }
    writeSync(fd, "\n", size); // at the end: an "r+" fd writes at a position, never appends
    return "newline";
  } finally {
    closeSync(fd);
  }
}
