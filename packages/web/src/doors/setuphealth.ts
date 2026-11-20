/** Doors of this area (whole-app journey spec §8: owned by P8, Setup & health, D7a). */
import { TITLE } from "../sheetNames.ts";
import type { DoorArea } from "./types.ts";

export const area: DoorArea = {
  doors: [
    // The main menu's line (features/setupCheck/index.ts): all repos with two or more, else this repo, else This desktop.
    { label: TITLE.health, from: "home menu", to: "setupcheck", title: TITLE.health, tab: "This repo", task: "See whether this repo and this desktop are set up well", taps: 2 },
  ],
  noDoor: {
    // The frame's own id: every control opens one of the merged ids below it, each on its own tab and section.
    health: "the merged screen's own id; its doors open the ids it absorbed (setupcheck, setup, repohealth, skills), each on its section",
  },
};
