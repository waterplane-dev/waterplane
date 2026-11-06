/**
 * The name a person gave a repo to be SHOWN instead of its folder's.
 *
 *  - **Display only.** Every id, path, API parameter, allow-list entry and stored key
 *    stays on the folder; this store changes what `RepoTarget.displayName` says and what a
 *    notification calls the repo, nothing else (`shared/repotwins.ts`).
 *  - **A host store, keyed by the clone's PRIMARY checkout (realpath)**, so every device
 *    agrees and every worktree of the clone carries the same name (`repos.ts`). Not a file
 *    written into the repo: it is this desktop's opinion about a directory.
 *  - **Nothing seeds it.** Absent means the folder name; only `set` from a person's tap
 *    writes here, and a name that cannot be cleaned is refused in words, stored as nothing.
 *  - **Unset is a silent no-op**, as `setupprefs.ts`: a test or a CLI with no store
 *    installed sees folder names.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { cleanRepoDisplayName, shownTitle, type RepoTarget } from "@waterplane/shared";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

const key = (primary: string): string => {
  try { return realpathSync(primary); } catch { return primary; }
};

export class RepoNamesStore {
  private path: string;
  private names: Record<string, string> = {};

  constructor(root: string) {
    this.path = join(hostStateDir(root), "repo-names.json");
    try {
      if (existsSync(this.path)) {
        const raw = readJsonGuarded<any>(this.path, null) as { names?: unknown } | null;
        if (raw?.names && typeof raw.names === "object" && !Array.isArray(raw.names)) {
          // Cleaned on the way IN too: a hand-edit must not put a multi-line name on a header.
          for (const [k, v] of Object.entries(raw.names as Record<string, unknown>)) {
            const c = cleanRepoDisplayName(v);
            if (c.ok && c.value) this.names[k] = c.value;
          }
        }
      }
    } catch { /* unreadable → folder names everywhere */ }
  }

  /** The name for the clone whose primary checkout is `primary`, or undefined. */
  of(primary: string): string | undefined {
    return this.names[primary] ?? this.names[key(primary)];
  }

  /** Store a name, or `null`/empty to go back to the folder's. Refuses in words and stores nothing for a bad one. */
  set(primary: string, raw: unknown): { ok: true; name: string | null } | { ok: false; error: string } {
    const c = cleanRepoDisplayName(raw);
    if (!c.ok) return c;
    const k = key(primary);
    delete this.names[primary];
    if (c.value) this.names[k] = c.value; else delete this.names[k];
    this.save();
    return { ok: true, name: c.value };
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, ".."), { recursive: true });
      writeJsonAtomic(this.path, { names: this.names }, { space: 2 });
    } catch { /* a label that could not be persisted is not worth a crash */ }
  }
}

let current: RepoNamesStore | null = null;

export function installRepoNames(root: string): void {
  current = new RepoNamesStore(root);
}

export function setRepoNamesStore(store: RepoNamesStore | null): void {
  current = store;
}

export function repoNamesStore(): RepoNamesStore | null {
  return current;
}

/** The display name for the clone whose primary checkout is `primary` — undefined without a store or a name. */
export function displayNameOf(primary: string): string | undefined {
  return current?.of(primary);
}

// ── What a notification calls a repo ──────────────────────────────────────────
//
// A push has no listing to read, only a session's cwd and its stored title (which leads with the
// FOLDER's name). The last scan is remembered here — only the worktrees that carry a shown name —
// so the title can be reworded at the moment it is SENT. The stored title is never rewritten.
const noTrailingSlash = (p: string): string => { let e = p.length; while (e > 1 && p[e - 1] === "/") e--; return p.slice(0, e); };
type Named = { path: string; repoName: string; displayName: string };
/** The last scan's named worktrees, PER scanned root — a scan of another folder (the Settings code-folder check, a candidate) replaces only its own list. */
const named = new Map<string, Named[]>();

/** Called by every scan (`repos.ts`) with the root it walked and what it found. */
export function noteScannedNames(root: string, targets: readonly RepoTarget[]): void {
  // The newest scan of a worktree path wins: another root's list (a code folder ABOVE this root
  // reaches the same worktrees) must not keep a name this scan no longer carries.
  const scanned = new Set(targets.map((t) => noTrailingSlash(t.worktreePath)));
  for (const [other, list] of named) if (other !== root) named.set(other, list.filter((n) => !scanned.has(n.path)));
  named.set(root, targets.filter((t) => t.displayName).map((t) => ({ path: noTrailingSlash(t.worktreePath), repoName: t.repoName, displayName: t.displayName! })));
}

/** `title` with its leading folder name replaced by the name the session's repo is shown under; unchanged when nobody gave it one. */
export function shownTitleForCwd(cwd: string, title: string): string {
  let best: Named | null = null;
  for (const list of named.values()) for (const n of list) {
    if (cwd !== n.path && !cwd.startsWith(n.path + "/")) continue;
    if (!best || n.path.length > best.path.length) best = n;
  }
  return best ? shownTitle(title, best.repoName, best.displayName) : title;
}
