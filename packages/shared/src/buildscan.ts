/**
 * What this repo can already build — read out of the repo's own manifests,
 * never invented.
 *
 * ── Why this is not a model call ───────────────────────────────────────────
 *
 * The Build sheet's "set up" button spends a whole agent turn on the same
 * question, and it is the right tool for an empty sheet: it reads CI, works out
 * what the project really ships, and writes `<state dir>/builds.json`. But it costs
 * tokens, and this sheet is the thing you reach for when you HAVE no tokens.
 * Adding one more command — "same as the release APK but for the other flavour"
 * — should not have to.
 *
 * So the second answer is arithmetic over files that already exist. A
 * `package.json` script, a gradle task the Android plugin demonstrably
 * registers, a `Makefile` target, a `run:` line out of a CI workflow: each one
 * is a command SOMEBODY ALREADY WROTE DOWN in this repo. The list cannot
 * contain a task that does not exist, costs nothing, and works while
 * rate-limited — which is the state the Build sheet exists for.
 *
 * ── What it is allowed to claim ────────────────────────────────────────────
 *
 * A candidate is a SUGGESTION, and the sheet fills the editor's fields with it
 * for a person to read, edit and save. Nothing here writes a build command, and
 * no candidate is ever run by having been suggested — `cmd` reaches a shell
 * only after the ordinary Save + Run taps. That is the whole reason this is
 * allowed to be generous about what it offers: a wrong row is a row you don't
 * tap, not a build that ran.
 *
 * Two things it will not do quietly:
 *
 *  • **A command that looks like it PUBLISHES carries a note.** These commands
 *    later run with no session and nobody watching, which is exactly when a
 *    stray `ship-prod.sh` is worst. The note is a sentence on the row, not a
 *    filter — a release script is a legitimate thing to want on a phone, and
 *    silently hiding the one command somebody was looking for would send them
 *    back to typing it by hand, which is what this exists to avoid.
 *  • **It never guesses a gradle task.** `assembleRelease` is offered when the
 *    build file applies the Android application plugin, and not otherwise; a
 *    plain gradle project gets `build` and `test`, which every gradle project
 *    has. Suggesting a task that does not exist teaches people the list lies.
 *
 * Pure: the host does the walking and reading (`host/buildscan.ts`), this
 * module does the deciding, so every rule below is pinned by
 * `test/buildscan.test.mjs` with no filesystem.
 */

import { BRAND, legacyStateDirNames } from "./brand.js";

import type { BuildConfig } from "./wire/work.js";

/** One file the host read for us. `path` is repo-relative, forward slashes. */
export interface ScannedFile {
  path: string;
  text: string;
}

/** A build command this repo already describes somewhere. */
export interface BuildCandidate {
  /** Suggested button label — short, phone-sized. */
  name: string;
  /** The command line, exactly as it will be handed to the shell. */
  cmd: string;
  /** Repo-relative working sub-dir; absent = repo root. */
  dir?: string;
  /** Where it was read from, shown on the row: "package.json", ".github/workflows/ci.yml", … */
  source: string;
  /**
   * Why this one deserves a second look before it is saved — publishing,
   * deploying, tagging. Absent for the ordinary ones. A sentence, because the
   * row shows it verbatim.
   */
  note?: string;
  /** This exact cmd+dir is already a configured build here. */
  already?: boolean;
}

/** Directories that are build OUTPUT or dependencies — never scanned. The host
 *  owns the walk, but the list is here so the test can state it. */
export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
  ".gradle", ".idea", ".venv", "venv", "__pycache__", "vendor", ".next",
  ".nuxt", "Pods", "DerivedData", ".cache", "coverage", ".claude",
  // the product's own state dir, current and every past name
  BRAND.stateDirName, ...legacyStateDirNames,
]);

/** Verbs that make a command outward-facing. Matched on the whole command line. */
const PUBLISHY = /\b(publish|deploy|release|upload|push|ship|promote|notarize|testflight|npm\s+publish|gh\s+release|fastlane)\b/i;

/** A command producing a file you can download beats one that prints a verdict. */
const ARTIFACTY = /\b(assemble|bundle|package|dist|archive|apk|aab|ipa|wheel|sdist|installer|dmg|zip|tar|jar|binary|compile|build)\b/i;

/** Everyday checks — worth offering, ranked under the things that make a file. */
const CHECKY = /\b(test|lint|typecheck|tsc|check|spec|audit|format|fmt|clippy|vet)\b/i;

/** npm scripts that exist in every scaffold and are nobody's build button. */
const NOISE_SCRIPTS = new Set(["prepare", "preinstall", "postinstall", "prepublishonly", "prepack", "postpack"]);

const publishNote = (cmd: string): string | undefined =>
  PUBLISHY.test(cmd)
    ? "reads like it publishes or deploys — a build button runs with nobody watching, so check this one before you save it"
    : undefined;

function dirOf(path: string): string | undefined {
  const i = path.lastIndexOf("/");
  return i < 0 ? undefined : path.slice(0, i);
}

/** "packages/web" + "build" → "web · build". The dir is the disambiguator in a
 *  monorepo, where four sub-packages all have a script called `build`. */
function label(dir: string | undefined, verb: string): string {
  const leaf = dir ? dir.split("/").filter(Boolean).pop() : undefined;
  return leaf ? `${leaf} · ${verb}` : verb;
}

// ── Per-manifest readers ────────────────────────────────────────────────────
// Each returns candidates for ONE file. A reader that cannot parse its file
// returns nothing: an unreadable package.json is a repo that has no scripts as
// far as this list is concerned, never a row saying so.

function fromPackageJson(f: ScannedFile): BuildCandidate[] {
  let scripts: Record<string, unknown>;
  try {
    const json = JSON.parse(f.text) as { scripts?: Record<string, unknown> };
    scripts = json.scripts ?? {};
  } catch { return []; }
  if (typeof scripts !== "object" || !scripts) return [];
  const dir = dirOf(f.path);
  const out: BuildCandidate[] = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== "string") continue;
    if (NOISE_SCRIPTS.has(name.toLowerCase())) continue;
    // `npm run x` for everything, including `test`: `npm test` and `npm run
    // test` run the same script, and one spelling means one dedupe key.
    const cmd = `npm run ${name}`;
    out.push({ name: label(dir, name), cmd, dir, source: f.path, note: publishNote(`${name} ${body}`) });
  }
  return out;
}

function fromGradle(f: ScannedFile, hasWrapper: boolean): BuildCandidate[] {
  const dir = dirOf(f.path);
  const gradle = hasWrapper ? "./gradlew" : "gradle";
  const tasks: string[] = [];
  // The Android application plugin is what registers assemble*/bundle*. A
  // library module has assemble but no bundle, and a plain JVM project has
  // neither — so the plugin line is read, not assumed.
  const app = /com\.android\.application|id\s*\(?\s*["']com\.android\.application/.test(f.text);
  const lib = /com\.android\.library|id\s*\(?\s*["']com\.android\.library/.test(f.text);
  if (app) tasks.push("assembleDebug", "assembleRelease", "bundleRelease");
  else if (lib) tasks.push("assembleDebug", "assembleRelease");
  // `build` and `test` come from the base plugin and exist in every gradle
  // project that has a build file at all.
  tasks.push("build", "test");
  return tasks.map((t) => ({
    name: label(dir, t === "assembleRelease" && app ? "Release APK" : t === "bundleRelease" ? "Release AAB" : t),
    cmd: `${gradle} ${t}`,
    dir,
    source: f.path,
  }));
}

function fromMakefile(f: ScannedFile): BuildCandidate[] {
  const dir = dirOf(f.path);
  const out: BuildCandidate[] = [];
  const seen = new Set<string>();
  for (const line of f.text.split("\n")) {
    // Target lines only: name at column 0, a colon, and not a variable
    // assignment (`FOO := bar`) or a pattern/special target (`.PHONY`, `%.o`).
    const m = /^([A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*:(?!=)/.exec(line);
    if (!m) continue;
    const t = m[1];
    if (t.startsWith(".") || t.includes("%") || seen.has(t)) continue;
    seen.add(t);
    out.push({ name: label(dir, t), cmd: `make ${t}`, dir, source: f.path, note: publishNote(t) });
  }
  return out;
}

function fromCargo(f: ScannedFile): BuildCandidate[] {
  const dir = dirOf(f.path);
  return [
    { name: label(dir, "release binary"), cmd: "cargo build --release", dir, source: f.path },
    { name: label(dir, "test"), cmd: "cargo test", dir, source: f.path },
  ];
}

function fromGoMod(f: ScannedFile): BuildCandidate[] {
  const dir = dirOf(f.path);
  return [
    { name: label(dir, "build"), cmd: "go build ./...", dir, source: f.path },
    { name: label(dir, "test"), cmd: "go test ./...", dir, source: f.path },
  ];
}

function fromPyProject(f: ScannedFile): BuildCandidate[] {
  const dir = dirOf(f.path);
  const out: BuildCandidate[] = [];
  // Poetry and the PEP-517 front end are different commands; offer the one the
  // file actually describes rather than both.
  if (/^\s*\[tool\.poetry\]/m.test(f.text)) out.push({ name: label(dir, "wheel"), cmd: "poetry build", dir, source: f.path });
  else if (/^\s*\[build-system\]/m.test(f.text)) out.push({ name: label(dir, "wheel"), cmd: "python -m build", dir, source: f.path });
  if (/pytest/.test(f.text)) out.push({ name: label(dir, "test"), cmd: "pytest", dir, source: f.path });
  return out;
}

function fromCMake(f: ScannedFile): BuildCandidate[] {
  const dir = dirOf(f.path);
  return [{
    name: label(dir, "build"),
    cmd: "cmake -S . -B build && cmake --build build",
    dir,
    source: f.path,
  }];
}

/**
 * CI is the most honest source in the repo: it is the command set somebody
 * proved works on a clean machine.
 *
 * Only single-line `run:` steps are read. A block scalar (`run: |`) is a script,
 * not a command line, and half of one pasted into a build button is worse than
 * nothing. Steps carrying `${{ … }}` are dropped for the same reason — the
 * expression is resolved by the CI runner and would reach our shell verbatim.
 */
function fromWorkflow(f: ScannedFile): BuildCandidate[] {
  const out: BuildCandidate[] = [];
  const seen = new Set<string>();
  for (const line of f.text.split("\n")) {
    const m = /^\s*-?\s*run:\s*(?!\||>)(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    let cmd = m[1].trim();
    if (/^["'].*["']$/.test(cmd)) cmd = cmd.slice(1, -1);
    if (!cmd || cmd.includes("${{") || cmd.includes("$GITHUB_")) continue;
    // `npm test` and `npm run test` are one script under two spellings, and CI
    // writes the short one while `package.json` describes the long one. Left
    // alone they are two rows for one button, which reads as the scan having
    // found two different things.
    cmd = cmd.replace(/^npm test\b/, "npm run test");
    // Plumbing every CI file has and nobody wants as a phone button. The
    // `sudo` strip is not cosmetic: `sudo apt-get install …` is exactly the
    // line this is here to drop, and matched without it, it survived.
    const bare = cmd.replace(/^sudo\s+/, "");
    if (/^(npm ci|npm install|yarn|pnpm i(nstall)?|git |echo |cd |chmod |mkdir |apt(-get)? |brew |curl |wget |docker login)/.test(bare)) continue;
    if (cmd.length > 200 || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push({ name: cmd.length <= 28 ? cmd : `${cmd.slice(0, 27)}…`, cmd, source: f.path, note: publishNote(cmd) });
  }
  return out;
}

/**
 * A shell script in the repo, offered as itself.
 *
 * This is where a monorepo's real ship commands live — `scripts/ship-betas.sh`
 * is the button somebody wants, and no manifest mentions it. The first comment
 * line of the script is its description when it has one, because `ship-betas`
 * is a filename and "ship all beta apps to Garmin" is a label.
 */
function fromScript(f: ScannedFile): BuildCandidate[] {
  const base = f.path.split("/").pop() ?? f.path;
  const stem = base.replace(/\.(sh|bash|zsh)$/, "");
  const desc = /^#!.*\n(?:#\s*(.+)\n)/.exec(f.text)?.[1]?.trim();
  const name = desc && desc.length <= 40 ? desc : stem;
  return [{
    name,
    cmd: `./${f.path}`,
    source: f.path,
    note: publishNote(`${f.path} ${desc ?? ""}`),
  }];
}

/** Which reader a file gets, by name. Unknown names are read by nobody. */
function readerFor(f: ScannedFile, wrappers: Set<string>): BuildCandidate[] {
  const base = f.path.split("/").pop() ?? f.path;
  const dir = dirOf(f.path) ?? "";
  if (base === "package.json") return fromPackageJson(f);
  if (base === "build.gradle" || base === "build.gradle.kts") return fromGradle(f, wrappers.has(dir));
  if (base === "Makefile" || base === "makefile" || base === "GNUmakefile") return fromMakefile(f);
  if (base === "Cargo.toml") return fromCargo(f);
  if (base === "go.mod") return fromGoMod(f);
  if (base === "pyproject.toml") return fromPyProject(f);
  if (base === "CMakeLists.txt") return fromCMake(f);
  if (/^\.github\/workflows\//.test(f.path) && /\.ya?ml$/.test(base)) return fromWorkflow(f);
  if (/\.(sh|bash)$/.test(base)) return fromScript(f);
  return [];
}

/** Rank: things that produce a downloadable file, then checks, then the rest —
 *  and inside each band, the shallower path first. A build button's whole point
 *  is the artifact at the end of it. */
function rank(c: BuildCandidate): number {
  const hay = `${c.name} ${c.cmd}`;
  const band = ARTIFACTY.test(hay) ? 0 : CHECKY.test(hay) ? 1 : 2;
  const depth = (c.dir ?? "").split("/").filter(Boolean).length;
  return band * 100 + Math.min(depth, 9) * 10 + (c.note ? 5 : 0);
}

/**
 * Everything this repo describes, ranked, deduped, and marked against what is
 * already configured.
 *
 * `existing` is not a filter: a build command already on the sheet still
 * appears, flagged, because the alternative is a suggest list that silently
 * shrinks as you use it and leaves you wondering whether the scan broke.
 *
 * `limit` is a cap on the LIST, not on the search — a repo with four hundred
 * npm scripts across twenty packages would otherwise hand a phone four hundred
 * rows. The count of what was cut is the caller's to say.
 */
export function scanCandidates(
  files: ScannedFile[],
  existing: BuildConfig[] = [],
  limit = 60,
): { candidates: BuildCandidate[]; total: number } {
  // Which directories have a gradle wrapper, so `./gradlew` is only suggested
  // where it exists.
  const wrappers = new Set<string>();
  for (const f of files) {
    const base = f.path.split("/").pop();
    if (base === "gradlew") wrappers.add(dirOf(f.path) ?? "");
  }

  const key = (cmd: string, dir?: string) => `${(dir ?? "").replace(/\/+$/, "")} ${cmd.trim()}`;
  const have = new Set(existing.map((b) => key(b.cmd, b.dir)));

  const byKey = new Map<string, BuildCandidate>();
  for (const f of files) {
    for (const c of readerFor(f, wrappers)) {
      const k = key(c.cmd, c.dir);
      // First reader to describe a command wins; a later duplicate only
      // contributes its caution note, which must not be lost.
      const prev = byKey.get(k);
      if (prev) { if (!prev.note && c.note) prev.note = c.note; continue; }
      byKey.set(k, { ...c, dir: c.dir || undefined, already: have.has(k) || undefined });
    }
  }

  const all = [...byKey.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { candidates: all.slice(0, limit), total: all.length };
}

/**
 * The suggest list narrowed by what is already typed in the editor.
 *
 * Matching is on the name, the command and the sub-dir together, word by word,
 * so "release apk" finds `./gradlew assembleRelease` sitting in `app/` and the
 * order the words were typed in does not matter. An empty query is the whole
 * list, not none of it.
 */
export function filterCandidates(candidates: BuildCandidate[], query: string): BuildCandidate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return candidates;
  return candidates.filter((c) => {
    const hay = `${c.name} ${c.cmd} ${c.dir ?? ""} ${c.source}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
