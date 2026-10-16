/**
 * The two halves of a persisted JSON store that every store gets wrong alone.
 *
 * `writeJsonAtomic` — full contents into a sibling tmp file, fsync, rename over
 * the real one. A plain `writeFileSync` truncates first, so a SIGTERM (launchd's
 * `kickstart -k` on every `npm run restart`) landing mid-write leaves half a JSON
 * document. Rename is atomic within a directory, so a reader only ever sees the
 * old document or the new one; the fsync is there so a power loss after the
 * rename cannot surface a zero-length file under the real name. `mode` is applied
 * to the tmp file BEFORE any byte is written and survives the rename, so a secret
 * is never readable by anyone else, not even for the length of one write. Throws
 * on failure (after removing the tmp file): whether a failed write is fatal is
 * the CALLER'S decision, never this helper's.
 *
 * `readJsonGuarded` — the boot path. A file that is absent is the fallback,
 * silently. A file that is PRESENT and does not parse is moved aside to
 * `<name>.corrupt-<ts>` and logged once, and the fallback is returned: the
 * daemon boots, and the bytes are kept for a person to look at, never
 * overwritten by the next write. That is the difference from the
 * `try { JSON.parse } catch { fresh }` most stores hand-roll — that shape boots
 * too, but the very next save erases the only evidence that anything was lost.
 * A `.corrupt-*` copy is `unknown` to `hoststore.ts`: counted, shown, never
 * cleared by it.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface WriteJsonOpts {
  /** File mode for the result (e.g. 0o600 for a key). Default: the umask's. */
  mode?: number;
  /** Indentation for `JSON.stringify`. Default: compact. */
  space?: number;
  /** End the file with a newline (for files a person may open in an editor). */
  newline?: boolean;
}

/** Atomic, durable JSON write. Throws on failure; the tmp file never lingers. */
export function writeJsonAtomic(path: string, value: unknown, opts: WriteJsonOpts = {}): void {
  writeTextAtomic(path, JSON.stringify(value, null, opts.space) + (opts.newline ? "\n" : ""), opts);
}

/** The same tmp + fsync + rename for a body the caller already rendered (a JSONL ledger, an opaque state blob). */
export function writeTextAtomic(path: string, body: string, opts: Pick<WriteJsonOpts, "mode"> = {}): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", opts.mode ?? 0o666);
    writeFileSync(fd, body); // loops until every byte is written
    try { fsyncSync(fd); } catch { /* a filesystem that cannot fsync still gets the rename */ }
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
  // The rename itself is durable only once the directory entry is. Best effort:
  // not every platform lets a directory be opened for fsync.
  try { const d = openSync(dir, "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* best effort */ }
}

/**
 * `writeTextAtomic` for a file that BELONGS TO SOMEONE ELSE — a repo's `.gitignore`
 * or `CLAUDE.md`, rewritten to add a block. Two things a store's own file never
 * needs: the existing mode is carried over (a rename would otherwise swap in the
 * umask's mode, silently loosening 0600 or dropping an executable bit), and a
 * symlink is written THROUGH (a rename over the link would replace it with a
 * regular file and orphan the real one). A file that does not exist yet gets the
 * same mode a plain `writeFileSync` would have given it.
 */
export function writeTextAtomicKeepMode(path: string, body: string): void {
  let target = path;
  let mode: number | undefined;
  try {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o7777;
  } catch { /* absent: a new file, today's default mode */ }
  writeTextAtomic(target, body, { mode });
}

/** Rotate a JSONL ledger: keep the newest `keep` lines, via the atomic write (a kill mid-rotation leaves the old file whole). */
export function keepLastLines(path: string, keep: number): void {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  writeTextAtomic(path, lines.slice(-keep).join("\n") + "\n");
}

/** What `readJsonGuarded` found, for a caller that must act on a loss (acks.ts). */
export interface GuardedRead<T> {
  value: T;
  /** Set only when a file was PRESENT and unreadable: where its bytes went
   *  (null when even the move failed), and why it was refused. */
  corrupt?: { movedTo: string | null; error: string };
}

/** The path a corrupt file is moved to. Exported for tests and messages. */
export function corruptPathFor(path: string, at = Date.now()): string {
  return `${path}.corrupt-${new Date(at).toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Read and parse `path`, or return `fallback`. Absent ⇒ fallback, silently.
 * Present but unparseable (or failing `accept`) ⇒ moved aside, logged once,
 * fallback. Never throws.
 */
export function readJsonGuardedDetail<T>(path: string, fallback: T, accept?: (v: unknown) => boolean): GuardedRead<T> {
  let raw: string;
  try {
    if (!existsSync(path)) return { value: fallback };
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // Unreadable (permissions, EIO): leave it where it is — moving a file we
    // cannot read is not ours to decide — but say so.
    console.error(`[jsonstore] ${path} could not be read (${(e as Error).message}); starting from defaults`);
    return { value: fallback, corrupt: { movedTo: null, error: String((e as Error).message) } };
  }
  let parsed: unknown;
  let error: string | null = null;
  try {
    parsed = JSON.parse(raw);
    if (accept && !accept(parsed)) error = "unexpected shape";
  } catch (e) {
    error = String((e as Error).message);
  }
  if (error === null) return { value: parsed as T };
  let movedTo: string | null = corruptPathFor(path);
  try { renameSync(path, movedTo); } catch { movedTo = null; }
  console.error(
    `[jsonstore] ${path} is corrupt (${error}); ` +
      (movedTo ? `kept as ${movedTo}` : "could not move it aside") +
      "; starting from defaults",
  );
  return { value: fallback, corrupt: { movedTo, error } };
}

/** `readJsonGuardedDetail`, value only. */
export function readJsonGuarded<T>(path: string, fallback: T, accept?: (v: unknown) => boolean): T {
  return readJsonGuardedDetail(path, fallback, accept).value;
}
