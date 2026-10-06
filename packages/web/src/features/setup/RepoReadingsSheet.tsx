/**
 * The `setup` overlay and its `repohealth` alias: `SetupSheet.tsx` — `Repo
 * readings`, ONE sheet with two regions (against the conventions / against its
 * own past) — wired to this feature's aim and the core. Both doors get the
 * same verbs: `remedy` and `openRepoFile` are shared on purpose.
 */
import type { RepoTarget } from "@waterplane/shared";
import { SetupSheet } from "../../SetupSheet";
import { useCore, useStore } from "../../sdk";
import { setupAim, setupRepo } from "./store";
import { closeRepoHealth, closeSetup, openRepoFile, remedy } from "./actions";

/** The checklist door (and the settings door, with no repo). */
export function RepoReadingsSheet() {
  const core = useCore();
  const repoId = useStore(setupRepo);
  const aim = useStore(setupAim);
  return <SetupSheet repos={core.world.repos} initialRepoId={repoId ?? undefined}
    initialRegion={aim.region} focus={aim.focus}
    // A finding whose answer is WORK, handed to the one send surface rather
    // than run from the checklist: the sheet states what it found, this opens
    // the prompt with the repo already chosen, and WHEN it runs is still a
    // decision made with the words on screen.
    onRemedy={remedy}
    onOpenFile={openRepoFile}
    onClose={closeSetup} />;
}

/**
 * The repo-health series — region 2 of the same sheet, and this key kept as
 * its ALIAS: `resumeRoute.ts` restores a stored route and the viewer's
 * `returnTo` names an overlay, so a route written before the merge must still
 * land on the half it meant.
 */
export function RepoHealthAliasSheet({ repo }: { repo: RepoTarget }) {
  const core = useCore();
  return <SetupSheet
    repos={core.world.repos}
    initialRepoId={repo.id}
    initialRegion="series"
    // The same send surface the checklist door gets: reached through this
    // alias, region 2's `ask the agent about this…` was absent.
    onRemedy={remedy}
    onOpenFile={openRepoFile}
    onClose={closeRepoHealth}
  />;
}
