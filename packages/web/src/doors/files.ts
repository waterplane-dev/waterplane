/** Doors of this area (whole-app journey spec §8: owned by P5 (files, git, assess, downloads)). */
import { TITLE } from "../sheetNames.ts";
import type { DoorArea } from "./types.ts";

export const area: DoorArea = {
  doors: [
    { label: "Images & documents", from: "home menu", to: "gallery", title: TITLE.gallery, task: "Download a file Claude left", taps: 2 },
    { label: "Images & documents", from: "toolbar menu", to: "gallery", title: TITLE.gallery },
    { label: "Browse files", from: "repo menu", to: "browse", title: TITLE.browse, task: "Read a file in the repo", taps: 2 },
    { label: "Browse files", from: "sheet:git", to: "browse", title: TITLE.browse },
    { label: "Browse files", from: "sheet:gallery", to: "browse", title: TITLE.browse },
    { label: "Changes", from: "repo row", to: "git", title: TITLE.git, task: "Commit and push", taps: 1 },
    { label: "Changes", from: "toolbar menu", to: "git", title: TITLE.git },
    { label: "Commits", from: "sheet:git", to: "git", title: TITLE.commits },
    { label: "What is left", from: "repo menu", to: "assess", title: TITLE.assess, task: "See what is left to do", taps: 2 },
    { label: "Downloads", from: "repo menu", to: "pull", title: TITLE.pull, task: "Set what downloads by itself", taps: 2 },
  ],
};
