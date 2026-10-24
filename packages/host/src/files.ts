/**
 * Per-worktree file transport: the image/document inbox (phone → repo) and
 * artifact browse (repo → phone). Ported from the Python coding_drop_server,
 * with the same `.claude/inbox` / `.claude/outbox` conventions.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

import { secretAt } from "./git.js";
import { contained, containedReal } from "./paths.js";

export const INBOX_SUBDIR = ".claude/inbox";
export const OUTBOX_SUBDIR = ".claude/outbox";
/**
 * Outbox locations the gallery's "outbox" tab scans (repo→phone artifacts).
 * Agents don't all use the same convention — `.claude/outbox` is ours, but some
 * repos drop into a top-level `.outbox`. Scan all that exist.
 */
export const OUTBOX_SUBDIRS = [".claude/outbox", ".outbox"];

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif", ".svg", ".avif", ".tif", ".tiff", ".ico", ".jfif"]);
// Playable video — served with byte-range support (api.ts) so <video> can seek.
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"]);
const DOC_EXT = new Set([
  ".pdf", ".md", ".txt", ".csv", ".json", ".log", ".html",
  // Build deliverables — so a build's output (below) is downloadable via the
  // artifact endpoint. Anything past STREAM_MIN is served straight off disk
  // (api.ts `serveFileStream`), so a 300 MB APK is never a 300 MB Buffer — and a
  // resumed download re-requests ranges of it without re-reading the whole file.
  ".apk", ".aab", ".ipa", ".zip", ".jar", ".dmg", ".exe", ".deb", ".rpm",
  ".tar", ".gz", ".tgz", ".msi", ".pkg", ".whl", ".appimage",
  // Garmin Connect IQ: .iq is the store package, .prg the sideload build.
  ".iq", ".prg",
  // A VS Code extension package — builds.ts detects it as a run's output.
  ".vsix",
  // Office / productivity documents. The inbox is a phone→repo transport, and a
  // phone shares a PDF, a spreadsheet or an exported doc as readily as a photo;
  // refusing to serve those back is the app forgetting its own upload.
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".rtf", ".pages", ".numbers", ".key", ".epub", ".mobi", ".azw3", ".djvu",
  // Documents-as-data an agent or a phone actually hands over as a deliverable.
  ".tsv", ".srt", ".vtt", ".ics", ".eml", ".markdown", ".mdx", ".rst", ".tex",
  // Audio — a voice memo is a legitimate thing to hand an agent.
  ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".aiff", ".caf", ".amr",
  // Archives / binaries / fonts / CAD-ish payloads.
  ".7z", ".bz2", ".xz", ".zst", ".iso", ".bin", ".hex", ".uf2", ".img",
  ".fit", ".gpx", ".kml", ".kmz", ".stl", ".3mf", ".obj", ".step", ".stp", ".dxf",
  ".psd", ".ai", ".sketch", ".fig", ".ttf", ".otf", ".woff", ".woff2",
]);
/**
 * Extensions that may be SERVED but are deliberately NOT discovered.
 *
 * The phone can attach any kind of file now, so a `.ts`, a `.yaml` or a `.patch`
 * in the inbox has to come back down. They stay out of DOC_EXT because
 * `discoverArtifacts` walks the whole worktree for the gallery's "this repo"
 * tab and for the per-turn new-file scans: put source and config extensions in
 * the discovery set and every repo's own `src/` floods the grid and the
 * artifact notifications. Discovery = deliverables; serving = anything the
 * transport can legitimately be asked for.
 */
const SERVE_ONLY_EXT = new Set([
  ".xml", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg", ".properties", ".plist",
  ".diff", ".patch", ".sql", ".ndjson", ".jsonl", ".jsonc", ".bib",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
  ".php", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".gradle", ".dart",
  ".lua", ".scala", ".pl", ".r", ".jl", ".vue", ".svelte", ".css", ".scss",
]);

/**
 * Files the PHONE paints in place rather than downloading.
 *
 * The web viewer's list (`web/src/docKind.ts`, `isText` + `isPdf`) — kept here
 * as its own set on purpose: this decides what an alert SAYS ("tap to read"
 * vs "tap to download"), and an alert that promises a reader for a `.zip` is
 * worse than one that promises nothing. Nothing enforces that the two lists
 * agree, so widen them together — a file the phone opens but the alert calls a
 * download is a tap people won't make.
 */
const READS_INLINE = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".log", ".csv", ".json",
  ".yaml", ".yml", ".toml", ".ini", ".diff", ".patch", ".sh", ".html", ".htm", ".pdf",
]);

/** Whether the phone can show this file without downloading it first. */
export function readsInline(relPath: string): boolean {
  return READS_INLINE.has(extname(relPath).toLowerCase());
}

/** Everything the gallery DISCOVERS (walks the tree for). */
const DISCOVERABLE = new Set([...IMAGE_EXT, ...VIDEO_EXT, ...DOC_EXT]);
/** Everything the transport routes may SERVE. */
const VIEWABLE = new Set([...DISCOVERABLE, ...SERVE_ONLY_EXT]);

/** Options shared by the two serve-gate readers. */
export interface TreeReadOpts {
  /**
   * Serve ANY extension, not just VIEWABLE. Passed by the inbox route only:
   * an inbox file is there because THIS app uploaded it, so gating it on an
   * extension list would mean accepting an upload and then refusing to hand it
   * back (the file picker takes every kind of document). The artifact route
   * takes a caller-supplied path anywhere in the worktree and keeps the list.
   */
  anyType?: boolean;
}

/**
 * May this path be served out of the tree? A dotenv file never is — same
 * promise `git.ts` `readTextFile` makes, and the one the secret sheet relies on
 * (it writes these and swears they can't come back). Not a security boundary:
 * a `claude` session in the repo can read anything.
 */
function serveable(wt: string, full: string, relPath: string, opts: TreeReadOpts): boolean {
  if (secretAt(wt, relPath, full)) return false;
  if (opts.anyType) return true;
  return VIEWABLE.has(extname(full).toLowerCase());
}

export type ArtifactKind = "all" | "image" | "doc" | "strip";

/** Markdown — the one document kind a session's new-files strip also shows. */
const MD_EXT = new Set([".md", ".markdown", ".mdx"]);
export function isMarkdownPath(relPath: string): boolean { return MD_EXT.has(extname(relPath).toLowerCase()); }

/** Extensions in scope for a given type filter. The "image" (visual media) tab
 *  also covers video — both render inline in the gallery. */
function kindExt(kind?: ArtifactKind, scope?: "repo" | "outbox"): Set<string> {
  if (kind === "image") return new Set([...IMAGE_EXT, ...VIDEO_EXT]);
  // A turn's strip: the pictures plus markdown, in ONE walk (a second repo-wide
  // walk per turn end is what froze the host on WSL).
  if (kind === "strip") return new Set([...IMAGE_EXT, ...VIDEO_EXT, ...MD_EXT]);
  // The outbox is a curated, phone-facing drop — a handful of files an agent
  // put there on purpose, so a `.yaml` report belongs in the list. A whole-repo
  // walk is the opposite, and gets the deliverables-only set.
  const docs = scope === "outbox" ? new Set([...DOC_EXT, ...SERVE_ONLY_EXT]) : DOC_EXT;
  if (kind === "doc") return docs;
  return new Set([...IMAGE_EXT, ...VIDEO_EXT, ...docs]);
}

/** MIME types Gemini vision accepts. Others (svg/bmp/gif) are skipped. */
const VISION_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif",
};

export interface InlineImage {
  name: string;
  relPath: string;
  mime: string;
  /** base64-encoded bytes. */
  dataB64: string;
  mtime: number;
}

/**
 * Read the most recent images from the inbox + outbox for vision context (a
 * plugin's `api.inlineImages`). Capped by count and total bytes so
 * we never blow up the request. Newest first.
 */
export function readInlineImages(
  worktree: string,
  opts: { max?: number; maxBytes?: number } = {},
): InlineImage[] {
  const max = opts.max ?? 4;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const candidates: FileEntry[] = [
    ...listInbox(worktree).filter((f) => VISION_MIME[extname(f.name).toLowerCase()]),
    ...discoverArtifacts(worktree, { scope: "outbox", kind: "image", limit: 50 }).files,
  ].filter((f) => VISION_MIME[extname(f.name).toLowerCase()]);

  // De-dup by relPath, newest first.
  const seen = new Set<string>();
  const ordered = candidates
    .filter((f) => (seen.has(f.relPath) ? false : (seen.add(f.relPath), true)))
    .sort((a, b) => b.mtime - a.mtime);

  const out: InlineImage[] = [];
  let total = 0;
  for (const f of ordered) {
    if (out.length >= max) break;
    const buf = readInTree(worktree, f.relPath);
    if (!buf || total + buf.length > maxBytes) continue;
    total += buf.length;
    out.push({
      name: f.name,
      relPath: f.relPath,
      mime: VISION_MIME[extname(f.name).toLowerCase()],
      dataB64: buf.toString("base64"),
      mtime: f.mtime,
    });
  }
  return out;
}

// Dirs never worth scanning for artifacts.
/** Directories no walk descends into. Exported because `tree.ts`'s recursive
 *  name search wants the same answer — a phone looking for `api.ts` never means
 *  the fifty copies under `node_modules`. (The lazy per-directory listing
 *  SHOWS these; it just never walks them.) */
export const SKIP_DIRS = new Set([".git", "node_modules", "build", "dist", ".dart_tool", "__pycache__", ".venv", "venv", ".next", "target"]);

/**
 * Where agent worktrees live inside a repo (`EnterWorktree`, the Agent tool's
 * `isolation: "worktree"`, peer jobs). Each one is a FULL checkout of the
 * repo, so a repo-scope walk that descends into it finds every committed image
 * again under a new path: one new worktree read as ~60 "new images" in the
 * session strip, and once the worktree was merged and removed every one of
 * those thumbs was a 404. A worktree is its own target in `repos.ts`; its
 * files are never this tree's.
 */
export const NESTED_WORKTREES = ".claude/worktrees";

export interface FileEntry {
  name: string;
  /** Worktree-relative path (forward slashes) — what the agent references. */
  relPath: string;
  size: number;
  mtime: number;
  /** Creation time (ms). Falls back to mtime where the FS reports no birthtime. */
  ctime: number;
  /** Set when a `dedupe` upload matched a file already on disk — nothing was
   *  written. Only the host log reads it; the answer to the phone is the same
   *  either way (that is the point of the dedupe). */
  deduped?: boolean;
}

/** Birth (creation) time in ms, falling back to mtime when the FS reports 0. */
function birthMs(st: { birthtimeMs: number; mtimeMs: number }): number {
  return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
}

function inboxDir(worktree: string, subdir = INBOX_SUBDIR): string {
  return join(worktree, ...subdir.split("/"));
}

/** The transport dir to actually touch: `null` when `.claude/inbox` (or the
 *  outbox) is a link that resolves outside the worktree — a cloned repo can
 *  commit `.claude/inbox -> ~/.ssh`. An in-repo link, or no dir yet, is fine. */
function transportDir(worktree: string, subdir = INBOX_SUBDIR): string | null {
  return containedReal(worktree, subdir);
}

const NOT_PLAIN_INBOX = "inbox is not a plain folder in this repo";

/** Reject names that try to escape the inbox. */
function safeName(name: string): string | null {
  const base = name.replace(/[/\\]/g, "_").trim();
  if (!base || base === "." || base === "..") return null;
  return base;
}

/** Like existsSync but a DANGLING symlink counts as taken: writing to that name would follow it. */
function taken(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

function ensureUnique(dir: string, name: string): string {
  if (!taken(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 10000; i++) {
    const cand = `${stem}_${i}${ext}`;
    if (!taken(join(dir, cand))) return cand;
  }
  return `${stem}_${Date.now()}${ext}`;
}

/**
 * Write an uploaded file into the repo inbox.
 *
 * `dedupe` is what makes a RETRY safe. The phone's send queue can re-POST an
 * image (a tunnel that dropped mid-upload, a tab killed before the response
 * landed), and there is no ackId ledger on this path — so without it, the same
 * photo lands twice under `name` and `name_2`. The client names a queued upload
 * with a random suffix precisely so the name identifies THAT upload, which makes
 * "same name, same byte count already on disk" a reliable re-send rather than a
 * collision. Absent (every interactive upload) ⇒ the old always-uniquify path.
 */
export function saveInboxFile(
  worktree: string,
  originalName: string,
  data: Buffer,
  opts: { dedupe?: boolean } = {},
): FileEntry | { error: string } {
  const safe = safeName(originalName);
  if (!safe) return { error: "invalid filename" };
  const dir = transportDir(worktree);
  if (dir === null) return { error: NOT_PLAIN_INBOX };
  mkdirSync(dir, { recursive: true });
  if (opts.dedupe) {
    const existing = join(dir, safe);
    try {
      const st = statSync(existing);
      if (st.isFile() && st.size === data.length) {
        return { name: safe, relPath: `${INBOX_SUBDIR}/${safe}`, size: st.size, mtime: st.mtimeMs, ctime: birthMs(st), deduped: true };
      }
    } catch { /* not there — fall through and write it */ }
  }
  // "wx" = O_EXCL: refuses ANY existing path, a dangling symlink included, so
  // the write can never follow a link out of the inbox. A lost race (EEXIST)
  // picks the next free name; bounded.
  let name = "";
  let full = "";
  for (let attempt = 0; ; attempt++) {
    name = ensureUnique(dir, safe);
    full = join(dir, name);
    try { writeFileSync(full, data, { flag: "wx" }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 20) return { error: "could not save the upload" };
    }
  }
  let mtime = Date.now(), ctime = mtime;
  try { const st = statSync(full); mtime = st.mtimeMs; ctime = birthMs(st); } catch { /* keep defaults */ }
  return { name, relPath: `${INBOX_SUBDIR}/${name}`, size: data.length, mtime, ctime };
}

/** Allocate a unique path inside the repo's outbox for a host-produced file
 *  (e.g. a screenshot). Creates the dir; returns the absolute + relative paths. */
export function newOutboxPath(
  worktree: string,
  prefix: string,
  ext: string,
): { full: string; relPath: string; name: string } {
  const dir = transportDir(worktree, OUTBOX_SUBDIR);
  // Throws: every caller already wraps this (capture run, peer save, route) and degrades to a refusal.
  if (dir === null) throw new Error("outbox is not a plain folder in this repo");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
  const name = ensureUnique(dir, `${prefix}-${stamp}${ext}`);
  return { full: join(dir, name), relPath: `${OUTBOX_SUBDIR}/${name}`, name };
}

// Marker whose mtime = when the user last opened this box. Unread = files newer
// than it, so a badge stops climbing forever and resets to 0 once you look.
// Hidden file → skipped by the inbox listing, and by the outbox walk (its
// extension is not viewable).
const SEEN_MARKER = ".seen";

export function listInbox(worktree: string): FileEntry[] {
  const dir = transportDir(worktree);
  if (dir === null || !existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      if (name.startsWith(".")) return null; // skip the .seen marker + dotfiles
      try {
        const st = statSync(join(dir, name));
        if (!st.isFile()) return null;
        return { name, relPath: `${INBOX_SUBDIR}/${name}`, size: st.size, mtime: st.mtimeMs, ctime: birthMs(st) };
      } catch {
        return null;
      }
    })
    .filter((x): x is FileEntry => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
}

/** Count outbox artifacts dropped since the user last opened this repo's outbox.
 *  The badge on a repo answers "is there something for me to LOOK at" — that is
 *  the agent's drop zone, not the inbox (the inbox is what this phone uploaded,
 *  which it already knows about). Counted through `discoverArtifacts` so the
 *  number is exactly what the outbox tab will list, dotfiles and non-viewable
 *  extensions included/excluded the same way. */
export function countOutbox(worktree: string): number {
  const marks = new Map<string, number>();
  for (const sub of OUTBOX_SUBDIRS) {
    const dir = transportDir(worktree, sub);
    if (dir === null || !existsSync(dir)) continue;
    let seenAt = 0;
    try { seenAt = statSync(join(dir, SEEN_MARKER)).mtimeMs; } catch { /* never opened */ }
    marks.set(sub, seenAt);
  }
  if (!marks.size) return 0;
  const { files } = discoverArtifacts(worktree, { scope: "outbox", limit: 1000 });
  return files.filter((f) => {
    const sub = OUTBOX_SUBDIRS.find((x) => f.relPath.startsWith(x + "/"));
    return sub !== undefined && f.mtime > (marks.get(sub) ?? 0);
  }).length;
}

/**
 * The instant `countOutbox` measured against: the OLDEST of the per-subdir
 * marks.
 *
 * Oldest and not newest, deliberately — the count asks `mtime > marks[itsSub]`
 * per subdirectory, so a single boundary can only be safe in one direction. The
 * oldest mark admits everything the badge counted (and at worst a little more);
 * the newest could hide a file the badge promised. A number that opens a list
 * missing one of its own rows is the failure this whole field exists to stop.
 */
export function outboxSeenAt(worktree: string): number | undefined {
  let oldest: number | undefined;
  for (const sub of OUTBOX_SUBDIRS) {
    const dir = transportDir(worktree, sub);
    if (dir === null || !existsSync(dir)) continue;
    let seenAt = 0;
    try { seenAt = statSync(join(dir, SEEN_MARKER)).mtimeMs; } catch { /* never opened */ }
    oldest = oldest === undefined ? seenAt : Math.min(oldest, seenAt);
  }
  return oldest;
}

/** Stamp this repo's outbox as seen — zeroes the unread badge until the next drop. */
export function markOutboxSeen(worktree: string): void {
  for (const sub of OUTBOX_SUBDIRS) {
    const dir = transportDir(worktree, sub);
    if (dir === null || !existsSync(dir)) continue; // no dir ⇒ nothing to count ⇒ nothing to stamp
    try { writeFileSync(join(dir, SEEN_MARKER), ""); } catch { /* best-effort */ }
  }
}

/** Stamp this repo's inbox as seen — zeroes the unread badge until new uploads. */
export function markInboxSeen(worktree: string): void {
  const dir = transportDir(worktree);
  if (dir === null) return;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SEEN_MARKER), "");
  } catch { /* best-effort */ }
}

export function deleteInboxFile(worktree: string, name: string): boolean {
  const safe = safeName(name);
  if (!safe) return false;
  const dir = transportDir(worktree);
  if (dir === null) return false;
  const full = join(dir, safe);
  if (!existsSync(full)) return false;
  try {
    rmSync(full);
    return true;
  } catch {
    return false;
  }
}

/** Delete a phone-facing artifact by worktree-relative path. Restricted to the
 *  inbox + outbox dirs so the phone can't delete arbitrary repo files — those
 *  are the only locations the gallery offers a delete for. */
export function deleteArtifact(worktree: string, relPath: string): boolean {
  const rel = relPath.replace(/\\/g, "/");
  const allowedRoots = [INBOX_SUBDIR, ...OUTBOX_SUBDIRS];
  // `containedReal`: a committed `.claude/outbox/evildir -> /` must not let a
  // delete under it unlink a file outside the tree.
  const full = containedReal(worktree, rel);
  if (full === null) return false; // escape guard
  // The "inbox or outbox only" test is made on the RESOLVED path, never on the
  // string the client sent. Asked of the string, `.claude/inbox/../../src/x.ts`
  // starts with the inbox and deletes a source file: `contained` refuses an
  // escape from the WORKTREE, and that path never leaves it. Resolving first
  // spends the traversal before the comparison, so a path cannot spell its way
  // back out of the two directories the gallery offers a delete for.
  const inside = allowedRoots.some((r) => {
    const root = resolve(worktree, ...r.split("/"));
    return full === root || full.startsWith(root + sep);
  });
  if (!inside) return false;
  try {
    if (!existsSync(full) || !statSync(full).isFile()) return false;
    rmSync(full);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a worktree-relative path, refusing anything that escapes the tree. */
export function resolveInTree(worktree: string, relPath: string): string | null {
  const full = containedReal(worktree, relPath);
  if (full === null) return null;
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

/**
 * Stat a serveable file without reading it. This is what lets the artifact route
 * STREAM a big deliverable instead of buffering it: `readInTree` pulls the whole
 * file into memory, which is fine for a screenshot and wrong for a 300 MB APK —
 * and a resumable download re-requests ranges of that same file, so the buffered
 * path would re-read all of it per range. Same viewability gate as readInTree,
 * so nothing becomes serveable that wasn't.
 */
export function statInTree(
  worktree: string,
  relPath: string,
  opts: TreeReadOpts = {},
): { full: string; size: number; mtime: number } | null {
  const full = resolveInTree(worktree, relPath);
  if (!full) return null;
  if (!serveable(worktree, full, relPath, opts)) return null;
  try {
    const st = statSync(full);
    return { full, size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export function readInTree(worktree: string, relPath: string, opts: TreeReadOpts = {}): Buffer | null {
  const full = resolveInTree(worktree, relPath);
  if (!full) return null;
  if (!serveable(worktree, full, relPath, opts)) return null;
  try {
    return readFileSync(full);
  } catch {
    return null;
  }
}

/**
 * Walk a worktree (or just the outbox) for viewable artifacts, newest first.
 * `scope`: "outbox" = the outbox dirs in OUTBOX_SUBDIRS (.claude/outbox + .outbox),
 * else the whole tree minus SKIP_DIRS and the inbox.
 */
export function discoverArtifacts(
  worktree: string,
  opts: {
    scope?: "repo" | "outbox";
    sinceSeconds?: number;
    limit?: number;
    /** Case-insensitive substring matched against the file name (extension included). */
    query?: string;
    /** Restrict to images, documents, or both. */
    kind?: ArtifactKind;
    /** Include the .claude/inbox dir in a "repo" scope walk (search wants it). */
    includeInbox?: boolean;
  } = {},
): { files: FileEntry[]; truncated: boolean } {
  const scope = opts.scope ?? "repo";
  const limit = Math.min(opts.limit ?? 300, 1000);
  const cutoff = opts.sinceSeconds ? Date.now() - opts.sinceSeconds * 1000 : 0;
  const allow = kindExt(opts.kind, scope);
  const q = opts.query?.trim().toLowerCase() || "";
  const root = resolve(worktree);
  // Outbox can live in more than one place; seed the walk with every variant
  // that exists. Repo scope just starts at the worktree root.
  const starts = scope === "outbox"
    ? OUTBOX_SUBDIRS.map((sub) => transportDir(worktree, sub)).filter((d): d is string => d !== null && existsSync(d))
    : (existsSync(root) ? [root] : []);
  if (!starts.length) return { files: [], truncated: false };

  const out: FileEntry[] = [];
  const stack = [...starts];
  const inboxFull = inboxDir(worktree);
  const nestedFull = join(root, NESTED_WORKTREES);
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        // A link that leaves the worktree is neither walked nor listed: a committed
        // `docs/home -> ~` would otherwise list every picture under the home directory.
        if (lstatSync(full).isSymbolicLink() && containedReal(root, relative(root, full)) === null) continue;
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (scope === "repo" && !opts.includeInbox && full === inboxFull) continue; // inbox is phone→repo
        if (full === nestedFull) continue; // other checkouts, not this tree's files
        stack.push(full);
      } else if (st.isFile() && allow.has(extname(name).toLowerCase())) {
        if (cutoff && st.mtimeMs < cutoff) continue;
        if (q && !name.toLowerCase().includes(q)) continue;
        out.push({ name, relPath: relative(root, full).split(sep).join("/"), size: st.size, mtime: st.mtimeMs, ctime: birthMs(st) });
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const truncated = out.length > limit;
  return { files: out.slice(0, limit), truncated };
}

/**
 * `discoverArtifacts` without holding the event loop: the same walk, the same filters, the same
 * answer — for every REPO-scope caller (the cross-repo search, a session's image and auto-pull
 * baselines). The sync walk `stat`s every entry of the whole tree in one go; on WSL reading a
 * Windows drive (9P, ~20 ms a call, far worse while `git status` runs) one search over 36 repos
 * froze the host for minutes. Here an entry's kind comes from the directory listing and only a
 * symlink or a file the filter wants is `stat`ed, every call awaited.
 */
export async function discoverArtifactsAsync(
  worktree: string,
  opts: Parameters<typeof discoverArtifacts>[1] = {},
): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const scope = opts.scope ?? "repo";
  const limit = Math.min(opts.limit ?? 300, 1000);
  const cutoff = opts.sinceSeconds ? Date.now() - opts.sinceSeconds * 1000 : 0;
  const allow = kindExt(opts.kind, scope);
  const q = opts.query?.trim().toLowerCase() || "";
  const root = resolve(worktree);
  const starts = scope === "outbox"
    ? OUTBOX_SUBDIRS.map((sub) => transportDir(worktree, sub)).filter((d): d is string => d !== null && existsSync(d))
    : (existsSync(root) ? [root] : []);
  if (!starts.length) return { files: [], truncated: false };

  const out: FileEntry[] = [];
  const stack = [...starts];
  const inboxFull = inboxDir(worktree);
  const nestedFull = join(root, NESTED_WORKTREES);
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdirAsync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const name = e.name;
      const full = join(dir, name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        // Followed like the sync walk — only while its target stays in the worktree.
        if (containedReal(root, relative(root, full)) === null) continue;
        try { const st = await statAsync(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
      }
      if (isDir) {
        if (SKIP_DIRS.has(name)) continue;
        if (scope === "repo" && !opts.includeInbox && full === inboxFull) continue;
        if (full === nestedFull) continue;
        stack.push(full);
      } else if (isFile && allow.has(extname(name).toLowerCase())) {
        if (q && !name.toLowerCase().includes(q)) continue;
        let st;
        try { st = await statAsync(full); } catch { continue; }
        if (cutoff && st.mtimeMs < cutoff) continue;
        out.push({ name, relPath: relative(root, full).split(sep).join("/"), size: st.size, mtime: st.mtimeMs, ctime: birthMs(st) });
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  const truncated = out.length > limit;
  return { files: out.slice(0, limit), truncated };
}

/**
 * Every file in a transport directory — **not** the gallery's viewable subset.
 *
 * `discoverArtifacts` answers "what can the phone PAINT", and filters by
 * extension for that reason. A cleanup is asking the opposite question: what is
 * taking up room in here. Measured on this desktop, transport directories hold
 * `.zip`, `.txt`, `.json`, `.log` and a `.tar.gz` or two — none of them
 * `DISCOVERABLE`, all of them bytes. A sweep that offered only the paintable
 * files would report a directory clean while leaving most of it on disk, which
 * is the one lie this feature could tell that costs real space.
 *
 * Dotfiles stay out (the `.seen` marker is this app's own bookkeeping and
 * deleting it would silently un-read every artifact in the repo). Directories
 * are walked, because agents do nest output.
 *
 * Returns `FileEntry` rows, which are structurally `SweepRow` — nothing
 * converts on the way to `shared/sweep.ts`.
 */
export function listTransport(worktree: string, scope: "outbox" | "inbox"): FileEntry[] {
  const subs = scope === "inbox" ? [INBOX_SUBDIR] : OUTBOX_SUBDIRS;
  const root = resolve(worktree);
  const out: FileEntry[] = [];
  const stack = subs.map((sub) => transportDir(worktree, sub)).filter((d): d is string => d !== null && existsSync(d));
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;   // `.seen`, and anything else hidden
      const full = join(dir, name);
      let st;
      // `lstat` FIRST, and a symlink is never followed here.
      //
      // `deleteArtifact`'s containment is lexical once a path is resolved, so a
      // symlinked directory planted inside an outbox would be walked, its
      // targets listed, and a bulk sweep would unlink files outside the
      // worktree. Planting one already requires code execution on this machine
      // — which `DISCLAIMER.md` §1 owns — but a sweep turns that into a bulk
      // delete, and "the gallery shows it" is a far weaker act than "the
      // cleanup removed it". A symlink is skipped rather than reported, because
      // a row somebody cannot delete is a row that reads as a failure.
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(full);
      } else if (st.isFile()) {
        out.push({
          name,
          relPath: relative(root, full).split(sep).join("/"),
          size: st.size,
          mtime: st.mtimeMs,
          ctime: birthMs(st),
        });
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** What `sweepTransport` did. Structurally `shared/sweep.ts`'s `SweepResult`,
 *  which owns the sentence — the host does not word this twice. */
export interface SweepOutcome {
  deleted: number;
  bytes: number;
  missing: string[];
  failed: string[];
}

/**
 * Delete exactly the paths the caller was shown.
 *
 * **The list is the contract, never an age** (`shared/sweep.ts` states why at
 * length): a person approved a set of rows, and re-deriving that set here would
 * mean deleting files that were never on their screen. So this takes paths, and
 * the only judgement it makes is per-path containment.
 *
 * **Containment is `deleteArtifact`'s, unchanged.** Every removal goes through
 * the one guarded delete this daemon has — resolved path, inbox-or-outbox only,
 * files only. A second `rmSync` here would be a second place to get the
 * traversal check wrong, and this one is reached over HTTP with a
 * client-supplied list of paths, which is exactly the shape that guard exists
 * for.
 *
 * The size is read BEFORE the unlink, or the byte total this reports is zero.
 */
export function sweepTransport(worktree: string, relPaths: readonly string[]): SweepOutcome {
  const res: SweepOutcome = { deleted: 0, bytes: 0, missing: [], failed: [] };
  for (const rel of relPaths) {
    // `contained` and NOT `resolveInTree`: that one folds "escapes the tree"
    // and "is not there" into the same null, and those are the two outcomes
    // this function exists to tell apart. A path that left the worktree is a
    // refusal; a path that is simply gone is the sweep succeeding by another
    // route (an agent cleaned up first), and reporting it as a failure teaches
    // the reader to distrust a clean run — `shared/sweep.ts`'s rule.
    let size = 0;
    const full = contained(worktree, rel);
    if (full === null) { res.failed.push(rel); continue; }
    if (!existsSync(full)) { res.missing.push(rel); continue; }
    try { size = statSync(full).size; } catch { /* deleted under us — the unlink decides */ }
    if (deleteArtifact(worktree, rel)) {
      res.deleted++;
      res.bytes += size;
    } else {
      // Either the guard refused it (outside the two transport dirs) or the
      // unlink failed. Both are "still on disk", which is the fact the reader
      // needs; which of the two it was is the host log's business.
      res.failed.push(rel);
    }
  }
  return res;
}
