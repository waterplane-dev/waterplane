/**
 * Pre-commit refusal of a cap squeeze: deleting ONLY comment/blank lines (the notes recording why a
 * rule exists) from a file near the max-lines cap, while the split by subject is still owed. Comments
 * do not count toward the cap, so "near" is in counted lines and a notes trim buys nothing: this
 * stops the old habit, and a file of 700 lines of code and 200 of notes is left alone.
 * The pure decision is `squeezeDecision`; `stagedSqueezes` feeds it from the index. Run by
 * scripts/guards/precommit.mjs against the real repo (the guard export has no git, so this is not a
 * `node --test` guard); detection pieces are healthreadings.mjs's, imported not copied.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { capFromConfig, removedLines, isNoteLine, SQUEEZE_MARGIN } from "./healthreadings.mjs";
import { codeLineCount, lineCount } from "./codelines.mjs";
import { inCapScope } from "./healthreadings.mjs";

/** True when before -> after is a notes-only trim near the cap. `beforeText` null/undefined = new file. */
export function squeezeDecision(beforeText, afterText, diffText, cap, path = "file.ts") {
  if (beforeText == null || afterText == null) return false;
  // The shrink is in whole lines: a trim of comments leaves the counted number where it was.
  if (lineCount(afterText) >= lineCount(beforeText)) return false;
  if (codeLineCount(beforeText, path) < cap - SQUEEZE_MARGIN || codeLineCount(afterText, path) > cap) return false;
  return removedLines(diffText).every(isNoteLine);
}

export function squeezeMessage(file) {
  return `${file}: comments do not count toward the cap, so keep its notes; to make room, split ${file} by subject (refactoring skill)`;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** Staged capped files that are squeezes; messages ready to print. */
export function stagedSqueezes(root) {
  const cap = capFromConfig(readFileSync(join(root, "eslint.config.js"), "utf8"));
  const names = git(["diff", "--cached", "--name-only", "--diff-filter=M", "--no-renames", "-z"], root).split("\0").filter(Boolean);
  const out = [];
  for (const f of names.filter(inCapScope)) {
    let before, after;
    try { before = git(["show", `HEAD:${f}`], root); after = git(["show", `:${f}`], root); } catch { continue; }
    const diff = git(["diff", "--cached", "--no-renames", "-U0", "--", f], root);
    if (squeezeDecision(before, after, diff, cap, f)) out.push(squeezeMessage(f));
  }
  return out;
}
