/**
 * A build run's log, off the build sheet: onto the clipboard as it stands, or
 * as words for a NEW session in that repo with the context an agent starting
 * cold needs (which build, which command, its parameters, the exit, the clock).
 *
 * Pure, pinned by `buildLogPrompt.test.mjs`. Like `gitFailPrompt.ts` it builds
 * a SEED: the tap opens the Send sheet with this in it and sends nothing.
 */
import type { BuildRun, RepoTarget } from "@waterplane/shared";
import type { SendSeed } from "./sendIntent";
import { fence } from "./gitFailPrompt.ts";

export const BUILD_LOG_COPY_LABEL = "copy log";
export const BUILD_LOG_COPIED = "Copied: the run's log.";
export const BUILD_LOG_COPY_FAILED = "Couldn't reach the clipboard. Select the log below instead.";
/** A seed, so the ellipsis: the Send sheet comes next. */
export const BUILD_LOG_SEND_LABEL = "send to a session…";

/**
 * How much of the log rides in the prompt. A gradle log is thousands of lines
 * and the failure is at the end; the agent is told it got the tail and how to
 * get the rest (re-run the command).
 */
export const BUILD_LOG_TAIL_LINES = 300;

export function logTail(log: string, max = BUILD_LOG_TAIL_LINES): { text: string; cut: number } {
  const lines = log.replace(/\s+$/, "").split("\n");
  if (lines.length <= max) return { text: lines.join("\n"), cut: 0 };
  return { text: lines.slice(-max).join("\n"), cut: lines.length - max };
}

type RunFacts = Pick<BuildRun, "name" | "cmd" | "cwd" | "status" | "exitCode" | "params">;

/** `took` is the run's own clock as the row showed it (`1m 49s`), when known. */
export function buildLogPrompt(r: RunFacts, log: string, took?: string): string {
  const { text, cut } = logTail(log);
  const f3 = fence(text);
  const params = r.params && Object.keys(r.params).length
    ? ` with ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(", ")}`
    : "";
  const outcome = r.status === "failed"
    ? `failed${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`
    : r.status === "running" ? "is still running" : "finished";
  const ask = r.status === "failed"
    ? "Find the cause and fix it. Re-run the command until it passes, then commit the fix."
    : "Look through it and tell me anything that needs fixing — warnings, slow steps, anything that looks wrong. Don't change anything yet.";
  return [
    `The build "${r.name}"${params} ${outcome} on this desktop${took ? ` after ${took}` : ""}.`,
    "",
    `Command: \`${r.cmd}\``,
    `Ran in: \`${r.cwd}\``,
    "",
    cut
      ? `This is the last ${BUILD_LOG_TAIL_LINES} lines of its output (${cut} earlier lines left out) — re-run the command for the whole of it.`
      : "This is its whole output as the phone's build sheet showed it.",
    "",
    f3,
    text,
    f3,
    "",
    ask,
  ].join("\n");
}

/** The seed: a fresh session in the repo the build ran in. */
export function buildLogSeed(r: RunFacts, log: string, repo: RepoTarget, took?: string): SendSeed {
  return {
    prompts: [buildLogPrompt(r, log, took)],
    target: { kind: "repo", cwd: repo.worktreePath },
    cwdHint: repo.worktreePath,
    repoId: repo.id,
    origin: `From ${repo.repoName}'s build sheet — the run of “${r.name}”`,
  };
}
