/**
 * What a build leaves behind — the disk half.
 *
 * `@waterplane/shared`'s `artifacts.ts` holds every RULE (what a collected file is
 * called, which two files are the same bytes, what a prune may remove) and the
 * measurement behind them. This module is what touches the filesystem: reading
 * a project's own version, linking a deliverable into `.claude/outbox/`,
 * fingerprinting two candidates, deleting the builds a prune condemned.
 *
 * Three things it deliberately does not do:
 *
 *  - **It never touches what the build wrote.** Gradle's `app-debug.apk` stays
 *    exactly where gradle put it; the outbox gets a HARD LINK to the same bytes
 *    where the filesystem allows one, so a 227 MB APK costs 227 MB, not 454 —
 *    and the link survives the next `gradle clean` that removes the original.
 *  - **It never deletes outside `.claude/outbox/`**, and inside it only files
 *    whose `familyKey` matches something this very run produced. Deletion goes
 *    through `files.ts`' `deleteArtifact`, which is the one containment guard
 *    for that directory — never a second `rmSync` with its own idea of safe.
 *  - **It never fails a build.** Every step is best-effort and SAYS what it
 *    did into the run's own output; a repo on a filesystem that refuses links,
 *    a read-only outbox or a vanished file degrades to "collected nothing",
 *    which is exactly where this feature started.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  DEFAULT_ARTIFACT_POLICY, artifactName, cleanArtifactPolicy, familyKey, foldDuplicates, inOutbox, pruneVictims,
  type ArtifactPolicy, type BuildArtifact,
  logTag,
} from "@waterplane/shared";
import { repoStateDir } from "./branddirs.js";
import { deleteArtifact, OUTBOX_SUBDIRS } from "./files.js";
import { targetId } from "./repos.js";
import { writeJsonAtomic } from "./jsonstore.js";

/** Where a collected artifact goes. The first of `files.ts`' outbox dirs is the
 *  canonical one — `.outbox` is only recognised for reading. */
const OUTBOX = OUTBOX_SUBDIRS[0];

/** How much of a file is hashed to decide two paths hold the same bytes: the
 *  first and last 64 KB, plus the size. Reading 227 MB twice to answer a
 *  question about a name would cost more than the duplicate download it saves;
 *  a head+tail hash of an APK (a zip — its central directory is in the tail)
 *  is conclusive in every case this has to tell apart. */
const FINGERPRINT_BYTES = 64 * 1024;

/** The policy file, beside `builds.json` and `autopull.json` for the same
 *  reason those are there: how a project names and keeps its deliverables is a
 *  property of the project. */
function policyPath(repoDir: string): string { return join(repoStateDir(repoDir), "artifacts.json"); }

/** This repo's policy (the defaults when there is no file — the feature is on
 *  by default, see `DEFAULT_ARTIFACT_POLICY`). */
export function artifactPolicy(repoDir: string): ArtifactPolicy {
  try {
    return cleanArtifactPolicy(JSON.parse(readFileSync(policyPath(repoDir), "utf8")));
  } catch {
    return { ...DEFAULT_ARTIFACT_POLICY };
  }
}

/** Persist a repo's policy; returns what was actually written. */
export function saveArtifactPolicy(repoDir: string, p: ArtifactPolicy): ArtifactPolicy {
  const clean = cleanArtifactPolicy(p);
  try {
    const path = policyPath(repoDir);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, clean, { space: 2 });
  } catch { /* best-effort — an unwritable repo just doesn't remember the policy */ }
  return clean;
}

/**
 * The project's own version, if it says one anywhere this can read cheaply.
 *
 * Four manifests, in the order that answers first for the repos here: Flutter
 * (`pubspec.yaml`), node (`package.json`), Gradle (`versionName` + optional
 * `versionCode`, both android modules and the root), and Cargo. Everything is
 * a plain regex over at most a few KB — nothing is executed, and a manifest
 * that does not parse is simply not an answer.
 *
 * Absent is a normal outcome, not a failure: the name falls back to the git
 * sha, and then to the clock.
 */
export function projectVersion(repoDir: string): string | undefined {
  const read = (rel: string): string | null => {
    try {
      const full = join(repoDir, rel);
      if (!existsSync(full) || statSync(full).size > 256 * 1024) return null;
      return readFileSync(full, "utf8");
    } catch { return null; }
  };
  const pubspec = read("pubspec.yaml");
  const pubv = pubspec?.match(/^version:\s*([0-9][^\s#]*)/m)?.[1];
  if (pubv) return pubv;

  const pkg = read("package.json");
  if (pkg) {
    try {
      const v = JSON.parse(pkg).version;
      if (typeof v === "string" && /\d/.test(v)) return v;
    } catch { /* a package.json that doesn't parse is not a version */ }
  }
  for (const g of ["app/build.gradle", "app/build.gradle.kts", "android/app/build.gradle", "android/app/build.gradle.kts", "build.gradle", "build.gradle.kts"]) {
    const text = read(g);
    if (!text) continue;
    const name = text.match(/versionName\s*[=\s]\s*["']([^"']+)["']/)?.[1];
    const code = text.match(/versionCode\s*[=\s]\s*(\d+)/)?.[1];
    if (name) return code ? `${name}+${code}` : name;
    if (code) return code;
  }
  const cargo = read("Cargo.toml");
  const cv = cargo?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (cv) return cv;
  return undefined;
}

/** The commit this was built from, short, `-dirty` when the tree was not clean.
 *  A repo that is not a git checkout simply has no sha to offer. */
export function gitStamp(repoDir: string): string | undefined {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return null; }
  };
  const sha = git(["rev-parse", "--short=8", "HEAD"]);
  if (!sha) return undefined;
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  return dirty ? `${sha}-dirty` : sha;
}

/** Size + a hash of the first and last 64 KB. Absent when the file cannot be
 *  read, which means "never folded with anything" — a fold that cannot be
 *  justified must not be made. */
function fingerprint(full: string, size: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(full, "r");
    const h = createHash("sha1");
    const buf = Buffer.alloc(Math.min(FINGERPRINT_BYTES, Math.max(size, 1)));
    const head = readSync(fd, buf, 0, buf.length, 0);
    h.update(buf.subarray(0, head));
    if (size > FINGERPRINT_BYTES) {
      const tail = readSync(fd, buf, 0, Math.min(FINGERPRINT_BYTES, size), Math.max(0, size - FINGERPRINT_BYTES));
      h.update(buf.subarray(0, tail));
    }
    return h.digest("hex").slice(0, 16);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * Put a copy of `from` at `to`, as cheaply as the filesystem allows.
 *
 * `COPYFILE_FICLONE` asks for a copy-on-write clone (APFS here, btrfs/xfs
 * elsewhere) and silently falls back to a real copy where the filesystem has
 * no such thing — so a 227 MB APK usually costs no extra bytes until something
 * diverges, and always costs at most one copy.
 *
 * A HARD LINK would be cheaper still and is wrong, which this learned the
 * expensive way: `flutter build`, `cp -f` and `printf >` all rewrite their
 * output IN PLACE, and a link means that rewrite lands inside the artifact
 * already collected from the PREVIOUS build. The whole point of keeping the
 * last three is that they are the last three, not three names for whatever the
 * newest build most recently wrote.
 */
function place(from: string, to: string): boolean {
  try { copyFileSync(from, to, constants.COPYFILE_FICLONE); return true; } catch { /* fall through */ }
  try { copyFileSync(from, to); return true; } catch { return false; }
}

/** `name.apk` → `name_2.apk` → `name_3.apk`. The `_N` spelling is files.ts's
 *  uniquifier and `familyKey` folds it, so a collision is still the same
 *  artifact for the prune and for the phone's download queue. */
function freeName(dir: string, wanted: string): string {
  const ext = extname(wanted);
  const stem = wanted.slice(0, wanted.length - ext.length);
  if (!existsSync(join(dir, wanted))) return wanted;
  for (let i = 2; i < 100; i++) {
    const n = `${stem}_${i}${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
  return `${stem}_${Date.now()}${ext}`;
}

/** Every file currently in the repo's outbox, with its clock — what a prune
 *  chooses its victims from. */
function outboxFiles(repoDir: string): { relPath: string; mtime: number }[] {
  const dir = join(repoDir, ...OUTBOX.split("/"));
  const out: { relPath: string; mtime: number }[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    try { out.push({ relPath: `${OUTBOX}/${e.name}`, mtime: statSync(join(dir, e.name)).mtimeMs }); } catch { /* gone */ }
  }
  return out;
}

/**
 * Collect, name, fold and prune what a run produced.
 *
 * Returns the artifact list the run should REPORT — which is the point as much
 * as the disk changes are: after this, "the build produced this" and "this is
 * what the phone is offered" are the same list, with one entry per artifact
 * rather than one per path the same bytes happen to sit at.
 *
 * `say` receives one line per action, already newline-terminated for a PTY, and
 * it is the only account of this a person gets — a file that appears in the
 * outbox and an older one that stops existing must both be sentences somebody
 * can read afterwards.
 */
export function collectArtifacts(
  repoDir: string,
  artifacts: BuildArtifact[],
  policy: ArtifactPolicy,
  say: (line: string) => void,
  now: Date = new Date(),
): BuildArtifact[] {
  if (!artifacts.length) return artifacts;
  const root = resolve(repoDir);
  const repoId = targetId(repoDir);

  // ── 1. the same bytes under two names are ONE artifact ──────────────────
  const fps = artifacts.map((a) => {
    const full = join(root, ...a.relPath.split("/"));
    return { ...a, fingerprint: fingerprint(full, a.size) };
  });
  const { kept, folded } = foldDuplicates(fps);
  for (const f of folded) {
    for (const d of f.dropped) say(`${logTag} same file twice: ${d.relPath} is ${f.kept.relPath} — offering it once\r\n`);
  }
  if (!policy.collect) return kept.map(({ fingerprint: _fp, ...a }) => a);

  // ── 2. everything that is not already where a person looks, collected ───
  const outDir = join(root, ...OUTBOX.split("/"));
  try { mkdirSync(outDir, { recursive: true }); } catch { /* handled by the place() below failing */ }
  const version = projectVersion(repoDir);
  const sha = gitStamp(repoDir);
  const repoName = basename(root);
  const out: BuildArtifact[] = [];
  const produced: string[] = [];
  for (const a of kept) {
    const { fingerprint: _fp, ...art } = a;
    if (inOutbox(art.relPath) || art.stale) {
      // Already where it belongs — or a file this run did not write, which must
      // not be copied anywhere under a name claiming this build made it.
      out.push(art);
      if (inOutbox(art.relPath) && !art.stale) produced.push(art.relPath);
      continue;
    }
    const ext = extname(art.name).toLowerCase();
    const wanted = artifactName({ repoName, stem: art.name.slice(0, art.name.length - ext.length), ext, version, sha, when: now });
    const name = freeName(outDir, wanted);
    const placed = place(join(root, ...art.relPath.split("/")), join(outDir, name));
    if (!placed) {
      say(`${logTag} could not collect ${art.relPath} into ${OUTBOX} — offering it where it is\r\n`);
      out.push(art);
      continue;
    }
    const relPath = `${OUTBOX}/${name}`;
    let mtime = art.mtime;
    try { mtime = statSync(join(outDir, name)).mtimeMs; } catch { /* keep the source's clock */ }
    say(`${logTag} artifact: ${relPath} (from ${art.relPath})\r\n`);
    out.push({ repoId, name, relPath, size: art.size, mtime });
    produced.push(relPath);
  }

  // ── 3. older builds of exactly what was just produced ───────────────────
  if (policy.prune && produced.length) {
    const victims = pruneVictims(outboxFiles(repoDir), produced, policy.keep);
    for (const v of victims) {
      if (deleteArtifact(root, v.relPath)) say(`${logTag} removed older build: ${v.relPath} (keeping the newest ${policy.keep})\r\n`);
    }
  }
  return out;
}

/** Re-exported so a caller does not have to know which module owns which half. */
export { familyKey };
