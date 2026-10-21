#!/usr/bin/env node
/**
 * This repo's own repo-health readings (`.waterplane-shared/health.json`), one
 * subcommand each. A reading prints ONE JSON number on stdout and nothing else
 * (contract: tools/repohealth/own.mjs); cwd is the repo root, pure node.
 *
 *   node tools/healthreadings.mjs nearCap       # files within 50 lines of the max-lines cap
 *   node tools/healthreadings.mjs skillBodies   # kB of text under .claude/skills/
 *   node tools/healthreadings.mjs bareHookDeps  # exhaustive-deps disables with no reason
 *   node tools/healthreadings.mjs capSqueeze    # commits that fit a file under the cap by deleting notes
 *
 * Pure counters are exported for tools/healthreadings.test.mjs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MARGIN = 50;
/** Fallback if eslint.config.js's `max-lines` cannot be parsed. */
export const DEFAULT_CAP = 900;

/** The cap from eslint.config.js's `"max-lines": ["error", { max: N ...`. */
export function capFromConfig(text) {
  const m = /"max-lines"\s*:\s*\[\s*"error"\s*,\s*\{\s*max:\s*(\d+)/.exec(String(text));
  return m ? Number(m[1]) : DEFAULT_CAP;
}

/** Lines as eslint's max-lines counts them (skipBlankLines false): split on \n, a final newline adds none. */
export function lineCount(text) {
  if (!text) return 0;
  const n = text.split(/\r\n|\r|\n/).length;
  return /(\r\n|\r|\n)$/.test(text) ? n - 1 : n;
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

/** Count of `files` ({path,text}) in scope with lineCount >= cap - margin. */
export function countNearCap(files, cap = DEFAULT_CAP, margin = MARGIN) {
  return files.filter((f) => inCapScope(f.path) && lineCount(f.text) >= cap - margin).length;
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

/** A capped file this close under the cap (880 at 900) is one where a shrink is suspect. */
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
 * Commits in the last `days` where a capped file at `cap - SQUEEZE_MARGIN`+ lines lost lines, ended at or
 * under the cap, and every line removed from it was a comment or blank: the notes deleted to fit the cap instead of a split by
 * subject. A commit counts once however many files it squeezed. Throws if git cannot be read.
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
      if (lineCount(before) < cap - SQUEEZE_MARGIN) return false;
      try { after = git(["show", `${sha}:${path}`], cwd); } catch { return false; } // deleted: moved, not trimmed
      // Still over the cap after it is not a fit: a file with no cap then (wire/messages.ts at 1300+).
      if (lineCount(after) > cap) return false;
      return removedLines(git(["show", "--format=", "--no-renames", "-U0", sha, "--", path], cwd)).every(isNoteLine);
    });
    if (squeezed) n++;
  }
  return n;
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
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fn = READINGS[process.argv[2]];
  if (!fn) {
    process.stderr.write(`usage: healthreadings.mjs ${Object.keys(READINGS).join("|")}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(fn()) + "\n");
}
