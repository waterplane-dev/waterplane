/**
 * What the repo-readings feature holds: where the sheet is AIMED. Each is a
 * tap and not a setting — every door sets it, and the sheet's close clears it.
 * One writer: `actions.ts`.
 */
import type { RepoTarget } from "@waterplane/shared";
import { createStore } from "../../sdk";
import type { ReadingsRegion } from "../../SetupSheet";

/** Repo the checklist should open on — set when the sheet was reached from a
 *  repo row's badge or menu instead of the launcher's own door. */
export const setupRepo = createStore<string | null>(null);

export interface SetupAim { region?: ReadingsRegion; focus?: "findings" | "context-weight" }
/** Which of the two regions to land on, and whether a badge's count cut region
 *  1 to exactly those findings (a count on a control is a filter). */
export const setupAim = createStore<SetupAim>({});

/** The repo the `repohealth` alias (region 2) is open on. */
export const healthRepo = createStore<RepoTarget | null>(null);
