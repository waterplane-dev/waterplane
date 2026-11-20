/**
 * Setup & health's readings sections (Health score, Watch, Opt-ins, Sessions) and the frame's own
 * `health` id. The `setup` overlay and its `repohealth` alias draw the same one screen
 * (`SetupHealthSheet.tsx`), each on its own section. README.md says what this owns and which rules
 * apply.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { SetupHealthSheet } from "../../SetupHealthSheet";
import { healthPlace, leaveHealth, registerHealthBody, sectionOfRegion } from "../../setupHealth";
import { ReadingsBody } from "./RepoReadingsSheet";
import { healthRepo, setupAim, setupRepo } from "./store";
import { bootRepoHealthEvent, closeHealth, closeRepoHealth, closeSetup, enterReadings } from "./actions";
import { AutoCompactSettings } from "./AutoCompactSettings";

export { openRepoHealth, openSetup } from "./actions";

registerHealthBody("readings", {
  render: (place) => createElement(ReadingsBody, { place }),
  repoId: () => setupRepo.get() ?? healthRepo.get()?.id ?? null,
  enter: enterReadings,
});

// Back from a door over the screen (a file, the Send sheet) comes back to the section it left.
const keep = keepStores(setupRepo, setupAim, healthRepo, healthPlace);

export const manifest: FeatureManifest = {
  id: "setup",
  sheets: [
    { id: "setup", persisted: false, keep, onLeave: (r) => { if (r === "close") leaveHealth("setup"); },
      render: () => createElement(SetupHealthSheet, { self: "setup", landing: { tab: "repo", section: sectionOfRegion(setupAim.get().region) }, onClose: closeSetup }) },
    // Repo-scoped like `assess`: with no repo in memory this returns null and
    // falls through to the screen underneath.
    { id: "repohealth", persisted: false, keep, onLeave: (r) => { if (r === "close") leaveHealth("repohealth"); }, render: () => {
      const repo = healthRepo.get();
      return repo ? createElement(SetupHealthSheet, { self: "repohealth", landing: { tab: "repo", section: "score" }, onClose: closeRepoHealth }) : null;
    } },
    // The merged screen's own id: lands on This repo › Checks.
    { id: "health", persisted: false, keep, onLeave: (r) => { if (r === "close") leaveHealth("health"); },
      render: () => createElement(SetupHealthSheet, { self: "health", landing: { tab: "repo", section: "checks" }, onClose: closeHealth }) },
  ],
  boot: () => bootRepoHealthEvent(),
  settings: [
    // Last in Sessions: the last question about one is how large it may grow.
    { group: "sessions", order: 30, render: () => createElement(AutoCompactSettings) },
  ],
};
