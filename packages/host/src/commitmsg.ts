/**
 * The commit message a person asked this desktop to draft for them.
 *
 * ── What this is, and what it deliberately is not ──────────────────────────
 *
 * It is `sessions/record.ts`'s tab-name call (`nameTab`) wearing a different prompt: one
 * toolless headless call, no thinking, the cheapest model, its whole input in
 * the prompt. CLAUDE.md's rule for a new unattended `claude -p` is that it
 * starts from `nameTab`'s flags and justifies every one it drops — this one
 * drops none, because `runCommitTask` IS `runNameTask`'s argv (`sidecar.ts`).
 *
 * It is NOT unattended: nothing here fires on a turn boundary, a schedule or a
 * tick. One tap, one call, and the call is the whole of it — **nothing applies
 * itself**. The answer is a sentence that lands in the commit box for a person
 * to read, edit and commit by hand; this module never commits, never stages and
 * never writes a file.
 *
 * ── Why the recent subjects are in the prompt ──────────────────────────────
 *
 * `--setting-sources user` drops the project's own `CLAUDE.md`, which is where
 * a repo's commit style would be written down — 12k characters of it here, to
 * answer "how does this repo word a commit". Ten subject lines off `git log`
 * are ~400 characters and say the same thing by example, which is the cheap
 * half of that trade and the reason the flag can stay.
 *
 * ── Every failure is a SENTENCE ────────────────────────────────────────────
 *
 * Never a throw, never an empty box, and never an approximate message. The
 * caller puts the reason on screen and the box keeps whatever was typed in it —
 * a draft is the last copy of somebody's words, and a suggestion that could not
 * be made must not also be a delete.
 */
import { cleanCommitMessage, MAX_COMMIT_SUBJECT } from "@waterplane/shared";
import { gitPendingDiff, gitRecentSubjects } from "./git.js";
import { runCommitTask } from "./sidecar.js";
import { env } from "./env.js";
import { promptText } from "./prompts.js";

/** The model that writes it. Same default as every other cheap call here. */
const COMMIT_MODEL = env("COMMIT_MODEL") || env("SUMMARY_MODEL") || "haiku";

/** How long one draft may take before the answer is "it did not come back". */
const COMMIT_TIMEOUT_MS = Number(env("COMMIT_TIMEOUT_MS") || 90_000);

const COMMIT_SYSTEM_DEFAULT =
  "You write git commit messages. Output only the message — no preamble, no code fence, no explanation.";

const COMMIT_PROMPT =
  `Write the commit message for the change below.\n` +
  `One subject line of at most ${MAX_COMMIT_SUBJECT} characters saying what the change DOES, ` +
  `then, only if the subject cannot carry it, a blank line and at most three short lines of body.\n` +
  `Match the wording and mood of the recent subjects from this repo — they are the house style.\n` +
  `Describe the change, never the process: no "as requested", no file inventory, no attribution or co-author lines.\n` +
  `If the change is too unclear to describe, output exactly: (none).`;

export interface CommitSuggestion {
  /** The message, cleaned. Absent whenever there is not a real one. */
  readonly message?: string;
  /** Why there is none, in words a person reads. Absent on success. */
  readonly reason?: string;
  /** The ACCOUNT is out of quota — not an error, and a different sentence. */
  readonly limited?: boolean;
}

/** The empty verdict, worded once. */
const no = (reason: string, limited = false): CommitSuggestion => ({ reason, limited });

/**
 * Draft a commit message for what is waiting in this worktree.
 *
 * Reads git, spends one cheap call, returns words. The diff it reads is the one
 * `Commit all` would record — tracked changes against HEAD plus the untracked
 * names `git add -A` sweeps in — never the branch's delta against main, which
 * would describe work that is already committed.
 */
export async function suggestCommitMessage(wt: string): Promise<CommitSuggestion> {
  const { diff, stat, untracked, empty } = await gitPendingDiff(wt);
  if (empty) return no("Nothing is waiting to be committed here.");

  const subjects = await gitRecentSubjects(wt, 10);
  const parts: string[] = [COMMIT_PROMPT];
  if (subjects.length) {
    parts.push(`----- RECENT SUBJECTS IN THIS REPO (newest first) -----\n${subjects.map((s) => `- ${s}`).join("\n")}`);
  }
  if (stat) parts.push(`----- FILES CHANGED -----\n${stat}`);
  if (untracked.length) {
    // Names, never contents — `gitPendingDiff`'s rule, restated where it is
    // read so the model does not describe a file it was never shown.
    parts.push(`----- NEW FILES (not yet tracked; contents not shown) -----\n${untracked.slice(0, 200).map((u) => `- ${u}`).join("\n")}`);
  }
  if (diff.trim()) parts.push(`----- DIFF -----\n${diff}`);

  const run = await runCommitTask({
    cwd: wt,
    prompt: parts.join("\n\n"),
    system: promptText("commit-message", COMMIT_SYSTEM_DEFAULT),
    model: COMMIT_MODEL,
    timeoutMs: COMMIT_TIMEOUT_MS,
  });
  if (run.limited) return no(run.detail || "The account is out of quota — no message was written.", true);
  if (run.failed) return no(run.detail || "No message came back.");
  if (run.text.trim() === "(none)") return no("The model could not tell what this change does.");

  const message = cleanCommitMessage(run.text);
  // A refused answer is refused ALOUD: silently leaving the box empty reads as
  // a button that does nothing, and the words that came back are not shown
  // because they are the thing this just decided not to write into a commit.
  if (!message) return no("What came back was not a commit message — nothing was written into the box.");
  return { message };
}
