/**
 * Pre-commit refusal of a cap squeeze: fitting a capped file under the max-lines cap by deleting ONLY
 * comment/blank lines (the notes recording why a rule exists) while the split by subject is still owed.
 * The pure decision is `squeezeDecision`; `stagedSqueezes` feeds it from the index. Run by
 * scripts/guards/precommit.mjs against the real repo (the guard export has no git, so this is not a
 * `node --test` guard); detection pieces are healthreadings.mjs's, imported not copied.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { capFromConfig, lineCount, removedLines, isNoteLine, SQUEEZE_MARGIN } from "./healthreadings.mjs";
import { inCapScope } from "./healthreadings.mjs";

/** True when before -> after is a notes-only trim into the cap. `beforeText` null/undefined = new file. */
export function squeezeDecision(beforeText, afterText, diffText, cap) {
  if (beforeText == null || afterText == null) return false;
  const before = lineCount(beforeText);
  const after = lineCount(afterText);
  if (before < cap - SQUEEZE_MARGIN || after > cap || after >= before) return false;
  return removedLines(diffText).every(isNoteLine);
}

export function squeezeMessage(file) {
  return `${file}: fit the cap by splitting ${file} by subject (refactoring skill), not by deleting its notes`;
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
    if (squeezeDecision(before, after, diff, cap)) out.push(squeezeMessage(f));
  }
  return out;
}
