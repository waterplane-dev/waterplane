/**
 * A failed push or pull on the git screen, as words for a NEW session in that
 * repo — the log the phone was shown, with the context an agent starting cold
 * needs (which branch, which upstream, how many commits, how long it ran).
 *
 * Pure, pinned by `gitFailPrompt.test.mjs`. It builds a SEED: the tap opens the
 * Send sheet with this in it and sends nothing — the words are edited, timed
 * and sent from there, like every other "ask the agent" on the phone.
 */
import type { RepoTarget } from "@waterplane/shared";
import type { SendSeed } from "./sendIntent";

export interface GitFailure {
  verb: "push" | "pull";
  branch: string;
  upstream?: string;
  /** Commits ahead of the upstream when the push started — absent when unknown. */
  ahead?: number;
  /** `0:39` — the run's own clock, when the screen knew it. */
  took?: string;
  /** The host's text: its one-line verdict, a blank line, then the output's tail. */
  error: string;
}

/** The button's words — a seed, so the ellipsis: the Send sheet comes next. */
export const GIT_FIX_LABEL = "fix in a new session…";

/**
 * The same words onto the clipboard, for a session or a chat that is not this
 * repo's new one. The receipt is a TOAST, never the note: the note is what the
 * two buttons belong to, so writing it would take them both away.
 */
export const GIT_COPY_LABEL = "copy";
export const GIT_COPIED = "Copied: the log, with the branch, upstream and how long it ran.";
export const GIT_COPY_FAILED = "Couldn't reach the clipboard. Select the log below instead.";

/**
 * A fence the log cannot close: one backtick longer than the longest run in
 * it. A test failure prints source, and source here is full of ``` fences.
 */
export function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function gitFailPrompt(f: GitFailure): string {
  const up = f.upstream ?? "its upstream";
  const commits = f.ahead ? ` (${f.ahead} commit${f.ahead > 1 ? "s" : ""} ahead)` : "";
  const what = f.verb === "push"
    ? `Pushing \`${f.branch}\`${commits} to \`${up}\` failed on this desktop${f.took ? ` after ${f.took}` : ""}.`
    : `Pulling \`${up}\` into \`${f.branch}\` failed on this desktop.`;
  const f3 = fence(f.error);
  const ask = f.verb === "push"
    ? "Find the cause and fix it. Re-run the check that failed until it passes, then commit the fix. Leave the push to me — I'll retry it from the phone."
    : "Find out why and get the branch to where the pull can go through, without losing any local commit or uncommitted edit. Don't push.";
  return [
    what,
    "",
    "This is what the phone's git screen showed. It is only the last lines of the output, so re-run the failing step yourself for the whole of it.",
    "",
    f3,
    f.error.trim(),
    f3,
    "",
    ask,
  ].join("\n");
}

/** The seed: a fresh session in the repo the failure happened in. */
export function gitFailSeed(f: GitFailure, repo: RepoTarget): SendSeed {
  return {
    prompts: [gitFailPrompt(f)],
    target: { kind: "repo", cwd: repo.worktreePath },
    cwdHint: repo.worktreePath,
    repoId: repo.id,
    origin: `From ${repo.repoName}'s git screen — the failed ${f.verb}`,
  };
}
