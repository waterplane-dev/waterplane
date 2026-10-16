/**
 * Where the daemon's own directories are, across a rename — and the one-time
 * move from a legacy name to the current one. The only host module that spells
 * a legacy directory name, and it does so through `LEGACY`, never a literal.
 *
 * Four kinds of directory, two policies:
 *
 *  - **Host-owned** — the per-user config dir (`~/.config/<x>`: secrets,
 *    plugins, the generated skill), the data dir (`~/.local/share/<x>`: 1.6 GB
 *    of whisper weights) and the OLD root state dir (`<root>/<x>`: every ledger
 *    and store, until they moved out to the global state dir — the last section
 *    of this file). Nobody but this daemon writes them, so at BOOT, before any store
 *    opens and before `.env` files load, a legacy dir is RENAMED to the current
 *    name and a symlink is left at the old name (`adoptLegacyDir`). A rename is
 *    atomic on one filesystem, moves 1.6 GB in no time, and the symlink keeps
 *    every old path valid — notes, shell history, `~/.config/<legacy>/.env`, a
 *    rolled-back older build, and a daemon still running from before the
 *    restart. The symlinks go in a later cleanup release, never in this one.
 *  - **Per-repo** (`<repo>/<x>`) — **never moved automatically.** A rename
 *    nobody asked for would surface an untracked new dir in every repo whose
 *    `.gitignore` names only the old one; that is a mutation a person taps for
 *    (`compliance.ts`' `state-dir` row). Until then `repoStateDir` resolves to
 *    whichever exists, current first.
 *
 * **Never lose a file.** Nothing here deletes anything but an EMPTY legacy dir
 * it has just moved every entry out of. When both names exist (something
 * created the new one first), entries the new dir lacks are moved in one by one
 * and an entry present in both stays where it is, in the legacy dir, named in
 * the returned note — a person decides which copy is the real one.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BRAND, LEGACY, defaultRootOf, resolveEnv, rootPick, stateDirPick, type RootPicked, type StateDirSource } from "@waterplane/shared";
export type { RootPicked };

/** What `adoptLegacyDir` did, for the boot log and for tests. */
export interface AdoptResult {
  /** The directory to use from now on. */
  dir: string;
  /**
   * `current` — the current dir already existed and no legacy one held anything.
   * `fresh` — neither existed; nothing was created.
   * `renamed` — a legacy dir was renamed to the current name.
   * `merged` — both existed; the legacy dir's missing entries were moved in.
   * `legacy` — a legacy dir exists but could not be moved; use it as it is.
   */
  action: "current" | "fresh" | "renamed" | "merged" | "legacy";
  /** The legacy path that was moved, merged or is in use. */
  from?: string;
  /** Entries present under both names, left in the legacy dir untouched. */
  kept?: string[];
  /** One sentence for the log, when anything happened or went wrong. */
  note?: string;
}

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

/** True when `p` is a directory or a symlink that resolves to one. */
function isDirish(p: string): boolean {
  const st = lstatOrNull(p);
  if (!st) return false;
  if (st.isDirectory()) return true;
  if (!st.isSymbolicLink()) return false;
  try { return lstatSync(realpathSync(p)).isDirectory(); } catch { return false; }
}

function samePath(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** Point `legacy` at `current` (relative when they share a parent, so the link
 *  survives the parent being moved). Never replaces anything that is there. */
function linkBack(current: string, legacy: string): string | undefined {
  if (lstatOrNull(legacy)) return undefined;
  const target = dirname(current) === dirname(legacy) ? basename(current) : current;
  try { symlinkSync(target, legacy, "dir"); return undefined; }
  catch (e) { return `could not leave a symlink at ${legacy}: ${(e as Error).message}`; }
}

/**
 * Make `current` the directory in use, adopting the first of `legacy` that
 * exists. Idempotent: once the legacy path is a symlink to `current`, every
 * later call answers `current` and touches nothing. Never throws.
 */
export function adoptLegacyDir(current: string, legacy: readonly string[]): AdoptResult {
  for (const leg of legacy) {
    if (leg === current || !lstatOrNull(leg)) continue;
    // Already adopted: the legacy name is our own symlink back.
    if (isDirish(current) && samePath(leg, current)) continue;
    if (!isDirish(leg)) continue; // a dangling link or a plain file is not ours to move

    if (!lstatOrNull(current)) {
      try {
        renameSync(leg, current);
      } catch (e) {
        // Another process (a second host booting against the same root) may
        // have just done it — then the current dir exists and that is success.
        if (isDirish(current)) return { dir: current, action: "current" };
        return { dir: leg, action: "legacy", from: leg, note: `could not rename ${leg} to ${current} (${(e as Error).message}) — using ${leg} as it is` };
      }
      const err = linkBack(current, leg);
      return { dir: current, action: "renamed", from: leg, note: `moved ${leg} to ${current}` + (err ? `; ${err}` : `, and left a symlink at the old name`) };
    }

    if (!isDirish(current)) {
      return { dir: leg, action: "legacy", from: leg, note: `${current} exists and is not a directory — using ${leg} as it is` };
    }

    // Both are real directories. Move in what the current one lacks; keep
    // whatever both hold where it is.
    const kept: string[] = [];
    let entries: string[] = [];
    try { entries = readdirSync(leg); } catch { /* unreadable — leave it all */ }
    for (const name of entries) {
      if (lstatOrNull(join(current, name))) { kept.push(name); continue; }
      try { renameSync(join(leg, name), join(current, name)); } catch { kept.push(name); }
    }
    let tail = "";
    if (!kept.length) {
      try { rmdirSync(leg); tail = linkBack(current, leg) ?? ", and left a symlink at the old name"; }
      catch (e) { tail = `; ${leg} could not be removed (${(e as Error).message})`; }
    } else {
      tail = `; ${kept.length} entr${kept.length === 1 ? "y is" : "ies are"} in both and stayed in ${leg}: ${kept.slice(0, 8).join(", ")}${kept.length > 8 ? ", …" : ""}`;
    }
    return { dir: current, action: "merged", from: leg, kept, note: `merged ${leg} into ${current}${tail}` };
  }
  return { dir: current, action: isDirish(current) ? "current" : "fresh" };
}

/** `<parent>/<current name>` and each `<parent>/<legacy name>`, newest first. */
function candidates(parent: string, pick: (b: { configDirName: string; stateDirName: string }) => string) {
  return { current: join(parent, pick(BRAND)), legacy: LEGACY.map((l) => join(parent, pick(l))).filter((p) => p !== join(parent, pick(BRAND))) };
}

/** Current if it exists, else the first legacy that exists, else current. */
function resolveExisting(current: string, legacy: readonly string[]): string {
  if (isDirish(current)) return current;
  for (const l of legacy) if (isDirish(l)) return l;
  return current;
}

// ── The per-user config dir ─────────────────────────────────────────────────

/** An explicit `<PREFIX>CONFIG_DIR` (tests, overrides) — used verbatim, never migrated. */
function configOverride(): string | undefined {
  const v = resolveEnv(process.env, "CONFIG_DIR").value;
  return v ? resolve(v) : undefined;
}

function configParent(): string {
  const xdg = (process.env.XDG_CONFIG_HOME || "").trim();
  return xdg ? resolve(xdg) : join(homedir(), ".config");
}

/**
 * The fixed per-user dir for the daemon's own config and secrets, independent
 * of the root: `<PREFIX>CONFIG_DIR` → `$XDG_CONFIG_HOME/<name>` →
 * `~/.config/<name>`, falling back to a legacy name only when the boot
 * migration could not move it.
 */
export function configDir(): string {
  const o = configOverride();
  if (o) return o;
  const c = candidates(configParent(), (b) => b.configDirName);
  return resolveExisting(c.current, c.legacy);
}

// ── The per-user data dir ───────────────────────────────────────────────────

function dataParent(): string {
  const xdg = (process.env.XDG_DATA_HOME || "").trim();
  return xdg ? resolve(xdg) : join(homedir(), ".local", "share");
}

/** `$XDG_DATA_HOME/<name>` or `~/.local/share/<name>` (whisper models, kept clips). */
export function dataDir(): string {
  const c = candidates(dataParent(), (b) => b.configDirName);
  return resolveExisting(c.current, c.legacy);
}

// ── State under the root and under a repo ──────────────────────────────────

/** `<root>/<state dir>` — every host store and ledger. After the boot
 *  migration this is the current name; a legacy dir is answered only when that
 *  migration could not move it, so the stores still find their data. */
export function rootStateDir(root: string): string {
  const c = candidates(root, (b) => b.stateDirName);
  return resolveExisting(c.current, c.legacy);
}

/**
 * `<repo>/<state dir>` for per-repo config (`builds.json`, `capture.json`,
 * `artifacts.json`, `autopull.json`). The current name when it exists, else a
 * legacy one that exists, else the current name (created by the first writer).
 * Never moves anything — see the header.
 */
export function repoStateDir(repo: string): string {
  const c = candidates(repo, (b) => b.stateDirName);
  return resolveExisting(c.current, c.legacy);
}

/** `<repo>/<shared dir>` — per-repo config meant to be COMMITTED with the checkout
 *  (`builds.json`), beside the gitignored state dir. A new name with no legacy
 *  spelling, so there is nothing to resolve: always the current name. */
export function repoSharedDir(repo: string): string {
  return join(repo, BRAND.sharedDirName);
}

/** The legacy state dirs this repo still has as real directories (not our own
 *  symlink back), newest first — what the setup row reports. */
export function legacyRepoStateDirs(repo: string): string[] {
  const c = candidates(repo, (b) => b.stateDirName);
  return c.legacy.filter((l) => {
    const st = lstatOrNull(l);
    return !!st && st.isDirectory();
  });
}

/** Adopt a repo's legacy state dir into the current name — the setup fix, a
 *  person's tap. Same rules as the boot move: rename when the current dir is
 *  absent, merge-without-overwrite when both exist, symlink back. */
export function adoptRepoStateDir(repo: string): AdoptResult {
  const c = candidates(repo, (b) => b.stateDirName);
  return adoptLegacyDir(c.current, c.legacy);
}

// ── Boot ────────────────────────────────────────────────────────────────────

/**
 * The boot move, called by `env.ts` before any `.env` file is read and before
 * any store opens. Config (unless overridden by env), data, and the root state
 * dir. Returns what happened; logging is the caller's.
 */
export function migrateHostDirs(root: string): AdoptResult[] {
  const out: AdoptResult[] = [];
  if (!configOverride()) {
    const c = candidates(configParent(), (b) => b.configDirName);
    out.push(adoptLegacyDir(c.current, c.legacy));
  }
  const d = candidates(dataParent(), (b) => b.configDirName);
  out.push(adoptLegacyDir(d.current, d.legacy));
  const s = candidates(root, (b) => b.stateDirName);
  out.push(adoptLegacyDir(s.current, s.legacy));
  return out;
}

// ── The code root, and the daemon's global state dir ───────────────────────
//
// The daemon's own stores (acks, sessions, settings, intents, push keys, auth,
// every ledger — `hoststore.ts` catalogues them) used to live in
// `<root>/<state dir>`, inside the folder holding a person's code. Two faults:
// changing the root orphaned every one of them, and a fresh install wrote a
// dot-dir into a stranger's code folder. They now live in ONE per-user dir that
// does not depend on the root:
//
//   `<PREFIX>STATE_DIR` → `$XDG_STATE_HOME/<name>` → `~/.local/state/<name>`
//
// on every platform (config already sits in `~/.config/<name>`, data in
// `~/.local/share/<name>`). Read from the PROCESS environment only, like the
// root: it has to be known before the `.env` file inside it can be loaded.
//
// PER-REPO state (`<repo>/<state dir>/`: builds.json, capture.json,
// artifacts.json, autopull.json, repohealth*, assess-in/out, peer-job.json, a
// repo's backlog.json…) is the repo's, not the daemon's — `repoStateDir` above,
// untouched by any of this.

/** The code root when nothing names one: `~/dev` (`@waterplane/shared`'s `defaultRootOf`, the ONE spelling). */
export function defaultRoot(home: string = homedir()): string {
  return resolve(defaultRootOf(home));
}

/** The usual code folders under a home, in the order they are tried. `~/dev` first: it is the
 *  fallback too. The last two are what Visual Studio and GitHub Desktop create. */
export const CODE_FOLDERS: readonly string[] = [
  "dev", "code", "Code", "src", "projects", "Projects", "repos", "git", "Developer", "workspace",
  "source/repos", "Documents/GitHub",
];

/** The two disk questions the pick asks, injectable so it is testable with no disk. */
export interface RootFs {
  isDir(p: string): boolean;
  /** One level only: is any child directory of `p` a checkout (has a `.git`)? */
  hasGitChild(p: string): boolean;
}

export const realRootFs: RootFs = {
  isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } },
  hasGitChild(p) {
    try {
      for (const e of readdirSync(p, { withFileTypes: true }).slice(0, 500)) {
        if (e.isDirectory() && existsSync(join(p, e.name, ".git"))) return true;
      }
    } catch { /* unreadable — not a repo holder */ }
    return false;
  },
};

export interface RootChoice {
  root: string;
  defaulted: boolean;
  /** `named` — the knob. `chosen` — the person picked it (`rootchoice.ts`). `found` — an existing
   *  usual folder. `fallback` — none existed, `~/dev` assumed. */
  picked: RootPicked;
  /** The candidates looked at, in order (empty when the knob named the root). */
  tried: string[];
}

/**
 * The code root with the knob unset: the first usual folder holding a repo, else the first that
 * exists, else `<home>/dev`. Pure over `fs`; does NOT `resolve()` (a Windows-style home stays
 * testable anywhere) — `resolveRoot` makes it absolute. Cheap sync checks: this runs at import.
 */
export function pickCodeRoot(
  home: string, fs: RootFs = realRootFs, platform: NodeJS.Platform = process.platform,
): { root: string; picked: "found" | "fallback"; tried: string[] } {
  const base = home.length > 1 ? home.replace(/[\\/]+$/, "") : home;
  // macOS guards ~/Documents (TCC): a launchd daemon touching it raises a privacy prompt on
  // every boot. Not worth it for one GitHub Desktop default.
  const folders = platform === "darwin" ? CODE_FOLDERS.filter((rel) => !rel.startsWith("Documents/")) : CODE_FOLDERS;
  // Lazy, in order: the first folder holding a repo ends the walk, so a populated ~/dev
  // costs one stat and one readdir, and later candidates are never touched.
  const tried: string[] = [];
  let firstExisting: string | undefined;
  for (const rel of folders) {
    const p = `${base}/${rel}`;
    tried.push(p);
    if (!fs.isDir(p)) continue;
    if (fs.hasGitChild(p)) return { root: p, picked: "found", tried };
    firstExisting ??= p;
  }
  return firstExisting
    ? { root: firstExisting, picked: "found", tried }
    : { root: defaultRootOf(home), picked: "fallback", tried };
}

/** Running under WSL — the kernel says so. Read once; false anywhere `/proc` is not. */
export const RUNNING_IN_WSL: boolean = process.platform === "linux" && (() => {
  try { return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; }
})();

/**
 * A Windows path (`c:/dev`, `C:\dev`) as WSL mounts it (`/mnt/c/dev`); anything else unchanged.
 * On Windows the host runs inside WSL from the Windows checkout, so the repo `.env` is shared by
 * both sides and its `<PREFIX>ROOT` is naturally written the Windows way — which `resolve()` would
 * otherwise turn into `<cwd>/c:/dev`, a folder nobody has.
 */
export function wslMountPath(p: string): string {
  const m = /^([a-z]):(?:[\\/](.*))?$/i.exec(p.trim());
  if (!m) return p;
  const rest = (m[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** `<PREFIX>ROOT`, else the folder the person chose (`chosen`, from `rootchoice.ts`), else the first
 *  usual code folder that exists (`pickCodeRoot`), else `~/dev`; absolute. `defaulted` = nobody named
 *  or chose it. Under WSL a Windows-style path is its `/mnt/<drive>` mount (`wslMountPath`). */
export function resolveRoot(
  e: NodeJS.ProcessEnv = process.env, home: string = homedir(), fs: RootFs = realRootFs, chosen?: string,
  inWsl: boolean = RUNNING_IN_WSL,
): RootChoice {
  const abs = (p: string): string => resolve(inWsl ? wslMountPath(p) : p);
  const p = rootPick(e, home);
  if (!p.defaulted) return { root: abs(p.root), defaulted: false, picked: "named", tried: [] };
  if (chosen) return { root: abs(chosen), defaulted: false, picked: "chosen", tried: [] };
  const f = pickCodeRoot(home, fs);
  return { root: resolve(f.root), defaulted: true, picked: f.picked, tried: f.tried.map((t) => resolve(t)) };
}

/** Where the daemon's global state belongs — `@waterplane/shared`'s `stateDirPick`, made absolute. Touches no disk. */
export function resolveStateDir(e: NodeJS.ProcessEnv = process.env, home: string = homedir()): { dir: string; source: StateDirSource } {
  const p = stateDirPick(e, home);
  return { dir: resolve(RUNNING_IN_WSL ? wslMountPath(p.dir) : p.dir), source: p.source };
}

/** The note left at the old place when a symlink could not be. */
export const STATE_MOVED_NOTE = "MOVED.txt";
/** Written into the old dir just before the move, so it travels with it: names
 *  where the state came from, so a crash between the rename and the pointer can
 *  be finished on the next boot — and so a pointer is only ever recreated at a
 *  place state really was, never invented in a fresh install's code folder. */
export const STATE_MOVED_FROM = "moved-from.json";
/** The at-most-once memory. A boot that ends up without it while the old dir
 *  had one would let a queued prompt run twice — see `migrateStateDir`. */
const ACK_FILE = "acks.json";

/**
 * Entries that are not state: our own markers, the desktop's droppings, and an
 * entry a cross-device merge renamed aside (`<name>.moved-<ts>`, kept, no longer
 * read). A `.DS_Store` must never make a new dir count as "already holding state".
 */
export function isStateNoise(name: string): boolean {
  return name === STATE_MOVED_NOTE || name === STATE_MOVED_FROM || name === ".DS_Store" || name === "Thumbs.db" ||
    name === "desktop.ini" || name === ".localized" || name.startsWith("._") || /\.moved-\d+$/.test(name);
}

/** A directory (or a link to one) holding anything that is not noise. */
export function hasState(dir: string): boolean {
  if (!isDirish(dir)) return false;
  try { return readdirSync(dir).some((n) => !isStateNoise(n)); } catch { return false; }
}

/** `<root>/<current name>` and each `<root>/<legacy name>`, newest first. */
function rootStateCandidates(root: string): string[] {
  const c = candidates(root, (b) => b.stateDirName);
  return [c.current, ...c.legacy];
}

/** The first under-root state dir that is a REAL directory holding state —
 *  never our own symlink, never a dir holding only noise. */
function oldRootState(root: string, stateDir: string): string | null {
  for (const p of rootStateCandidates(root)) {
    const st = lstatOrNull(p);
    if (!st?.isDirectory()) continue;
    if (samePath(p, stateDir)) continue;
    if (hasState(p)) return p;
  }
  return null;
}

/**
 * The sentence for a state move refused because another host for this root is
 * still answering (`env.ts`). How to stop it depends on how this host was
 * installed, and the sentence cannot know which, so it says both: a git checkout
 * restarts with `npm run restart`; a release install restarts its service
 * (launchd / systemd, `<slug> service status` says which) or ends the foreground
 * `<slug> start`.
 */
export function stateMoveRefusedSentence(from: string, to: string, other: string): string {
  return `not moving ${from} to ${to}: another host for this root answers on ${other} — using ${from} as it is. ` +
    `Stop it — \`npm run restart\` in a git checkout; for a release install, restart its service ` +
    `(\`${BRAND.slug} service status\` names it) or end the foreground \`${BRAND.slug} start\` — and the next boot moves it.`;
}

/** The old dir a boot move would act on, or null when there is nothing to move
 *  (the new dir IS the old place, or no old dir holds state). For `env.ts`' guard. */
export function pendingStateMove(root: string, stateDir: string): string | null {
  const want = resolve(stateDir);
  if (rootStateCandidates(root).some((p) => resolve(p) === want)) return null;
  return oldRootState(root, want);
}

/**
 * The state dir a process that does NOT migrate (a test, a tool, `--doctor`)
 * should read: the new dir once it holds state, else an old under-root dir
 * still holding it (the move has not happened yet), else the new dir.
 */
export function liveStateDir(root: string, stateDir: string): string {
  if (hasState(stateDir)) return stateDir;
  return oldRootState(root, stateDir) ?? stateDir;
}

const realOr = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };
let bound: { root: string; real: string; dir: string } | undefined;

/** `env.ts` names the daemon's root and its state dir, once, at import. */
export function bindHostStateDir(root: string, dir: string): void {
  bound = { root: resolve(root), real: realOr(root), dir: resolve(dir) };
}

/**
 * THE directory every global store opens under. For the daemon's own root it
 * is the bound state dir; for any other root — a unit test's mkdtemp, a tool
 * handed a fixture — it is `<root>/<state dir>` as before, so a test that
 * builds a store on a scratch root can never reach a person's real
 * `~/.local/state`.
 *
 * Why the root is still an argument (and not a no-argument read of the
 * binding): dozens of unit tests build stores on their own mkdtemp roots and
 * read `<root>/<state dir>/x.json` back, each root its own world. A
 * no-argument resolver would put every one of them in ONE shared dir. The
 * compare is REALPATH, so `/var/…` vs `/private/var/…` or a symlinked root is
 * still the daemon's root; the plain-resolve compare is only the fast path.
 */
export function hostStateDir(root: string): string {
  if (bound) {
    const r = resolve(root);
    if (r === bound.root || r === bound.real || realOr(r) === bound.real) return bound.dir;
  }
  return rootStateDir(root);
}

/** What `migrateStateDir` did. */
export interface StateMoveResult {
  /** The directory to bind: the new dir, or the old one when a move failed. */
  dir: string;
  /**
   * `same` — the new dir IS the under-root dir (e2e pins it there); nothing to do.
   * `fresh` — nothing anywhere. `current` — the new dir holds state, no old one does.
   * `moved` — renamed. `copied` — cross-device: copied, verified, old renamed aside.
   * `merged` — both held state: what the new dir lacked was moved in entry by
   *   entry, never overwriting; `kept` names what was in both and stayed behind.
   * `failed` — the move did not happen; the old dir is used as it is.
   */
  action: "same" | "fresh" | "current" | "moved" | "copied" | "merged" | "failed";
  from?: string;
  /** The old dir's new name after a cross-device copy. */
  aside?: string;
  /** Entries present in both dirs, left in the old one untouched (the new dir's copy is used). */
  kept?: string[];
  note?: string;
}

/** The fs calls the move makes, injectable so the cross-device path is testable. */
export interface StateMoveOps {
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
}
const realOps: StateMoveOps = {
  rename: (a, b) => renameSync(a, b),
  copy: (a, b) => cpSync(a, b, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false }),
};

/** What one entry is, for the copy check: kind, size and bytes (a dir: its whole tree). */
function entryOf(p: string): string {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return `link:${readlinkSync(p)}`;
  if (st.isFile()) return `file:${st.size}:${createHash("sha1").update(readFileSync(p)).digest("hex")}`;
  if (st.isDirectory()) return `dir:${[...treeOf(p)].map(([k, v]) => `${k}=${v}`).join("|")}`;
  return "other";
}

/** Every entry under `dir`, relative, with what it is — for the copy check. */
function treeOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? join(rel, name) : name;
      const p = join(dir, r);
      const st = lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) { out.set(r, "dir"); walk(r); }
      else out.set(r, entryOf(p));
    }
  };
  walk("");
  return out;
}

/** null when `b` holds exactly what `a` holds (names, kinds, sizes, bytes); else what differs. */
export function treeMismatch(a: string, b: string): string | null {
  let ta: Map<string, string>, tb: Map<string, string>;
  try { ta = treeOf(a); tb = treeOf(b); } catch (e) { return (e as Error).message; }
  for (const [k, v] of ta) if (tb.get(k) !== v) return `${k} differs`;
  for (const k of tb.keys()) if (!ta.has(k)) return `${k} is extra`;
  return null;
}

/** Leave a pointer at the old place: a symlink, else a dir with a note in it. */
function leavePointer(oldPath: string, newDir: string): string {
  if (lstatOrNull(oldPath)) return ""; // something is still there — never replace it
  try { symlinkSync(newDir, oldPath, "dir"); return `, and left a symlink at ${oldPath}`; } catch { /* fall through */ }
  try {
    mkdirSync(oldPath, { recursive: true });
    return writeMovedNote(oldPath, newDir) ? `, and left ${join(oldPath, STATE_MOVED_NOTE)} saying where` : "";
  } catch (e) { return `; could not leave a pointer at ${oldPath} (${(e as Error).message})`; }
}

function writeMovedNote(dir: string, newDir: string): boolean {
  const p = join(dir, STATE_MOVED_NOTE);
  if (lstatOrNull(p)) return false;
  try {
    writeFileSync(p,
      `${BRAND.name} keeps its own state outside your code folder now.\n\nIt moved to: ${newDir}\n\n` +
      `Set ${BRAND.envPrefix}STATE_DIR to keep it somewhere else. Anything still in this folder was ALSO in the new one ` +
      `and was left here untouched; the new copy is the one in use.\n`);
    return true;
  } catch { return false; }
}

/** Stale staging copies from a cross-device move a crash interrupted — ours,
 *  never the old dir (which the copy path only ever renames aside). */
function cleanIncoming(want: string): string[] {
  const parent = dirname(want), prefix = `${basename(want)}.incoming-`;
  let names: string[] = [];
  try { names = readdirSync(parent).filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))); } catch { return []; }
  const removed: string[] = [];
  for (const n of names) { try { rmSync(join(parent, n), { recursive: true, force: true }); removed.push(join(parent, n)); } catch { /* next boot */ } }
  return removed;
}

/** A crash between the rename and the pointer left the old path empty: put the
 *  pointer back — only where the marker says state really came from. */
function repairPointer(root: string, want: string): string | undefined {
  let from: unknown;
  try { from = (JSON.parse(readFileSync(join(want, STATE_MOVED_FROM), "utf8")) as { from?: unknown }).from; } catch { return undefined; }
  if (typeof from !== "string" || !rootStateCandidates(root).includes(from) || lstatOrNull(from)) return undefined;
  const tail = leavePointer(from, want);
  return tail ? `the pointer at ${from} was missing (an interrupted move)${tail}` : undefined;
}

/** Move one entry from `fromDir` to `toDir`; across filesystems copy, verify,
 *  swap in and rename the source aside (`<name>.moved-<ts>`, kept). Throws on failure. */
function moveEntry(fromDir: string, toDir: string, name: string, ops: StateMoveOps, ts: number): void {
  const src = join(fromDir, name), dst = join(toDir, name);
  try { ops.rename(src, dst); return; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  const incoming = join(toDir, `${name}.incoming-${ts}`);
  try { ops.copy(src, incoming); } catch (e) { rmSync(incoming, { recursive: true, force: true }); throw e; }
  let same = false;
  try { same = entryOf(src) === entryOf(incoming); } catch { /* unreadable ⇒ not verified */ }
  if (!same) { rmSync(incoming, { recursive: true, force: true }); throw new Error("the copy did not verify"); }
  ops.rename(incoming, dst);
  try { ops.rename(src, join(fromDir, `${name}.moved-${ts}`)); } catch { /* still there, no longer read */ }
}

/**
 * Both dirs hold state. Never overwrite, never lose the ack ledger:
 *
 *  - a cross-device copy that completed but crashed before renaming the old
 *    dir aside (the two trees are identical) is finished;
 *  - else every entry the new dir lacks is moved in, ack ledger FIRST — if it
 *    cannot move, nothing else does and the OLD dir is bound;
 *  - an entry present in both stays in the old dir (named in `kept`), and the
 *    old dir gets a `MOVED.txt` saying so; emptied, it becomes a symlink.
 *
 * Why not "keep the new dir, ignore the old": a `.env` a person created in the
 * new dir (the docs invite it) would then make the daemon boot with no
 * `acks.json` — absent, not corrupt, so nothing would even say so — and a
 * queued prompt could run twice; and the old `.env`'s allowed hosts would
 * vanish, locking the phone out.
 */
function mergeInto(from: string, want: string, ops: StateMoveOps, ts: number): StateMoveResult {
  if (treeMismatch(from, want) === null) {
    const aside = `${from}.moved-${ts}`;
    try { ops.rename(from, aside); } catch (e) {
      return { dir: want, action: "copied", from, note: `${from} is a verified copy of ${want} (an interrupted cross-device move) but could not be renamed aside (${(e as Error).message}); it is no longer read` };
    }
    return { dir: want, action: "copied", from, aside, note: `finished an interrupted copy: renamed ${from} to ${aside}${leavePointer(from, want)}` };
  }
  const fail = (why: string): StateMoveResult =>
    ({ dir: from, action: "failed", from, note: `could not merge ${from} into ${want} (${why}) — using ${from} as it is` });
  let names: string[];
  try { names = readdirSync(from).filter((n) => !isStateNoise(n)); } catch (e) { return fail((e as Error).message); }
  names.sort((a, b) => (a === ACK_FILE ? -1 : b === ACK_FILE ? 1 : 0));
  const kept: string[] = [], failedNames: string[] = [];
  let moved = 0;
  for (const name of names) {
    if (lstatOrNull(join(want, name))) { kept.push(name); continue; }
    try { moveEntry(from, want, name, ops, ts); moved++; } catch (e) {
      if (name === ACK_FILE) return fail(`the ack ledger could not be moved: ${(e as Error).message}`);
      failedNames.push(name);
    }
  }
  const stillThere = [...kept, ...failedNames];
  let tail = "";
  if (!stillThere.length) {
    try { rmdirSync(from); tail = leavePointer(from, want); }
    catch { tail = writeMovedNote(from, want) ? `; ${from} keeps only noise and a ${STATE_MOVED_NOTE}` : ""; }
  } else {
    writeMovedNote(from, want);
    const list = (xs: string[]) => `${xs.slice(0, 8).join(", ")}${xs.length > 8 ? ", …" : ""}`;
    tail = (kept.length ? `; ${kept.length} entr${kept.length === 1 ? "y was" : "ies were"} in BOTH and stayed in ${from}, unused: ${list(kept)}` : "") +
      (failedNames.length ? `; ${failedNames.length} could not be moved and stayed in ${from}: ${list(failedNames)}` : "");
  }
  return { dir: want, action: "merged", from, kept: stillThere, note: `BOTH ${from} and ${want} held state — merged ${moved} entr${moved === 1 ? "y" : "ies"} the new dir lacked, overwriting nothing${tail}` };
}

/**
 * The one-time move of `<root>/<state dir>` (or a legacy-named one) to the
 * global state dir. Daemon boot only (`env.ts`), after `migrateHostDirs`,
 * before any store opens, and only after `env.ts` has made sure no OTHER
 * daemon for this root is still running (one writing the old path between the
 * rename and the pointer would recreate a real dir there: split brain). Never
 * deletes a file of the person's:
 *
 *  - stale `<new>.incoming-<ts>` staging copies of an interrupted cross-device
 *    move are removed (ours; the old dir is never touched by that);
 *  - nothing old to move ⇒ if a crash left the old path with no pointer, the
 *    pointer is put back (only where `moved-from.json` says state came from);
 *  - the new dir already holds state ⇒ `mergeInto` (above);
 *  - else rename old → new (an EMPTY or noise-only new dir is set aside first,
 *    never a full one);
 *  - EXDEV ⇒ copy to `<new>.incoming-<ts>`, verify byte-for-byte, rename that
 *    into place, rename the old dir aside to `<old>.moved-<ts>`;
 *  - then a symlink at the old path (else a dir with `MOVED.txt`);
 *  - any failure before the new dir is complete ⇒ `failed`, bind the OLD dir:
 *    `acks.json` is the at-most-once memory, and booting on an empty one would
 *    let a queued prompt run twice.
 *
 * Idempotent: once the old path is our symlink (or a noise-only dir), every
 * later call answers `current`.
 */
export function migrateStateDir(root: string, stateDir: string, ops: StateMoveOps = realOps, now: () => number = Date.now): StateMoveResult {
  const want = resolve(stateDir);
  if (rootStateCandidates(root).some((p) => resolve(p) === want)) return { dir: want, action: "same" };
  const cleaned = cleanIncoming(want);
  const cleanNote = cleaned.length ? `removed ${cleaned.length} stale staging cop${cleaned.length === 1 ? "y" : "ies"} of an interrupted move (${cleaned.join(", ")})` : undefined;
  const join2 = (...xs: (string | undefined)[]) => xs.filter(Boolean).join("; ") || undefined;
  const from = oldRootState(root, want);
  const newHas = hasState(want);
  if (!from) return { dir: want, action: newHas ? "current" : "fresh", note: join2(cleanNote, newHas ? repairPointer(root, want) : undefined) };
  const ts = now();
  if (newHas) { const r = mergeInto(from, want, ops, ts); return { ...r, note: join2(cleanNote, r.note) }; }

  const fail = (why: string): StateMoveResult => {
    try { rmSync(join(from, STATE_MOVED_FROM), { force: true }); } catch { /* best effort */ }
    return { dir: from, action: "failed", from, note: join2(cleanNote, `could not move ${from} to ${want} (${why}) — using ${from} as it is`) };
  };
  try {
    mkdirSync(dirname(want), { recursive: true });
    const st = lstatOrNull(want);
    if (st) {
      if (!st.isDirectory()) return fail(`${want} exists and is not a directory`);
      // Empty or noise-only (hasState was false): set aside, never deleted.
      if (readdirSync(want).length) renameSync(want, `${want}.noise-${ts}`); else rmdirSync(want);
    }
  } catch (e) { return fail((e as Error).message); }
  try { writeFileSync(join(from, STATE_MOVED_FROM), JSON.stringify({ from, to: want, at: ts }) + "\n"); } catch { /* the pointer repair is best-effort */ }

  try {
    ops.rename(from, want);
    return { dir: want, action: "moved", from, note: join2(cleanNote, `moved ${from} to ${want}${leavePointer(from, want)}`) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") return fail((e as Error).message);
  }

  // Another filesystem: copy, check, swap in, rename the old aside.
  const incoming = `${want}.incoming-${ts}`;
  try { ops.copy(from, incoming); } catch (e) {
    try { rmSync(incoming, { recursive: true, force: true }); } catch { /* our own partial copy */ }
    return fail(`copy: ${(e as Error).message}`);
  }
  const bad = treeMismatch(from, incoming);
  if (bad) {
    try { rmSync(incoming, { recursive: true, force: true }); } catch { /* our own partial copy */ }
    return fail(`the copy did not verify: ${bad}`);
  }
  try { ops.rename(incoming, want); } catch (e) { return fail(`swap-in: ${(e as Error).message}`); }
  const aside = `${from}.moved-${ts}`;
  try { ops.rename(from, aside); } catch (e) {
    return { dir: want, action: "copied", from,
      note: join2(cleanNote, `copied ${from} to ${want} (another filesystem) and verified it; the old dir could not be renamed aside ` +
        `(${(e as Error).message}) and is still there, no longer read`) };
  }
  return { dir: want, action: "copied", from, aside,
    note: join2(cleanNote, `copied ${from} to ${want} (another filesystem), verified it, renamed the old dir to ${aside}${leavePointer(from, want)}`) };
}

/** For the doctor: where state lives, why, and whether an old under-root dir still holds some. */
export function stateDirReport(root: string, e: NodeJS.ProcessEnv = process.env): {
  dir: string; source: StateDirSource; live: string; old: string | null;
} {
  const { dir, source } = resolveStateDir(e);
  const same = rootStateCandidates(root).some((p) => resolve(p) === resolve(dir));
  const live = bound && (resolve(root) === bound.root || realOr(root) === bound.real) ? bound.dir : liveStateDir(root, dir);
  return { dir, source, live, old: same ? null : oldRootState(root, dir) };
}
