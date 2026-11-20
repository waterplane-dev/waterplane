/**
 * Doors of Waiting work (whole-app journey spec D4, §8: owned by P7). One screen, tabs Activity,
 * Queued, Backlog, Scheduled; the old ids `activity`, `queue`, `backlog`, `schedule` are aliases that
 * open it on their tab (`routing.ts` `OVERLAY_ALIAS`, `waitingWork.ts`). The Home chip and the ☰ line
 * are Home's doors (`home.ts`); the toolbar's are the session's.
 */
import { TITLE } from "../sheetNames.ts";
import type { DoorArea } from "./types.ts";

export const area: DoorArea = {
  doors: [
    // The queue strip above the prompt bar: each state's button opens the screen cut to exactly the
    // rows the strip counted ("n of N" with Show all), on the Activity tab where that cut lives.
    { label: "Waiting work", from: "composer", to: "activity", title: TITLE.waiting, tab: "Activity",
      task: "See or change what is waiting", taps: 1 },
  ],
};
