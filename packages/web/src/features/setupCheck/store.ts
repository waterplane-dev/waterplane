/**
 * Where the Setup check is AIMED: the repo and scope it opened on, and whether a badge's count cut
 * it. A tap, never a setting — every door sets it and the sheet's close clears it. One writer:
 * `actions.ts`.
 */
import { createStore } from "../../sdk";
import { initialAim, type SetupCheckAim } from "./logic";

export const setupCheckAim = createStore<SetupCheckAim>(initialAim());
