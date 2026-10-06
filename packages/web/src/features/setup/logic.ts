/**
 * The repo-readings feature's pure half: the seed a finding (or a reading)
 * hands the Send sheet, and where coming back from a file lands. Pinned by
 * `logic.test.mjs`.
 */
import type { RepoTarget } from "@waterplane/shared";
import type { SendSeed } from "../../sendIntent";
import type { SetupAim } from "./store";

/**
 * A reading whose answer is WORK, as a send seed: the prompt with the repo
 * already chosen, nothing sent. A repo target rather than a session one —
 * grooming a repo is not something to interject into a session mid-task —
 * and WHEN it runs stays a decision made with the words on screen.
 */
export function remedySeed(prompt: string, repo: RepoTarget, label: string): SendSeed {
  return {
    prompts: [prompt],
    target: { kind: "repo", cwd: repo.worktreePath },
    cwdHint: repo.worktreePath,
    repoId: repo.id,
    origin: `From ${repo.repoName}'s repo readings — ${label}`,
  };
}

/** A file opened from the readings came from region 2's tape: coming back, the
 *  sheet remounts from its aim, so aim it at the region the tap came from. */
export function aimAfterFile(aim: SetupAim): SetupAim {
  return { ...aim, region: "series" };
}
