import { repoBranchLabel } from "@waterplane/shared";
import type { RepoTarget } from "@waterplane/shared";

/**
 * The title a repo's Start tap hands `askLaunchFirst`: named by the FOLDER. The ask rewords it
 * with the repo's shown name exactly once (`shownTitleIn` matches a leading folder name), so a
 * title that was already reworded would be read as another repo's folder and substituted again.
 */
export const repoStartTitle = (t: RepoTarget): string => repoBranchLabel(t);
