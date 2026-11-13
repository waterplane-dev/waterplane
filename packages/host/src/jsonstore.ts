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
import { inRoot } from "./paths.js";

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
 *
 * Writing THROUGH a link is also how a committed `.gitignore -> ~/.gitconfig`
 * would rewrite a file outside the repo, so a caller rewriting a file inside a
 * worktree names it as `within`: a target that resolves outside it is refused,
 * in words, before any byte is written (`inRoot`, realpath on both sides).
 * In-repo links keep working.
 */
export function writeTextAtomicKeepMode(path: string, body: string, within?: string): void {
  let target = path;
  let mode: number | undefined;
  try {
    target = realpathSync(path);
    mode = statSync(target).mode & 0o7777;
  } catch { /* absent: a new file, today's default mode */ }
  if (within !== undefined && inRoot(within, target) === null) {
    throw new Error(`${basename(path)} is a link out of the repo — not written through`);
  }
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
   *  (null when even the move failed, or when it was deliberately left), and why
   *  it was refused. `unreadable` is true when the file could not be READ at all
   *  (EACCES, EIO) as against read but not parsed: a caller that refuses or fails
   *  closed on a store it cannot read keys off this, never off `movedTo`. */
  corrupt?: { movedTo: string | null; error: string; unreadable?: boolean };
}

export interface GuardedReadOpts {
  /** Leave a file that cannot be READ where it is (movedTo null, `unreadable` true)
   *  instead of moving it aside. For a store that refuses or fails closed on an
   *  unreadable file, so fixing the permissions brings the real bytes back. */
  keepUnreadable?: boolean;
}

/** Errors of the process, not of the file: the bytes are fine and the next read may
 *  succeed. Moving the file aside for these would take a good store out of service
 *  (a rename needs no fd, a write does). */
const PROCESS_LEVEL = new Set(["EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "EINTR"]);

/** The path a corrupt file is moved to. Exported for tests and messages. */
export function corruptPathFor(path: string, at = Date.now()): string {
  return `${path}.corrupt-${new Date(at).toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Read and parse `path`, or return `fallback`. Absent ⇒ fallback, silently.
 * Present but unparseable, failing `accept`, or unreadable ⇒ moved aside, logged
 * once, fallback. Never throws.
 */
export function readJsonGuardedDetail<T>(path: string, fallback: T, accept?: (v: unknown) => boolean, opts: GuardedReadOpts = {}): GuardedRead<T> {
  let raw: string;
  try {
    if (!existsSync(path)) return { value: fallback };
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // Unreadable (permissions, EIO): moved aside exactly like a corrupt file. A
    // load-then-save store (nearly all of them) saves its fallback over this name
    // next, and a rename needs no read permission on the file — so leaving the
    // bytes here would let the save replace what nobody read. If even the rename
    // fails the directory is not writable, and the atomic write's own rename
    // fails with it: nothing is overwritten, so log, fall back, movedTo null.
    // Not for a process-level error (EMFILE...): the bytes are fine, a write would
    // fail too, and the next read gets the real data.
    const msg = String((e as Error).message);
    if (opts.keepUnreadable || PROCESS_LEVEL.has((e as NodeJS.ErrnoException).code ?? "")) {
      console.error(`[jsonstore] ${path} could not be read (${msg}); left in place; starting from defaults`);
      return { value: fallback, corrupt: { movedTo: null, error: msg, unreadable: true } };
    }
    const r = moveAside(path, fallback, `could not be read (${msg})`, msg);
    r.corrupt!.unreadable = true;
    return r;
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
  return moveAside(path, fallback, `is corrupt (${error})`, error);
}

/** Keep `path`'s bytes under a `.corrupt-` name, say so once, and hand back the fallback. */
function moveAside<T>(path: string, fallback: T, what: string, error: string): GuardedRead<T> {
  let movedTo: string | null = corruptPathFor(path);
  try { renameSync(path, movedTo); } catch { movedTo = null; }
  console.error(
    `[jsonstore] ${path} ${what}; ` +
      (movedTo ? `kept as ${movedTo}` : "could not move it aside") +
      "; starting from defaults",
  );
  return { value: fallback, corrupt: { movedTo, error } };
}

/** An `accept` for a store whose file is one JSON object: an array, a number or null is the wrong shape. */
export function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `readJsonGuardedDetail`, value only. */
export function readJsonGuarded<T>(path: string, fallback: T, accept?: (v: unknown) => boolean): T {
  return readJsonGuardedDetail(path, fallback, accept).value;
}
