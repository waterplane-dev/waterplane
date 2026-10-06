export interface FileEntry {
  name: string;
  relPath: string;
  size: number;
  mtime: number;
  /** Creation time (ms). Falls back to mtime where the FS reports no birthtime. */
  ctime: number;
}

export type ArtifactKind = "all" | "image" | "doc";

/** ── Tree browse + edit (host `tree.ts`) ──────────────────────────────
 *  The gallery lists DELIVERABLES; this lists what is actually in the repo,
 *  one directory at a time. Mirrors the host's `TreeEntry`/`TreeFile`. */
export interface TreeEntry {
  name: string;
  /** Worktree-relative, forward slashes. */
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  /** Directories: entries inside. Absent for heavy dirs (node_modules & co). */
  count?: number;
  /** Git porcelain code at or under this path. Absent = clean. */
  status?: string;
  ignored?: boolean;
  link?: boolean;
}

export interface TreeListing {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
  /** Set when this was a name search rather than a directory listing. */
  query?: string;
}

export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
  body?: string;
  /** The base a save must present. Absent whenever `body` is not the whole
   *  file — which is exactly what makes a binary or truncated file un-savable. */
  sha?: string;
  binary?: boolean;
  truncated?: boolean;
  editable: boolean;
}

export type TreeWriteResult =
  | { ok: true; sha: string; mtime: number; size: number }
  | { ok: false; error: string; code: "stale" | "missing" | "refused" | "toobig" | "failed"; sha?: string };

/** A cross-repo search result: a FileEntry tagged with its owning repo. */
export interface SearchHit extends FileEntry {
  repoId: string;
  repoName: string;
  branch: string;
}

export interface SlashCommand {
  name: string;
  source: "builtin" | "project" | "user";
  description?: string;
}

export interface EnvFileInfo {
  name: string;
  gitignored: boolean;
  tracked: boolean;
  template: boolean;
}

export interface SecretResult {
  ok: boolean;
  key?: string;
  file?: string;
  action?: "created" | "replaced";
  masked?: string;
  gitignored?: boolean;
  addedToGitignore?: boolean;
  error?: string;
}

/** A host-side write-only target the phone may write to but never read back. */
export interface WriteTarget {
  id: string;
  label: string;
  /** "dotenv" = KEY=value splice; "json" = whole-file raw JSON string. */
  mode: "dotenv" | "json";
  /** Absolute path on the host (shown for confirmation; not a secret). */
  path: string;
  /** This target hot-reloads process.env (the built-in env target). */
  hotReload?: boolean;
}



/**
 * An upload rejection that carries whether retrying could ever help.
 * `permanent` = the host will answer the same way next time (413/415), so the
 * queue entry is failed rather than retried into its attempts cap.
 */
/**
 * `permanent` — the host gave a verdict that a retry cannot change (413/415).
 * `responded` — the host ANSWERED AT ALL. That is what decides whether a
 * failed attempt should count against `MAX_SEND_ATTEMPTS`: a status means the
 * message was heard and rejected, while a transport error (host mid-restart,
 * the tunnel dropping, the WS still reading "open" because its close event has
 * not landed yet) decided nothing. Counting those spends the give-up budget on
 * the link, which is precisely the condition the queue exists to ride out —
 * eight attempts on the 5 s sweep is under a minute, so a host restart could
 * kill an image outright.
 */
export interface UploadError extends Error { permanent?: boolean; responded?: boolean }

export interface SpeedResult {
  bytes: number;
  /** Client-measured wall time (ms). */
  ms: number;
  /** Throughput in megabits/s from the client's perspective. */
  mbps: number;
  /** Upload only: server-side receive time (first→last byte), a cleaner number. */
  serverMs?: number;
}

export type PathKind = "tailscale" | "lan" | "loopback" | "public" | "unknown";

/** Connection diagnostics returned by /api/speedtest/debug. */
export interface SpeedDebug {
  clientIp: string;
  clientKind: PathKind;
  dialedHost: string;
  overTailscale: boolean;
  lanIps: string[];
  tailscaleIp: string | null;
  tailscaleCli: boolean;
  route: "direct" | "derp" | "unknown";
  derpRegion: string | null;
  raw: { ping?: string; netcheck?: string; status?: string };
  verdict: string;
}
