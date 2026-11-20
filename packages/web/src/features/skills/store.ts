/**
 * What the skills screen holds between taps: which repo it is aimed at, which level it edits, the
 * draft (chosen, not saved) and the list's cut. The inventory, its use counts and the suggestions
 * are slow jobs on the desktop (`src/slowJobs.ts`). ONE writer: `actions.ts`.
 */
import { createStore } from "../../sdk";
import type { SkillRecommendResponse } from "@waterplane/shared";
import type { Draft, FilterKey, Parked, SortKey, Target } from "./logic";

export interface SkillsState {
  repoId: string | null;
  /** The backend of the door's session or repo, so the gate names the right label. */
  backend?: string;
  /** Where a card's FIRST tap applies (the door's choice); each changed card then shows and changes its own. */
  target: Target;
  /** Repo level only: write `.claude/settings.json` (shared) instead of the gitignored local file. */
  shared: boolean;
  /** This repo's unsaved choices (the file `shared` names). */
  draft: Draft;
  /** All repos' unsaved choices: cards whose scope pair says All repos. */
  allDraft: Draft;
  /** Unsaved drafts of other files and repos, kept until their file is on screen again. */
  parked: Parked;
  filter: FilterKey | null;
  sort: SortKey;
  query: string;
  /** The last Recommend answer on screen: only a list until Apply. The run itself is a slow job (`slowJobs.ts`). */
  suggest: SkillRecommendResponse | null;
  /** The run `suggest` came from (shown or closed), so a return does not put a closed list back. */
  suggestRun: string | null;
  /** Keys (kind:id) of suggestions a person unticked. */
  unticked: string[];
}

export const initialSkills = (): SkillsState => ({ repoId: null, target: "repo", shared: false, draft: {}, allDraft: {}, parked: {}, filter: null, sort: "heaviest", query: "", suggest: null, suggestRun: null, unticked: [] });

export const skillsState = createStore<SkillsState>(initialSkills());

/**
 * Where Setup & health's Skills section is aimed when a section tap (not a skills door) brought it on
 * screen: the repo the last section was on. A door's aim (`skillsDoor.ts`) wins when the door opened
 * the screen. ONE writer: `actions.ts` `enterSkills`.
 */
export const skillsEmbedAim = createStore<{ repoId: string; backend?: string; target?: "repo" | "all" } | null>(null);
