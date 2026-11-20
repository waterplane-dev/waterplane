/**
 * A persisted JSON store for in-repo extensions, with core's rule (host/src/jsonstore.ts, which an
 * extension may not import — `local/extension-boundary`): a store that cannot be READ is never
 * written over and never read as empty.
 *
 * `readStore` answers one of three things, never a fallback:
 *  - `ok`         the parsed value;
 *  - `absent`     no file (ENOENT) — the only case that may start empty;
 *  - `unreadable` the file is there and was not read. `process: true` is an error of the PROCESS
 *                 (EMFILE/ENFILE/ENOMEM/EAGAIN/EINTR): the bytes are fine, the file is LEFT, and
 *                 the caller retries. `process: false` with `corrupt: true` is a file that read but
 *                 did not parse: moved aside to `<name>.corrupt-<ts>` (`movedTo`, null if even that
 *                 failed) and the next read is `absent`. Any other read error (EACCES, EIO) leaves
 *                 the file where it is.
 * A caller that gets `unreadable` must not save over the path until a read says `ok` or `absent`.
 *
 * `writeStore` is tmp (hidden name, `wx`) + fsync + rename, the tmp removed on failure; it throws.
 *
 * The file system is passed in (`node:fs` satisfies `StoreFs`) because shared is also bundled for
 * the phone and imports nothing from node. Tests inject a failing one.
 */
export interface StoreFs {
  readFileSync(path: string, enc: "utf8"): string;
  renameSync(from: string, to: string): void;
  openSync(path: string, flags: string, mode?: number): number;
  writeFileSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string, opts: { recursive: true }): unknown;
}

export type StoreRead =
  | { kind: "ok"; value: unknown }
  | { kind: "absent" }
  | { kind: "unreadable"; process: boolean; error: string; corrupt?: boolean; movedTo?: string | null };

/** Errors of the process, not of the file. */
const PROCESS_LEVEL = new Set(["EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "EINTR"]);

export function readStore(fs: StoreFs, path: string, at = Date.now()): StoreRead {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", process: PROCESS_LEVEL.has(code), error: String((e as Error).message ?? e) };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) as unknown };
  } catch (e) {
    const to = `${path}.corrupt-${new Date(at).toISOString().replace(/[:.]/g, "-")}`;
    let movedTo: string | null = to;
    try { fs.renameSync(path, to); } catch { movedTo = null; }
    return { kind: "unreadable", process: false, corrupt: true, movedTo, error: String((e as Error).message) };
  }
}

export function writeStore(fs: StoreFs, path: string, value: unknown, opts: { mode?: number; space?: number } = {}): void {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = cut > 0 ? path.slice(0, cut) : ".";
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  fs.mkdirSync(dir, { recursive: true });
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
  const tmp = `${dir}/.${base}.${pid}.${Date.now().toString(36)}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", opts.mode ?? 0o666);
    fs.writeFileSync(fd, JSON.stringify(value, null, opts.space));
    try { fs.fsyncSync(fd); } catch { /* a filesystem that cannot fsync still gets the rename */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}
