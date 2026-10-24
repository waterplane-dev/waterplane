/**
 * `api.tail` — follow a JSONL file a CLI appends to, rotation-safe. One implementation for every
 * backend plugin (they each copied a `tail.mjs`).
 *
 * `advance()` reads at most one 1 MiB window from where it stopped and hands `onLine` each COMPLETE
 * line that parses as JSON, once. A partial last line is held back until its newline arrives. The
 * file counts as REPLACED (read again from 0) when its inode changed or it is shorter than the
 * offset — a truncate-and-regrow is a new file. Unparsable lines are skipped, never thrown.
 * Returns true when it consumed bytes, false when there was nothing new, null when the file is
 * absent (unknown, not "no news") or the tail is closed.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** One read window: bounds memory on a huge backlog; the caller loops while `advance()` is true. */
export const TAIL_WINDOW_BYTES = 1024 * 1024;

export interface Tail {
  advance(): boolean | null;
  offset(): number;
  close(): void;
}

export function tailJsonl(path: string, onLine: (obj: any) => void, opts: { filter?: (line: string) => boolean } = {}): Tail {
  let off = 0;
  let ino: number | null = null;
  let closed = false;
  let skipping = false; // inside a line longer than a whole window: dropped up to its newline

  const consume = (buf: Buffer, upTo: number): void => {
    let start = 0;
    for (let i = 0; i < upTo; i++) {
      if (buf[i] !== 0x0a) continue;
      const line = buf.subarray(start, i).toString("utf8").trim();
      start = i + 1;
      if (skipping) { skipping = false; continue; }
      if (!line) continue;
      if (opts.filter) { try { if (!opts.filter(line)) continue; } catch { continue; } }
      let obj: unknown;
      try { obj = JSON.parse(line); } catch { continue; }
      try { onLine(obj); } catch { /* a plugin's handler throwing never stops the follow */ }
    }
  };

  return {
    advance() {
      if (closed) return null;
      let fd: number;
      try { fd = openSync(path, "r"); } catch { return null; }
      try {
        const st = fstatSync(fd);
        if (ino !== null && st.ino !== ino) { off = 0; skipping = false; }
        ino = st.ino;
        if (st.size < off) { off = 0; skipping = false; }
        if (st.size === off) return false;
        const len = Math.min(TAIL_WINDOW_BYTES, st.size - off);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, off);
        if (n <= 0) return false;
        const lastNl = buf.subarray(0, n).lastIndexOf(0x0a);
        if (lastNl < 0) {
          if (n < TAIL_WINDOW_BYTES) return false; // a partial line: wait for its newline
          skipping = true; off += n; return true; // a line longer than a window is dropped, not stalled on
        }
        consume(buf, lastNl + 1);
        off += lastNl + 1;
        return true;
      } catch { return null; } finally { try { closeSync(fd); } catch { /* */ } }
    },
    offset: () => off,
    close() { closed = true; },
  };
}
