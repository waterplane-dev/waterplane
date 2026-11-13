/**
 * What the skills screen holds between taps: which repo it is aimed at, which level it edits, the
 * draft (chosen, not saved) and the list's cut. The inventory itself is a host read the sheet owns
 * (`useRemoteResource`). ONE writer: `actions.ts`.
 */
import { createStore } from "../../sdk";
import type { SkillRecommendResponse } from "@waterplane/shared";
import type { Draft, FilterKey, Parked, SortKey, Target } from "./logic";

export interface SkillsState {
  repoId: string | null;
  /** The backend of the door's session or repo, so the gate names the right label. */
  backend?: string;
  target: Target;
  /** Repo level only: write `.claude/settings.json` (shared) instead of the gitignored local file. */
  shared: boolean;
  draft: Draft;
  /** Unsaved drafts of other files and repos, kept until their file is on screen again. */
  parked: Parked;
  filter: FilterKey | null;
  sort: SortKey;
  query: string;
  /** The last Recommend answer: only a list until Apply. */
  suggest: SkillRecommendResponse | null;
  /** Keys (kind:id) of suggestions a person unticked. */
  unticked: string[];
  asking: boolean;
}

export const initialSkills = (): SkillsState => ({ repoId: null, target: "repo", shared: false, draft: {}, parked: {}, filter: null, sort: "heaviest", query: "", suggest: null, unticked: [], asking: false });

export const skillsState = createStore<SkillsState>(initialSkills());
