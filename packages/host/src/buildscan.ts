/**
 * The disk half of "what can this repo already build?".
 *
 * Walks a worktree for the files that DESCRIBE builds — manifests, CI
 * workflows, shell scripts — and hands their text to `@waterplane/shared`'s
 * `scanCandidates`, which owns every rule about what may be suggested. Nothing
 * is executed, nothing is written, and no command is ever probed for existence
 * by running it: a candidate's evidence is that somebody wrote it down in this
 * repo.
 *
 * ── The walk is bounded in three directions, on purpose ────────────────────
 *
 * This runs on a WebSocket frame from a phone, in the same process that is
 * pumping every live PTY, so an unbounded walk of a monorepo with a
 * `node_modules` in every package is an outage for every session. Hence a depth
 * cap, a directory cap and a file-size cap, and `SKIP_DIRS` pruned before
 * descending rather than after reading. Measured on this repo: 4 ms.
 *
 * A truncated walk is still an honest answer — the candidates it found are real
 * — so hitting a cap degrades to a shorter list, never to an error and never to
 * a guess about what was not looked at. It is the same rule the heuristics
 * follow: absent beats wrong.
 *
 * `readsInline`-style extension lists live in one place per side; this one is
 * `MANIFESTS`, and every name in it has a reader in `shared/buildscan.ts`.
 * Adding a name here without adding its reader there produces a file that is
 * read, parsed by nobody and quietly ignored — the two lists widen together.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { BuildCandidate, BuildConfig, ScannedFile } from "@waterplane/shared";
import { SKIP_DIRS, scanCandidates } from "@waterplane/shared";

/** Manifest basenames with a reader on the shared side. */
const MANIFESTS = new Set([
  "package.json", "build.gradle", "build.gradle.kts", "gradlew",
  "Makefile", "makefile", "GNUmakefile", "Cargo.toml", "go.mod",
  "pyproject.toml", "CMakeLists.txt",
]);

/** How deep below the repo root a manifest still counts as this repo's. Three
 *  covers `packages/<name>/package.json` and `apps/<name>/app/build.gradle`. */
const MAX_DEPTH = 3;
/** Directories visited before the walk stops. */
const MAX_DIRS = 400;
/** A manifest bigger than this is a generated lockfile-shaped thing, not a
 *  description of how to build; reading it would cost more than it says. */
const MAX_FILE = 256 * 1024;

function isScript(base: string): boolean {
  return /\.(sh|bash)$/.test(base);
}

/**
 * Collect the files worth reading. Returns repo-relative paths with forward
 * slashes — the shape `shared/buildscan.ts` matches its readers on, and the
 * shape a `dir` field is already stored in.
 */
function collect(repoDir: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  let dirs = 0;

  const push = (abs: string) => {
    try {
      if (statSync(abs).size > MAX_FILE) return;
      out.push({ path: relative(repoDir, abs).split(sep).join("/"), text: readFileSync(abs, "utf8") });
    } catch { /* vanished mid-walk, unreadable, or not UTF-8 — it contributes nothing */ }
  };

  const walk = (abs: string, depth: number) => {
    if (dirs++ >= MAX_DIRS) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (depth < MAX_DEPTH) walk(join(abs, e.name), depth + 1);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (MANIFESTS.has(e.name)) push(join(abs, e.name));
      // Shell scripts only where people keep them. A repo root full of
      // one-off `.sh` files is common; `scripts/` is where the ones meant to
      // be run by somebody else live, and that is the distinction worth
      // suggesting on.
      else if (isScript(e.name) && (depth === 0 || abs.endsWith(`${sep}scripts`) || abs.endsWith(`${sep}bin`))) push(join(abs, e.name));
    }
  };

  walk(repoDir, 0);

  // CI, read whatever the walk's dot-directory rule did to `.github`. It is
  // skipped above with every other dotted directory (a repo's dot-dirs are
  // tooling, not builds) and then read explicitly here, because the workflow
  // files are the single most honest description of how this project builds.
  try {
    const wf = join(repoDir, ".github", "workflows");
    for (const e of readdirSync(wf, { withFileTypes: true })) {
      if (e.isFile() && /\.ya?ml$/.test(e.name)) push(join(wf, e.name));
    }
  } catch { /* no CI here */ }

  return out;
}

/**
 * What this repo describes, as candidates for the Build sheet's editor.
 *
 * `existing` only marks rows that are already configured — it never removes
 * them (`scanCandidates` explains why).
 */
export function scanRepoBuilds(repoDir: string, existing: BuildConfig[] = []): { candidates: BuildCandidate[]; total: number } {
  return scanCandidates(collect(repoDir), existing);
}
