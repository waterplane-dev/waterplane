#!/usr/bin/env node
/**
 * This repo's own repo-health readings (`.waterplane-shared/health.json`), one
 * subcommand each. A reading prints ONE JSON number on stdout and nothing else
 * (contract: tools/repohealth/own.mjs); cwd is the repo root, node plus the repo's own typescript
 * (tools/codelines.mjs parses): with no node_modules a reading is absent, never a wrong number.
 *
 *   node tools/healthreadings.mjs nearCap       # files within 50 counted lines of the max-lines cap
 *   node tools/healthreadings.mjs skillBodies   # kB of text under .claude/skills/
 *   node tools/healthreadings.mjs bareHookDeps  # exhaustive-deps disables with no reason
 *   node tools/healthreadings.mjs capSqueeze    # commits that deleted only notes from a file near the cap
 *   node tools/healthreadings.mjs seamUntested  # seam modules (SEAMS) no test reaches, at HEAD
 *   node tools/healthreadings.mjs repairRate    # share of source commits (28 days) a repair commit touched again within 7 days
 *   node tools/healthreadings.mjs repairRate --list   # those commits, each with its repairs, instead of the number
 *
 * Pure counters are exported for tools/healthreadings.test.mjs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { codeLineCount, lineCount } from "./codelines.mjs";

export const MARGIN = 50;
/** Fallback if eslint.config.js's `max-lines` cannot be parsed. */
export const DEFAULT_CAP = 900;

/** The cap from eslint.config.js's `"max-lines": ["error", { max: N ...`. */
export function capFromConfig(text) {
  const m = /"max-lines"\s*:\s*\[\s*"error"\s*,\s*\{\s*max:\s*(\d+)/.exec(String(text));
  return m ? Number(m[1]) : DEFAULT_CAP;
}

/** Whether eslint's max-lines applies to this path (its `files` globs, minus ignores and fixtures). */
export function inCapScope(p) {
  if (/(^|\/)(dist|node_modules|fixtures)\//.test(p)) return false;
  if (/^packages\/(app|vscode)\//.test(p)) return false;
  if (/\.(ts|tsx)$/.test(p)) {
    return /^packages\/[^/]+\/src\//.test(p) || /^packages\/extensions\/[^/]+\/web\//.test(p);
  }
  // The second max-lines block: extension host/shared/cli halves and tools/, tests excluded.
  if (/^tools\/.*\.(mjs|js)$/.test(p)) return !/\.test\.(mjs|js)$/.test(p);
  if (!/\.(mts|mjs)$/.test(p) || /\.test\.(mjs|mts)$/.test(p)) return false;
  return /^packages\/extensions\/[^/]+\/(host|shared|cli)\//.test(p);
}

/** Count of `files` ({path,text}) in scope at cap - margin or more, counted as the cap counts. */
export function countNearCap(files, cap = DEFAULT_CAP, margin = MARGIN) {
  return files.filter((f) => inCapScope(f.path)
    && lineCount(f.text) >= cap - margin // code never exceeds the whole file: skip the parse
    && codeLineCount(f.text, f.path) >= cap - margin).length;
}

/** Total bytes of file sizes, as kB with one decimal. */
export function kbOf(bytes) {
  return Math.round((bytes / 1000) * 10) / 10;
}

const DISABLE = /eslint-disable(?:-next-line|-line)?\s+react-hooks\/exhaustive-deps/;

/** Disables of react-hooks/exhaustive-deps in `text` that give no reason; returns 1-based line numbers. */
export function bareHookDisables(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const out = [];
  lines.forEach((line, i) => {
    const m = DISABLE.exec(line);
    if (!m) return;
    const after = line.slice(m.index + m[0].length);
    if (/\s--\s*\S/.test(after)) return;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j--;
    const prev = j >= 0 ? lines[j].trim() : "";
    const isComment = /^(\/\/|\/\*|\*|\{\s*\/\*)/.test(prev) || /\*\/\}?$/.test(prev);
    if (isComment && !DISABLE.test(prev) && !/^(\/\/|\/\*)\s*$/.test(prev)) return;
    out.push(i + 1);
  });
  return out;
}

/** A capped file this close under the cap (880 at 900, as the cap counts) is one where a shrink is suspect. */
export const SQUEEZE_MARGIN = 20;
export const SQUEEZE_DAYS = 30;

/** A removed diff line that is a comment or blank (`//`, `/*`, ` *`, `*\/`, JSX `{/*`). */
export function isNoteLine(line) {
  const t = String(line).trim();
  return t === "" || /^(\/\/|\/\*|\*|\{\s*\/\*)/.test(t);
}

/** The `-` lines of a unified diff, without their marker or the `---` header. */
export function removedLines(diff) {
  return String(diff).split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Commits in the last `days` where a capped file at `cap - SQUEEZE_MARGIN`+ counted lines lost lines, ended
 * at or under the cap, and every line removed from it was a comment or blank. Comments stopped counting
 * on 2026-11-04, so such a trim buys no room: a hit is a note lost to a cap that never asked for it, by
 * habit or by a stale brief. A blank removed does still count, and is the one way left to gain a line.
 * Commits before that day are read by today's count too, so the ones that trimmed a file of mostly
 * notes fell out of the number that day. A commit counts once however many files it hit. Throws if
 * git cannot be read.
 */
export function countCapSqueeze({ cwd = ".", cap = DEFAULT_CAP, days = SQUEEZE_DAYS } = {}) {
  const log = git(["log", "--no-merges", "--no-renames", `--since=${days} days ago`, "--numstat", "--format=%x00%H"], cwd);
  let n = 0;
  for (const chunk of log.split("\0").filter((c) => c.trim())) {
    const [sha, ...rows] = chunk.split("\n");
    const shrunk = rows.map((r) => r.split("\t")).filter(([add, del, path]) =>
      path && inCapScope(path) && /^\d+$/.test(add) && Number(del) > Number(add));
    const squeezed = shrunk.some(([, , path]) => {
      let before, after;
      try { before = git(["show", `${sha}^:${path}`], cwd); } catch { return false; } // root commit or new file
      if (lineCount(before) < cap - SQUEEZE_MARGIN) return false; // code never exceeds the whole file: skip the parse
      if (codeLineCount(before, path) < cap - SQUEEZE_MARGIN) return false;
      try { after = git(["show", `${sha}:${path}`], cwd); } catch { return false; } // deleted: moved, not trimmed
      // Still over the cap after it is not a fit: a file with no cap then (wire/messages.ts at 1300+).
      if (codeLineCount(after, path) > cap) return false;
      return removedLines(git(["show", "--format=", "--no-renames", "-U0", sha, "--", path], cwd)).every(isNoteLine);
    });
    if (squeezed) n++;
  }
  return n;
}

export const REPAIR_DAYS = 28;
export const REPAIR_WITHIN_DAYS = 7;
/** A commit subject that repairs earlier work: this repo says "repair" / "review fixes", the world says fix / revert. */
export const REPAIR_SUBJECT = /\brepair(s|ed)?\b|review fix(es)?|screen-review fix|\bfix(es|ed)?\b|\brevert\b/i;
export const isRepairSubject = (subject) => REPAIR_SUBJECT.test(String(subject));

/**
 * `commits`: [{hash, time (unix seconds), subject, files}]. A non-repair commit is repaired when a repair
 * commit dated after it and within `withinDays` touches at least one of its in-scope files. Returns
 * {total, repaired: [{commit, repairs}]}; total counts the non-repair commits that touch source.
 */
export function repairedCommits(commits, withinDays = REPAIR_WITHIN_DAYS) {
  const scoped = commits
    .map((c) => ({ ...c, files: new Set((c.files ?? []).filter(inCapScope)) }))
    .filter((c) => c.files.size);
  const repairs = scoped.filter((c) => isRepairSubject(c.subject));
  const plain = scoped.filter((c) => !isRepairSubject(c.subject));
  const span = withinDays * 86400;
  const repaired = [];
  for (const c of plain) {
    const hit = repairs.filter((r) => r.time > c.time && r.time - c.time <= span && [...r.files].some((f) => c.files.has(f)));
    if (hit.length) repaired.push({ commit: c, repairs: hit });
  }
  return { total: plain.length, repaired };
}

/** Reads non-merge commits of the last `days` days before `now` (unix seconds) that touch source. Throws if git cannot be read. */
export function readSourceCommits({ cwd = ".", now = Math.floor(Date.now() / 1000), days = REPAIR_DAYS } = {}) {
  const log = git(["log", "--no-merges", "--no-renames", `--since=${now - days * 86400}`, `--until=${now}`,
    "--name-only", "--format=%x00%H%x01%ct%x01%s"], cwd);
  const out = [];
  for (const chunk of log.split("\0").filter((c) => c.trim())) {
    const [head, ...rest] = chunk.split("\n");
    const [hash, time, subject] = head.split("\x01");
    out.push({ hash, time: Number(time), subject, files: rest.filter(Boolean) });
  }
  return out;
}

/**
 * The modules CLAUDE.md calls the one implementation or the security boundary: a bug in one deletes typed
 * words or widens access, and in the generic untested share (hundreds of modules) it cannot be seen. The ONE
 * list. A path is a module; a path ending `/` is every source module directly in that directory.
 */
export const SEAMS = [
  "packages/host/src/answergate.ts",
  "packages/host/src/auth.ts",
  "packages/host/src/confirmgate.ts",
  "packages/host/src/deliver.ts",
  "packages/host/src/origin.ts",
  "packages/host/src/passive.ts",
  "packages/host/src/paths.ts",
  "packages/host/src/render.ts",
  "packages/host/src/scaffold.ts",
  "packages/web/src/PromptComposer.tsx",
  "packages/web/src/core/queue/",
  "packages/web/src/download.ts",
  "packages/web/src/passiveApi.ts",
];

const inSeam = (seam, path) => (seam.endsWith("/")
  ? path.startsWith(seam) && !path.slice(seam.length).includes("/")
  : path === seam);

/**
 * Does this module emit anything once its types are erased? A types-only module (interfaces, type aliases,
 * `import type`) has no behaviour a test could pin, so a seam counting it asks for a test of nothing.
 */
export function hasRuntimeCode(text, path = "module.ts") {
  const { outputText } = ts.transpileModule(text, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, removeComments: true,
  } });
  // tsc marks an emptied module `export {};` so it stays a module: that line is not behaviour.
  return outputText.split("\n").some((l) => l.trim() !== "" && l.trim() !== "export {};");
}

/**
 * Which seams `untested` (metrics/untested's list) holds, sorted as it is. `sources` is every source module
 * in the tree. Throws when the count would be a guess: no list, or a seam that names no module, because a
 * renamed seam otherwise drops out of the number and reads as a test somebody wrote. `runtime(path)` false
 * drops a module from the count: types alone are checked by tsc, and no test can reach what never runs.
 */
export function seamsUntested(seams, sources, untested, runtime = () => true) {
  if (!Array.isArray(untested)) throw new Error("no untested list to count from");
  const stale = seams.filter((s) => !sources.some((p) => inSeam(s, p)));
  if (stale.length) throw new Error(`no source module at ${stale.join(", ")}: SEAMS is stale`);
  return untested.filter((p) => seams.some((s) => inSeam(s, p)) && runtime(p));
}

function gitFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0").filter(Boolean);
}

function walk(dir) {
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    bytes += st.isDirectory() ? walk(p) : st.size;
  }
  return bytes;
}

const READINGS = {
  nearCap() {
    const cap = capFromConfig(readFileSync("eslint.config.js", "utf8"));
    const files = gitFiles().filter(inCapScope).map((path) => ({ path, text: readFileSync(path, "utf8") }));
    return countNearCap(files, cap);
  },
  skillBodies() {
    return kbOf(walk(".claude/skills"));
  },
  bareHookDeps() {
    let n = 0;
    const bare = [];
    for (const p of gitFiles()) {
      if (!/\.(ts|tsx)$/.test(p) || /(^|\/)(dist|node_modules)\//.test(p)) continue;
      const hits = bareHookDisables(readFileSync(p, "utf8"));
      n += hits.length;
      for (const l of hits) bare.push(`${p}:${l}`);
    }
    if (bare.length) process.stderr.write(bare.join("\n") + "\n");
    return n;
  },
  capSqueeze() {
    let cap = DEFAULT_CAP;
    try { cap = capFromConfig(readFileSync("eslint.config.js", "utf8")); } catch { /* fallback cap */ }
    try {
      return countCapSqueeze({ cap });
    } catch (e) {
      process.stderr.write(`capSqueeze: git unreadable: ${e.message}\n`);
      process.exit(1);
    }
  },
  repairRate() {
    let got;
    try { got = repairedCommits(readSourceCommits()); } catch (e) {
      process.stderr.write(`repairRate: git unreadable: ${e.message}\n`);
      process.exit(1);
    }
    if (!got.total) {
      process.stderr.write("repairRate: no non-repair source commits in the last 28 days\n");
      process.exit(1);
    }
    if (process.argv.includes("--list")) {
      const short = (c) => `${c.hash.slice(0, 8)} ${c.subject}`;
      process.stdout.write(got.repaired.map((r) => `${short(r.commit)}\n${r.repairs.map((x) => `    ${short(x)}\n`).join("")}`).join(""));
      process.exit(0);
    }
    return got.repaired.length / got.total;
  },
  // Imported here, not at the top: the engine needs shared's dist, and the other readings do not.
  async seamUntested() {
    try {
      const [{ configure }, { buildSnapshot }, { measureUntested }, git] = await Promise.all([
        import("./repohealth/census.mjs"), import("./repohealth/snapshot.mjs"),
        import("./repohealth/metrics/untested.mjs"), import("./repohealth/git.mjs"),
      ]);
      const root = process.cwd();
      const cfg = configure(root, git);
      const snap = buildSnapshot(root, "HEAD", git, cfg);
      const got = measureUntested(snap, null, 0, cfg); // history and index: the metric reads neither
      if (got.value === null) throw new Error(got.reason);
      const textOf = new Map(snap.files.map((f) => [f.path, f.text]));
      const hits = seamsUntested(SEAMS, snap.files.map((f) => f.path), got.value,
        (p) => hasRuntimeCode(textOf.get(p) ?? "x", p)); // unreadable text counts, never drops
      if (hits.length) process.stderr.write(hits.join("\n") + "\n");
      return hits.length;
    } catch (e) {
      process.stderr.write(`seamUntested: cannot count: ${e.message}\n`);
      process.exit(1);
    }
  },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fn = READINGS[process.argv[2]];
  if (!fn) {
    process.stderr.write(`usage: healthreadings.mjs ${Object.keys(READINGS).join("|")}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(await fn()) + "\n");
}
