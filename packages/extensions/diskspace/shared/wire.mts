/**
 * The disk-space extension's wire: what the phone may ask the host half, typed once for both ends.
 * Pure, no node imports — the host compiles it (`tsconfig.extensions.json`), the phone bundles it.
 *
 * Transport: the generic plugin channel on the one socket. Phone → host is `plugin.call`; host →
 * phone is ONE tiny push, `changed` (`{ at }`), after which the phone reads `state` again. The
 * state itself is never pushed: a scan's lists can pass the push cap, and a read is re-asked after a
 * reconnect anyway.
 *
 * The rule the whole contract is shaped around: **a deletion never takes a path from the phone.**
 * `remove` carries an opaque `id` from the last scan; the host recomputes that category's candidates
 * itself, finds the id there, and re-checks containment before anything is removed. A show-only
 * entry and a large file have no id a `remove` accepts — there is no delete path for them at all.
 */

/** temp: regenerable, deletable · model: deletable, re-downloadable · show: sizes only. */
export type DiskKind = "temp" | "model" | "show";

/**
 * Which desktop the host runs on. `wsl` is Linux inside Windows' WSL: two disks matter there — the
 * Linux side (inside WSL's virtual disk) and the Windows drive that virtual disk is a file on.
 */
export type DiskProfile = "mac" | "linux" | "wsl";

/**
 * Which disk a row's bytes are on, set only on `wsl`: `wsl` = inside WSL's virtual disk (deleting
 * frees space there; the Windows drive gets it back only after that disk is compacted), `windows` =
 * on the Windows drive itself. Absent on mac and plain Linux, where there is one disk.
 */
export type DiskSide = "wsl" | "windows";

export interface DiskEntry {
  /** Opaque: `<category>:<16 hex>`. Only a temp/model id is ever accepted by `remove`. */
  id: string;
  kind: DiskKind;
  /** Which family it is in ("Gradle", "browser caches", "build output", "Hugging Face", …). */
  group: string;
  /** What the row is called: a `~` path, `org/name`, an ollama tag. */
  label: string;
  /** KiB as `du -sk` measured it; null = could not be measured (never 0 for that). */
  sizeKb: number | null;
  /** Why the size is unknown, or why it is a floor ("some files were unreadable — at least this"). */
  sizeNote?: string;
  /** True when `sizeKb` is a floor: du finished but complained. */
  partial?: boolean;
  /** temp/model: what puts it back if it is needed again. show: how to free it by hand. */
  regen?: string;
  /** ms since epoch, when known. */
  mtime?: number | null;
  /** Anything else the row must say (a shared ollama id, how many folders a row stands for). */
  note?: string;
  /** Rows with the same value are ONE copy on disk (ollama tags sharing an ID): a total counts it once. */
  copy?: string;
  /** wsl only: which disk this row is on. */
  side?: DiskSide;
}

export interface DiskVolume {
  /** The path statfs was asked about (the home folder's volume). */
  path: string;
  freeKb: number;
  totalKb: number;
  /** What the disk is called when there are two ("C:", "inside WSL"); absent on mac and plain Linux. */
  label?: string;
}

export interface DiskScan {
  at: number;
  tookMs: number;
  /** The header disk: the home folder's volume on mac/linux, the Windows drive (C:) on wsl. */
  volume: DiskVolume | null;
  /** wsl only: the Linux side's own free space (inside WSL's virtual disk), the second line. */
  wslVolume?: DiskVolume | null;
  /** Absent from a host older than the field: read as `mac`. */
  profile?: DiskProfile;
  temp: DiskEntry[];
  models: DiskEntry[];
  show: DiskEntry[];
  /** Sentences about what the scan could not do (ollama did not answer, the walk stopped early). */
  notes: string[];
}

export interface LargeFile { path: string; sizeKb: number; mtime: number | null }

export interface LargeScan {
  at: number;
  running: boolean;
  tookMs: number | null;
  /** Set when the find was stopped by its time bound: the list is partial. */
  stoppedAfterS: number | null;
  /** How many matched in all (the list keeps the biggest LARGE_TOP). */
  found: number;
  items: LargeFile[];
  error?: string;
  /** What the find did not cover, as a sentence (on wsl: the Windows drive). */
  note?: string;
}

export interface DiskDeleteResult {
  id: string;
  label: string;
  at: number;
  ok: boolean;
  /** The size the last scan measured for it, null when unknown. */
  sizeKb: number | null;
  /** How far free space rose across the delete, on the disk the delete touched (`side`) — may differ from `sizeKb` (snapshots, other writers). */
  freeDeltaKb: number | null;
  error?: string;
  /** wsl only: which disk the delete touched, and so which disk `freeDeltaKb` was read on. */
  side?: DiskSide;
  /** A row of many entries deleted one by one (Windows temporary files): how many went. */
  removed?: number;
  /** …and how many were in use by a running program and left alone (never counted as freed). */
  skipped?: number;
  /** …of those skipped, how many were folders with a held file inside that were left partly cleared (what could be unlinked before the hold is gone). */
  partial?: number;
}

/**
 * The code-root walk (build output + node_modules), the slow part of a scan. It runs after the rest
 * of the scan has been measured and pushed, so those rows show while it runs. On wsl with the code
 * root on the Windows drive it is not part of the automatic scan at all (`onTap`): folders there are
 * slow to read from inside WSL, so it runs only when the person taps for it (`scanCode`).
 */
export interface CodeWalk {
  /** The code root as the person knows it (`~/dev`, `C:/dev`). */
  root: string;
  /** True: the walk is never started by a scan, only by `scanCode`. */
  onTap: boolean;
  /** Being looked for now, or next in this scan. */
  running: boolean;
  /** When the walk itself started; null while it waits for the rest of the scan. */
  startedAt: number | null;
  /** When the build output / node_modules rows now listed were looked for; null = not this host run. */
  at: number | null;
  tookMs: number | null;
  /** What the walk could not do (stopped early, folders not ignored by git, the biggest N). */
  notes: string[];
}

export interface DiskState {
  scanning: boolean;
  /** Which part of a running scan: `fast` = everything but the code root, `code` = the code-root walk. Absent from an older host. */
  phase?: "fast" | "code" | null;
  /** Absent from an older host. */
  code?: CodeWalk;
  scanStartedAt: number | null;
  scan: DiskScan | null;
  large: LargeScan | null;
  /** Deletes running or queued right now. */
  deleting: { id: string; label: string; since: number }[];
  /** Recent delete outcomes, newest first. */
  results: DiskDeleteResult[];
}

/** The time bound on the large-file find, in seconds. */
export const LARGE_LIMIT_S = 120;
/** How many large files are listed. */
export const LARGE_TOP = 50;
/** The only push: "read `state` again". */
export const PUSH_CHANGED = "changed";

/** What `remove` accepts, before anything else is looked at: a category and 16 hex, nothing path-shaped. */
export const CANDIDATE_ID_RE = /^(cache|build|tmp|hf|ollama|wcache|wtemp):[0-9a-f]{16}$/;

// A type alias, not an interface: it must satisfy PluginMethods' index signature.
export type DiskMethods = {
  state: { args: Record<string, never>; result: DiskState };
  /** Start a scan (joins one already running) and answer the state at once. */
  scan: { args: Record<string, never>; result: DiskState };
  /** Look for build output and node_modules under the code root now (joins a running scan; on wsl with the code root on the Windows drive, the only way it runs). */
  scanCode: { args: Record<string, never>; result: DiskState };
  /** Start the large-file find (joins one already running). */
  scanLarge: { args: Record<string, never>; result: DiskState };
  /** Queue one candidate's delete. Answers once it is ACCEPTED; the outcome arrives in `results`. */
  remove: { args: { id: string }; result: { accepted: true; label: string } };
  /** Queue every temporary candidate of the last scan. */
  cleanTemp: { args: Record<string, never>; result: { accepted: number } };
};
