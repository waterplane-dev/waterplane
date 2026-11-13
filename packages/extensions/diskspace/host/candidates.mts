/**
 * What may be deleted, and what is only shown — computed HERE, from fixed rules over the host's own
 * roots, never from anything the phone sent. Every function resolves one CATEGORY freshly, so a
 * delete can re-derive exactly its own category (`engine.mts`) instead of trusting a list it handed
 * out earlier.
 *
 * Categories and their anchors (the folder a candidate must REALLY be inside — `safeToRemove`):
 *   cache   a fixed list of regenerable caches under $HOME, each exactly its own path
 *   build   build output under the code root: `build`/`.next`/`.turbo`/`.vite` next to a
 *           package.json / build.gradle* / settings.gradle*, and ignored by git
 *   tmp     claude session scratchpads under /tmp/claude-<uid> (/private/tmp on a Mac), untouched for a day (anchored at /tmp, so the
 *           claude-<uid> folder must itself be real)
 *   wcache  wsl only: a fixed list of regenerable caches under the Windows home, each exactly its
 *           own path (one `*` segment allowed: a Firefox profile folder, each still checked)
 *   wtemp   wsl only: entries directly under the Windows %TEMP% untouched for a week (anchored at the Windows home)
 *   hf      ~/.cache/huggingface/hub/models--*
 *   ollama  a tag `ollama list` names (deleted by `ollama rm`, never by path)
 * Show-only entries get ids too (`show:`/`nm:`), so the phone can key its rows — and no
 * `remove` accepts them (`CANDIDATE_ID_RE`).
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { DiskKind, DiskProfile, DiskSide } from "../shared/wire.mjs";
import { run, pool, tick, type Runner } from "./run.mjs";

export interface Roots {
  /** Which desktop this is (`index.mts` decides once). Absent = `mac`. */
  profile?: DiskProfile;
  /** wsl: the Windows user folder as a /mnt path (`/mnt/c/Users/me`); null when it could not be found. */
  winHome?: string | null;
  /** wsl: the distro's name (WSL_DISTRO_NAME), for the compact instruction. */
  wslDistro?: string | null;
  /** A sentence every scan repeats: why this desktop is listed more narrowly than its profile would be. */
  profileNote?: string | null;
  /** wsl: `powershell.exe` — the reader of Windows-side folder sizes and the fallback reader of the Windows drive's free space; null = none. */
  psBin?: string | null;
  /** wsl: the time bound on the one PowerShell call that sizes the Windows-side folders of a scan phase. */
  psTimeoutMs?: number;
  /** Tests: stands in for `run` when PowerShell is called (never a real powershell.exe in a test). */
  psRun?: Runner;
  /** Tests: a path's Windows form (default `winPathOf`: `/mnt/c/x` → `C:\x`). */
  winPath?: (p: string) => string | null;
  /** wsl: how long a %TEMP% entry must be untouched before it is offered (a week). */
  winTempMinAgeMs: number;
  home: string;
  /** The code root (WATERPLANE_ROOT, else ~/dev). */
  root: string;
  /** `/private/tmp/claude-<uid>` on a Mac, `/tmp/claude-<uid>` on Linux. */
  tmpRoot: string;
  androidSdk: string;
  duBin: string;
  gitBin: string;
  findBin: string;
  /** null: no ollama on this desktop. */
  ollamaBin: string | null;
  duTimeoutMs: number;
  concurrency: number;
  walkDepth: number;
  /** Folders the code-root walk may open before it stops (and says so). */
  walkBudget: number;
  tmpMinAgeMs: number;
  largeLimitMs: number;
  /** `find -size` argument. */
  largeMinSize: string;
  now: () => number;
}

export type Category = "cache" | "build" | "tmp" | "hf" | "ollama" | "wcache" | "wtemp" | "show" | "nm";

export interface Candidate {
  id: string;
  category: Category;
  kind: DiskKind;
  group: string;
  label: string;
  /** Absent for ollama (deleted by name) and the aggregated scratchpad row. */
  path?: string;
  /** The aggregated scratchpad row: the folders it stands for. */
  members?: string[];
  ollamaName?: string;
  ollamaId?: string;
  /** ollama's own size text, kept for the row. */
  sizeText?: string;
  regen?: string;
  mtime?: number | null;
  note?: string;
  /** wsl only: which disk it is on. */
  side?: DiskSide;
}

export function idOf(category: Category, key: string): string {
  return `${category}:${createHash("sha256").update(`${category}\0${key}`).digest("hex").slice(0, 16)}`;
}

export function tilde(p: string, home: string): string {
  return p === home ? "~" : p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

export const profileOf = (r: Roots): DiskProfile => r.profile ?? "mac";
/** The Windows home, only on wsl. */
export const winHomeOf = (r: Roots): string | null => (profileOf(r) === "wsl" ? r.winHome ?? null : null);

/** `/mnt/c/Users/me/x` as Windows writes it (`C:/Users/me/x`); any other path as it is. */
export function driveForm(p: string): string {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? "/"}` : p;
}

/** On wsl a group says which disk it is on; elsewhere there is one disk and it says nothing. */
/** The disk a PATH is on under wsl: a path under /mnt/<letter>/ is that Windows drive, anything else is inside WSL. */
export const sideOfPath = (p: string): DiskSide => (/^\/mnt\/[a-z](\/|$)/.test(p) ? "windows" : "wsl");

export function sided(r: Roots, group: string, side: DiskSide): { group: string; side?: DiskSide } {
  if (profileOf(r) !== "wsl") return { group };
  return { group: `${group} ${side === "windows" ? "on Windows" : "in WSL"}`, side };
}

// ── cache: the fixed list ──────────────────────────────────────────────────

export interface FixedCache { rel: string; group: string; regen: string }

/** The Mac's list (`profile: "mac"`). */
export const FIXED_CACHES: readonly FixedCache[] = [
  { rel: ".gradle/caches", group: "Gradle", regen: "Gradle downloads dependencies again on the next build (a slow first build)." },
  { rel: ".gradle/wrapper/dists", group: "Gradle", regen: "Each project's gradlew downloads its Gradle version again on the next build." },
  { rel: ".gradle/daemon", group: "Gradle", regen: "Daemon logs and registry; recreated by the next build." },
  { rel: ".npm/_cacache", group: "npm", regen: "npm downloads packages again on the next install." },
  { rel: "Library/Caches/ms-playwright", group: "browser engines", regen: "`npx playwright install chromium` puts them back — this host's thumbnails and web capture need it." },
  { rel: ".cache/puppeteer", group: "browser engines", regen: "Puppeteer downloads its browser again on the next install." },
  { rel: "Library/Caches/pip", group: "Python", regen: "pip downloads wheels again on the next install." },
  { rel: "Library/Caches/node-gyp", group: "npm", regen: "Node headers are downloaded again on the next native build." },
  { rel: "Library/Caches/Homebrew", group: "Homebrew", regen: "Old downloads; brew fetches what it needs again (`brew cleanup` does the same)." },
  { rel: "Library/Caches/electron", group: "npm", regen: "Electron binaries are downloaded again on the next install." },
  { rel: "Library/Caches/claude-cli-nodejs", group: "Claude Code", regen: "Claude Code's own cache (logs); recreated as it runs." },
  { rel: "Library/Caches/BraveSoftware", group: "browser caches", regen: "The browser refills it as you browse; best done with Brave closed." },
  { rel: "Library/Caches/com.brave.Browser", group: "browser caches", regen: "The browser refills it as you browse; best done with Brave closed." },
  { rel: "Library/Caches/Google", group: "browser caches", regen: "Chrome refills it as you browse; best done with Chrome closed." },
  { rel: "Library/Caches/Firefox", group: "browser caches", regen: "Firefox refills it as you browse; best done with Firefox closed." },
];

async function isRealDir(p: string): Promise<boolean> {
  try { const s = await lstat(p); return s.isDirectory(); } catch { return false; }
}
async function exists(p: string): Promise<boolean> {
  try { await lstat(p); return true; } catch { return false; }
}

/** Linux's list, and the Linux side of wsl (XDG cache folders under ~/.cache). */
export const LINUX_CACHES: readonly FixedCache[] = [
  { rel: ".gradle/caches", group: "Gradle", regen: "Gradle downloads dependencies again on the next build (a slow first build)." },
  { rel: ".gradle/wrapper/dists", group: "Gradle", regen: "Each project's gradlew downloads its Gradle version again on the next build." },
  { rel: ".gradle/daemon", group: "Gradle", regen: "Daemon logs and registry; recreated by the next build." },
  { rel: ".npm/_cacache", group: "npm", regen: "npm downloads packages again on the next install." },
  { rel: ".cache/ms-playwright", group: "browser engines", regen: "`npx playwright install chromium` puts them back — this host's thumbnails and web capture need it." },
  { rel: ".cache/puppeteer", group: "browser engines", regen: "Puppeteer downloads its browser again on the next install." },
  { rel: ".cache/pip", group: "Python", regen: "pip downloads wheels again on the next install." },
  { rel: ".cache/node-gyp", group: "npm", regen: "Node headers are downloaded again on the next native build." },
  { rel: ".cache/electron", group: "npm", regen: "Electron binaries are downloaded again on the next install." },
  { rel: ".cache/google-chrome", group: "browser caches", regen: "Chrome refills it as you browse; best done with Chrome closed." },
  { rel: ".cache/chromium", group: "browser caches", regen: "Chromium refills it as you browse; best done with Chromium closed." },
  { rel: ".cache/BraveSoftware", group: "browser caches", regen: "The browser refills it as you browse; best done with Brave closed." },
  { rel: ".cache/mozilla", group: "browser caches", regen: "Firefox refills it as you browse; best done with Firefox closed." },
];

const BROWSER_WIN = (name: string): FixedCache[] => {
  const dir = name === "Chrome" ? "Google/Chrome" : name === "Brave" ? "BraveSoftware/Brave-Browser" : "Microsoft/Edge";
  const regen = `${name} refills it as you browse; best done with ${name} closed (a file it still holds makes the delete fail).`;
  return [
    { rel: `AppData/Local/${dir}/User Data/Default/Cache`, group: "browser caches", regen },
    { rel: `AppData/Local/${dir}/User Data/Default/Code Cache`, group: "browser caches", regen },
  ];
};

/** wsl's Windows side, relative to the Windows home. A `*` segment is one real folder per row. */
export const WIN_CACHES: readonly FixedCache[] = [
  { rel: "AppData/Local/npm-cache", group: "npm", regen: "npm on Windows downloads packages again on the next install." },
  { rel: "AppData/Local/pip/cache", group: "Python", regen: "pip on Windows downloads wheels again on the next install." },
  { rel: "AppData/Local/ms-playwright", group: "browser engines", regen: "`npx playwright install` on Windows puts them back." },
  { rel: ".gradle/caches", group: "Gradle", regen: "Gradle on Windows downloads dependencies again on the next build (a slow first build)." },
  { rel: ".gradle/wrapper/dists", group: "Gradle", regen: "Each project's gradlew downloads its Gradle version again on the next Windows build." },
  { rel: ".gradle/daemon", group: "Gradle", regen: "Daemon logs and registry; recreated by the next Windows build." },
  ...BROWSER_WIN("Chrome"), ...BROWSER_WIN("Brave"), ...BROWSER_WIN("Edge"),
  { rel: "AppData/Local/Mozilla/Firefox/Profiles/*/cache2", group: "browser caches", regen: "Firefox refills it as you browse; best done with Firefox closed (a file it still holds makes the delete fail)." },
];

/** The home-side list for this desktop's profile. */
export const cachesFor = (r: Roots): readonly FixedCache[] => (profileOf(r) === "mac" ? FIXED_CACHES : LINUX_CACHES);

/** Whether `rel` (already split, no empty/`.`/`..` segment) is `pattern`, a `*` matching any one segment. */
export function relMatches(pattern: string, rel: readonly string[]): boolean {
  const p = pattern.split("/");
  return p.length === rel.length && p.every((seg, i) => seg === "*" || seg === rel[i]);
}

/** A pattern's real paths under `base`: a `*` segment lists that folder's sub-folders (never a symlink). */
async function expand(base: string, pattern: string): Promise<string[]> {
  let paths = [base];
  for (const seg of pattern.split("/")) {
    if (seg !== "*") { paths = paths.map((p) => join(p, seg)); continue; }
    const next: string[] = [];
    for (const p of paths) {
      let ents;
      try { ents = await readdir(p, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) if (e.isDirectory()) next.push(join(p, e.name));
    }
    paths = next.sort();
  }
  const out: string[] = [];
  for (const p of paths) if (await exists(p)) out.push(p);
  return out;
}

/** Every fixed cache that exists (a symlink too — `safeToRemove` is what refuses it, with words). */
export async function resolveCaches(r: Roots): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const c of cachesFor(r)) {
    const path = join(r.home, c.rel);
    if (!(await exists(path))) continue;
    out.push({ id: idOf("cache", path), category: "cache", kind: "temp", ...sided(r, c.group, "wsl"), label: tilde(path, r.home), path, regen: c.regen });
  }
  return out;
}

/** wsl: every Windows-side fixed cache that exists; none without a Windows home. */
export async function resolveWinCaches(r: Roots): Promise<Candidate[]> {
  const win = winHomeOf(r);
  if (!win) return [];
  const out: Candidate[] = [];
  for (const c of WIN_CACHES) {
    for (const path of await expand(win, c.rel)) {
      out.push({ id: idOf("wcache", path), category: "wcache", kind: "temp", ...sided(r, c.group, "windows"), label: driveForm(path), path, regen: c.regen });
    }
  }
  return out;
}

// ── build + node_modules: one walk of the code root ────────────────────────

export const BUILD_NAMES: ReadonlySet<string> = new Set(["build", ".next", ".turbo", ".vite"]);
const MANIFESTS = ["package.json", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];
const NEVER_DESCEND = new Set([".git", "node_modules", ".gradle", ".Trash"]);

export interface Walk { build: string[]; nodeModules: string[]; stopped: boolean; outsideGit: number }

/**
 * Walk the code root: build output folders (not descended into) and node_modules folders (never
 * descended into). Bounded by depth and by a folder budget, yielding as it goes — this runs in the
 * process pumping every PTY. Symlinks are never followed.
 */
export async function walkRoot(r: Roots): Promise<Walk> {
  const build: string[] = [];
  const nodeModules: string[] = [];
  let opened = 0;
  let stopped = false;
  const queue: { dir: string; depth: number }[] = [{ dir: r.root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (opened >= r.walkBudget) { stopped = true; break; }
    opened++;
    if (opened % 200 === 0) await tick();
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    const hasManifest = manifestIn(ents.map((e) => e.name));
    for (const e of ents) {
      if (!e.isDirectory()) continue; // a symlink is not a directory entry here: never followed
      const p = join(dir, e.name);
      if (e.name === "node_modules") { nodeModules.push(p); continue; }
      if (BUILD_NAMES.has(e.name) && hasManifest) { build.push(p); continue; }
      if (NEVER_DESCEND.has(e.name)) continue;
      if (depth + 1 < r.walkDepth) queue.push({ dir: p, depth: depth + 1 });
    }
  }
  const ignored = await pool(build, r.concurrency, (p) => gitIgnored(r, p));
  const kept = build.filter((_, i) => ignored[i]);
  return { build: kept, nodeModules, stopped, outsideGit: build.length - kept.length };
}

const manifestIn = (names: readonly string[]): boolean => MANIFESTS.some((m) => names.includes(m));

/** Build output is ignored by git; a `build/` git tracks (an electron-builder resources folder) is source. */
async function gitIgnored(r: Roots, p: string): Promise<boolean> {
  const res = await run(r.gitBin, ["-C", dirname(p), "check-ignore", "-q", "--", basename(p)], { timeoutMs: 15_000 });
  return res.code === 0;
}

/**
 * ONE path checked the way `walkRoot` would have found it, without walking the code root — the
 * fresh recompute a build-output delete runs (on a Windows-drive code root a walk takes many
 * minutes). The path must be under the code root within the walk's depth, reached only through
 * folders the walk descends into (no `node_modules`, `.git`, `.gradle`, `.Trash`, and no build
 * output folder above it), named like build output, a real folder (not a link) next to a manifest,
 * and ignored by git. Null candidate with the sentence why otherwise.
 */
export async function recheckBuild(r: Roots, path: string): Promise<{ c: Candidate | null; why?: string }> {
  const no = (why: string) => ({ c: null, why: `${path}: ${why}` });
  if (!isAbsolute(path)) return no("not an absolute path");
  if (path.split(sep).some((seg) => seg === ".." || seg === ".")) return no("not a plain path");
  const relText = relative(r.root, path);
  if (!relText || relText.startsWith("..") || isAbsolute(relText)) return no(`outside ${r.root}`);
  const rel = relText.split(sep);
  if (rel.some((s) => s === ".." || s === "." || s === "")) return no(`not a plain path under ${r.root}`);
  if (rel.length > r.walkDepth) return no("deeper than the code-root walk looks");
  if (!BUILD_NAMES.has(rel.at(-1)!)) return no("not named like build output");
  for (let i = 0; i < rel.length - 1; i++) {
    const seg = rel[i]!;
    if (seg === "node_modules" || NEVER_DESCEND.has(seg)) return no(`inside ${seg}, which the walk never opens`);
    if (BUILD_NAMES.has(seg)) {
      let names: string[] = [];
      try { names = await readdir(join(r.root, ...rel.slice(0, i))); } catch { /* unreadable: not a manifest */ }
      if (manifestIn(names)) return no("inside another build output folder");
    }
  }
  let st;
  try { st = await lstat(path); } catch { return no("no longer there"); }
  if (st.isSymbolicLink() || !st.isDirectory()) return no("not a real folder");
  let names: string[] = [];
  try { names = await readdir(dirname(path)); } catch { /* unreadable: no manifest */ }
  if (!manifestIn(names)) return no("no package.json, build.gradle or settings.gradle beside it");
  if (!(await gitIgnored(r, path))) return no("not ignored by git");
  return { c: buildCandidates(r, { build: [path], nodeModules: [], stopped: false, outsideGit: 0 })[0]! };
}

/** `p` is `base` or inside it, lexically. */
const within = (base: string, p: string): boolean => { const t = relative(base, p); return !t.startsWith("..") && !isAbsolute(t); };

/** wsl: a path whose bytes are on the Windows drive — under a /mnt drive, or under the Windows home. */
export function onWindowsDrive(r: Roots, p: string): boolean {
  if (profileOf(r) !== "wsl") return false;
  const win = winHomeOf(r);
  return sideOfPath(p) === "windows" || (win != null && within(win, p));
}

/**
 * The code-root walk runs only on a tap: on wsl with the code root on the Windows drive, where
 * reading folders through WSL's drvfs is slow enough that one walk of a real code root took 29 min.
 */
export const codeOnTap = (r: Roots): boolean => onWindowsDrive(r, r.root);

export const BUILD_REGEN = "The next build writes it again.";

export function buildCandidates(r: Roots, w: Walk): Candidate[] {
  return w.build.map((path) => ({ id: idOf("build", path), category: "build", kind: "temp", ...sided(r, "build output", sideOfPath(path)), label: sideOfPath(path) === "windows" ? driveForm(path) : tilde(path, r.home), path, regen: BUILD_REGEN }));
}

export function nodeModulesEntries(r: Roots, w: Walk): Candidate[] {
  return w.nodeModules.map((path) => ({
    id: idOf("nm", path), category: "nm", kind: "show", ...sided(r, "node_modules", sideOfPath(path)), label: sideOfPath(path) === "windows" ? driveForm(path) : tilde(path, r.home), path,
    regen: "`npm ci` in that folder puts it back; delete it by hand only in a checkout you are not using.",
  }));
}

// ── tmp: claude scratchpads untouched for a day ────────────────────────────

/** The newest mtime anywhere under `dir`, or null when the folder has more than `budget` entries (then it is not "old"). */
export async function newestMtime(dir: string, budget = 5000): Promise<number | null> {
  let newest = 0, seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let st;
    try { st = await lstat(d); } catch { continue; }
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory()) continue;
    let ents;
    try { ents = await readdir(d, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      if (++seen > budget) return null;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { newest = Math.max(newest, (await lstat(p)).mtimeMs); } catch { /* gone */ } }
    }
  }
  return newest;
}

/** The session folders (`<tmpRoot>/<project>/<session>`) where nothing changed for `tmpMinAgeMs`. */
export async function oldScratchpads(r: Roots): Promise<string[]> {
  const out: string[] = [];
  let projects;
  try { projects = await readdir(r.tmpRoot, { withFileTypes: true }); } catch { return out; }
  const cutoff = r.now() - r.tmpMinAgeMs;
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let sessions;
    try { sessions = await readdir(join(r.tmpRoot, p.name), { withFileTypes: true }); } catch { continue; }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      const dir = join(r.tmpRoot, p.name, s.name);
      const newest = await newestMtime(dir);
      if (newest != null && newest < cutoff) out.push(dir);
    }
    await tick();
  }
  return out.sort();
}

export const TMP_KEY = "claude-scratchpads";

export async function resolveTmp(r: Roots): Promise<Candidate[]> {
  const members = await oldScratchpads(r);
  if (!members.length) return [];
  return [{
    id: idOf("tmp", TMP_KEY), category: "tmp", kind: "temp", ...sided(r, "scratchpads", "wsl"), label: `${tilde(r.tmpRoot, r.home)} — sessions idle over a day`,
    members, regen: "Scratch folders of Claude Code sessions where nothing changed for a day; a live session would have touched its own.",
    note: `${members.length} session folder${members.length === 1 ? "" : "s"}`,
  }];
}

// ── wtemp: the Windows %TEMP%, entries untouched for a week (wsl only) ─────

export const winTempDir = (win: string): string => join(win, "AppData", "Local", "Temp");
/** How many %TEMP% entries one scan looks at; past it the row says so. */
export const WIN_TEMP_MAX = 3000;
export const WIN_TEMP_KEY = "windows-temp";

/** Entries directly under %TEMP% (files and folders, never a symlink) where nothing changed for a week. */
export async function oldWinTemp(r: Roots): Promise<{ members: string[]; capped: boolean }> {
  const win = winHomeOf(r);
  if (!win) return { members: [], capped: false };
  const dir = winTempDir(win);
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return { members: [], capped: false }; }
  const cutoff = r.now() - r.winTempMinAgeMs;
  const capped = ents.length > WIN_TEMP_MAX;
  const out: string[] = [];
  let i = 0;
  for (const e of ents.slice(0, WIN_TEMP_MAX)) {
    if (++i % 100 === 0) await tick();
    if (e.isSymbolicLink() || !(e.isDirectory() || e.isFile())) continue;
    const p = join(dir, e.name);
    const newest = await newestMtime(p);
    if (newest != null && newest < cutoff) out.push(p);
  }
  return { members: out.sort(), capped };
}

export async function resolveWinTemp(r: Roots): Promise<Candidate[]> {
  const win = winHomeOf(r);
  if (!win) return [];
  const { members, capped } = await oldWinTemp(r);
  if (!members.length) return [];
  return [{
    id: idOf("wtemp", WIN_TEMP_KEY), category: "wtemp", kind: "temp", ...sided(r, "temporary files", "windows"),
    label: `${driveForm(winTempDir(win))} — untouched for a week`, members,
    regen: "Leftover temporary files of Windows programs where nothing changed for a week. One a running program still holds is skipped, not forced.",
    note: `${members.length} item${members.length === 1 ? "" : "s"}${capped ? ` (only the first ${WIN_TEMP_MAX} in the folder were looked at)` : ""}`,
  }];
}

// ── hf: Hugging Face hub models ────────────────────────────────────────────

export const hfHub = (r: Roots): string => join(r.home, ".cache", "huggingface", "hub");

export async function resolveHf(r: Roots): Promise<Candidate[]> {
  const hub = hfHub(r);
  let ents;
  try { ents = await readdir(hub, { withFileTypes: true }); } catch { return []; }
  const out: Candidate[] = [];
  for (const e of ents) {
    if (!e.name.startsWith("models--")) continue;
    const path = join(hub, e.name);
    let mtime: number | null = null;
    try { mtime = (await lstat(path)).mtimeMs; } catch { continue; }
    const label = e.name.slice("models--".length).replace(/--/g, "/");
    out.push({ id: idOf("hf", path), category: "hf", kind: "model", ...sided(r, "Hugging Face", "wsl"), label, path, mtime, regen: "Downloaded again the next time something loads this model." });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ── ollama ─────────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** "18 GB" → KiB, ollama's decimal units; null when it does not parse. */
export function ollamaSizeKb(text: string): number | null {
  const m = /^([\d.]+)\s*([KMGT]?B)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]), u = UNITS[m[2]!.toUpperCase()];
  return Number.isFinite(n) && u ? Math.round((n * u) / 1024) : null;
}

export interface OllamaRow { name: string; id: string; size: string; modified: string }

/** `ollama list`'s table, columns split on runs of 2+ spaces. A row that does not have them is dropped. */
export function parseOllamaList(out: string): OllamaRow[] {
  const rows: OllamaRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim() || /^NAME\s/.test(line)) continue;
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 3) continue;
    const [name, id, size, modified = ""] = cols as [string, string, string, string?];
    if (!/^[0-9a-f]{6,}$/i.test(id)) continue;
    rows.push({ name, id, size, modified });
  }
  return rows;
}

/** An ollama tag safe to hand to `ollama rm` as one argv element. */
export const OLLAMA_NAME_RE = /^[A-Za-z0-9][\w.\-:/]{0,199}$/;

export async function resolveOllama(r: Roots): Promise<{ list: Candidate[]; note: string | null }> {
  if (!r.ollamaBin) return { list: [], note: null };
  const res = await run(r.ollamaBin, ["list"], { timeoutMs: 20_000 });
  if (res.code !== 0) {
    const why = res.timedOut ? "it did not answer within 20 s" : (res.stderr.trim().split("\n").at(-1) || res.error || `exit ${res.code}`);
    return { list: [], note: `ollama models are not listed: \`ollama list\` failed — ${why}` };
  }
  const rows = parseOllamaList(res.stdout).filter((x) => OLLAMA_NAME_RE.test(x.name));
  const byId = new Map<string, string[]>();
  for (const x of rows) byId.set(x.id, [...(byId.get(x.id) ?? []), x.name]);
  const list = rows.map((x): Candidate => {
    const twins = (byId.get(x.id) ?? []).filter((n) => n !== x.name);
    const shared = twins.length
      ? `Same ID as ${twins.join(", ")}: one copy on disk — deleting this tag frees nothing until ${twins.length === 1 ? "that one goes" : "those go"} too.`
      : "";
    return {
      id: idOf("ollama", x.name), category: "ollama", kind: "model", ...sided(r, "Ollama", "wsl"), label: x.name, ollamaName: x.name, ollamaId: x.id,
      sizeText: x.size, regen: `\`ollama pull ${x.name}\` downloads it again.`,
      note: [x.modified ? `modified ${x.modified}` : "", shared].filter(Boolean).join(" · "),
    };
  });
  return { list, note: null };
}

// ── show-only ──────────────────────────────────────────────────────────────

/** wsl: the distros' virtual disks (`ext4.vhdx`), found in the two places WSL keeps them, bounded. */
export async function wslDisks(win: string): Promise<string[]> {
  const out: string[] = [];
  const look = async (parent: string, tail: string[]) => {
    let ents;
    try { ents = await readdir(parent, { withFileTypes: true }); } catch { return; }
    for (const e of ents.slice(0, 600)) {
      if (!e.isDirectory()) continue;
      const p = join(parent, e.name, ...tail);
      try { if ((await lstat(p)).isFile()) out.push(p); } catch { /* not this one */ }
    }
  };
  await look(join(win, "AppData/Local/Packages"), ["LocalState", "ext4.vhdx"]);
  await look(join(win, "AppData/Local/wsl"), ["ext4.vhdx"]);
  return out.sort();
}

/** The compact instruction for a WSL virtual disk, naming this distro when it is known. */
export function compactHow(distro: string | null | undefined): string {
  const d = distro && /^[\w.\-]{1,64}$/.test(distro) ? distro : "<distro>";
  return `This file only grows: space freed inside WSL comes back to Windows only after it is compacted. Simplest, once: \`wsl --manage ${d} --set-sparse true\` in Windows PowerShell, and it shrinks by itself from then on. Or by hand: \`wsl --shutdown\`, then \`Optimize-VHD -Path <this file> -Mode Full\` (Hyper-V), or diskpart's \`compact vdisk\`.`;
}

export async function showOnly(r: Roots): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const prof = profileOf(r);
  const add = async (path: string, group: string, regen: string, label?: string, side: DiskSide = "wsl") => {
    if (!(await isRealDir(path))) return;
    out.push({ id: idOf("show", path), category: "show", kind: "show", ...sided(r, group, side), label: label ?? (side === "windows" ? driveForm(path) : tilde(path, r.home)), path, regen });
  };
  const images = join(r.androidSdk, "system-images");
  try {
    const ents = (await readdir(images, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const n of ents) {
      const api = /^android-(.+)$/.exec(n)?.[1];
      await add(join(images, n), "Android system images", "Remove unused ones in Android Studio's SDK Manager (or `sdkmanager --uninstall`); an emulator using it stops booting.", api ? `API ${api} — ${tilde(join(images, n), r.home)}` : undefined);
    }
  } catch { /* no SDK */ }
  if (prof === "mac") await add(join(r.home, "Library/Developer/CoreSimulator"), "Xcode", "`xcrun simctl delete unavailable` drops simulators of runtimes that are gone.");
  await add(join(r.home, ".claude/projects"), "Claude Code", "Every conversation's log — what resume, the token statistics and the archive read. Not regenerable.");
  await add(join(r.home, "Downloads"), "your files", prof === "mac" ? "Your own downloads: look through them in Finder." : "Your own downloads: look through them in a file manager.");
  await add(join(r.home, ".ollama"), "Ollama", "All ollama models together — delete single tags in the models list above.");
  if (prof === "mac") {
    await add(join(r.home, "Library/Containers/com.docker.docker/Data"), "Docker", "`docker system prune` (and `docker volume prune`) frees images and volumes nobody uses.");
    await add(join(r.home, ".orbstack"), "Docker", "OrbStack's data: prune images and volumes from inside it.");
    // Not ~/Library/Group Containers/*.dev.orbstack: macOS guards other apps' group containers, and
    // measuring one hung du for the full 120 s here (a permission prompt on the desktop, likely).
  } else {
    // Rootless Docker's data; an unreadable one (a root-owned install) is simply not listed.
    const docker = join(r.home, ".local/share/docker");
    if (await readable(docker)) await add(docker, "Docker", "`docker system prune` (and `docker volume prune`) frees images and volumes nobody uses.");
  }
  const win = winHomeOf(r);
  if (win) {
    for (const vhdx of await wslDisks(win)) {
      out.push({ id: idOf("show", vhdx), category: "show", kind: "show", ...sided(r, "WSL's virtual disk", "windows"), label: driveForm(vhdx), path: vhdx, regen: compactHow(r.wslDistro) });
    }
    await add(join(win, "AppData/Local/Docker/wsl"), "Docker", "Docker Desktop's disks: `docker system prune` frees images and volumes nobody uses; the disk file itself shrinks only when Docker Desktop compacts it (Troubleshoot › Clean / Purge data).", undefined, "windows");
    await add(join(win, "Downloads"), "your files", "Your own Windows downloads: look through them in Explorer.", undefined, "windows");
  }
  return out;
}

async function readable(p: string): Promise<boolean> {
  try { await readdir(p); return true; } catch { return false; }
}

/** The folders the large-file find skips because a list above already covers them. */
export function coveredPaths(r: Roots): string[] {
  if (profileOf(r) !== "mac") {
    const win = winHomeOf(r);
    return [
      ...LINUX_CACHES.map((c) => join(r.home, c.rel)),
      hfHub(r), join(r.home, ".ollama"), join(r.androidSdk, "system-images"), join(r.home, ".local/share/docker"), join(r.home, ".local/share/Trash"),
      // -xdev already keeps the find off /mnt (another filesystem); pruned by name as well.
      ...(profileOf(r) === "wsl" ? ["/mnt", ...(win ? [win] : [])] : []),
    ];
  }
  return [
    ...FIXED_CACHES.map((c) => join(r.home, c.rel)),
    hfHub(r), join(r.home, ".ollama"), join(r.androidSdk, "system-images"), join(r.home, "Library/Developer/CoreSimulator"),
    join(r.home, "Library/Containers/com.docker.docker"), join(r.home, ".orbstack"),
    join(r.home, "Library/Mobile Documents"), join(r.home, ".Trash"),
    // Other apps' data: macOS may stop the find on a permission prompt nobody at the phone can answer.
    join(r.home, "Library/Containers"), join(r.home, "Library/Group Containers"),
  ];
}

// ── the containment check every delete passes, at scan time and again at delete time ──

/** Which anchor a deletable category is held inside, and the shape its relative path must have. */
function anchorOf(c: Candidate, r: Roots, path: string): { base: string; shapeOk: (rel: string[]) => boolean; fileOk?: boolean } | null {
  const win = winHomeOf(r);
  switch (c.category) {
    case "cache": return { base: r.home, shapeOk: (rel) => cachesFor(r).some((f) => relMatches(f.rel, rel)) };
    case "wcache": return win ? { base: win, shapeOk: (rel) => WIN_CACHES.some((f) => relMatches(f.rel, rel)) } : null;
    // A %TEMP% entry may be a file: the one category where a non-folder is deleted.
    // Anchored at the Windows home like wcache, so a link at AppData, Local or Temp refuses too.
    case "wtemp": return win ? { base: win, shapeOk: (rel) => rel.length === 4 && rel.slice(0, 3).join("/") === "AppData/Local/Temp", fileOk: true } : null;
    case "hf": return { base: r.home, shapeOk: (rel) => rel.length === 4 && rel.slice(0, 3).join("/") === ".cache/huggingface/hub" && rel[3]!.startsWith("models--") };
    case "build": return { base: r.root, shapeOk: (rel) => rel.length >= 2 && BUILD_NAMES.has(rel.at(-1)!) };
    // Anchored at the folder holding tmpRoot, so tmpRoot itself must be a real folder (in a shared /tmp another user can plant a link there).
    case "tmp": return { base: dirname(r.tmpRoot), shapeOk: (rel) => rel.length === 3 && rel[0] === basename(r.tmpRoot) };
    default: void path; return null;
  }
}

/**
 * Null when `path` may be removed as a `c.category` candidate, else the sentence why not. The path
 * must be absolute and lexically inside its anchor with the category's shape, must not be a symlink,
 * and its REALPATH must be exactly the anchor's realpath joined with the same relative path — so a
 * symlink anywhere between the anchor and the leaf (or a swapped-in one since the scan) refuses.
 */
export async function safeToRemove(c: Candidate, r: Roots, path: string): Promise<string | null> {
  const a = anchorOf(c, r, path);
  if (!a) return `${c.label}: this kind of entry has no delete path`;
  if (!isAbsolute(path)) return `${c.label}: not an absolute path`;
  const relText = relative(a.base, path);
  if (!relText || relText.startsWith("..") || isAbsolute(relText)) return `${c.label}: outside ${a.base}`;
  const rel = relText.split(sep);
  if (rel.some((s) => s === ".." || s === "." || s === "")) return `${c.label}: not a plain path under ${a.base}`;
  if (!a.shapeOk(rel)) return `${c.label}: not a ${c.category} path this extension deletes`;
  let st;
  try { st = await lstat(path); } catch { return `${c.label}: no longer there`; }
  if (st.isSymbolicLink()) return `${c.label}: is a symlink — refusing to follow it`;
  if (!st.isDirectory() && !(a.fileOk && st.isFile())) return `${c.label}: not a folder`;
  let real: string, base: string;
  try { real = await realpath(path); base = await realpath(a.base); } catch { return `${c.label}: its real location could not be read`; }
  if (real !== join(base, ...rel)) return `${c.label}: resolves to ${real}, outside where it should be — refusing`;
  if (c.category === "tmp") {
    // A real folder planted by another user is as bad as a link: they could swap a session folder for a link while we delete.
    // So the scratchpad root must be ours and closed to anyone else (a group that is only our own, as on a private-group distro, is fine).
    let rs;
    try { rs = await lstat(r.tmpRoot); } catch { return `${c.label}: no longer there`; }
    const uid = process.getuid?.(), gid = process.getgid?.();
    if (uid !== undefined && rs.uid !== uid) return `${c.label}: ${r.tmpRoot} belongs to another user — refusing`;
    if (rs.mode & 0o002 || (rs.mode & 0o020 && gid !== undefined && rs.gid !== gid)) return `${c.label}: ${r.tmpRoot} is writable by other users — refusing`;
  }
  return null;
}
