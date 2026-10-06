/**
 * Repo readings: one repo's setup checklist (against the conventions) and its
 * zero-token health series (against its own past), as ONE sheet with two
 * doors. README.md says what this owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { RepoHealthAliasSheet, RepoReadingsSheet } from "./RepoReadingsSheet";
import { healthRepo } from "./store";
import { bootRepoHealthEvent } from "./actions";
import { AutoCompactSettings } from "./AutoCompactSettings";

export { openRepoHealth, openSetup } from "./actions";

export const manifest: FeatureManifest = {
  id: "setup",
  sheets: [
    { id: "setup", persisted: false, render: () => createElement(RepoReadingsSheet) },
    // Repo-scoped like `assess`: with no repo in memory this returns null and
    // falls through to the screen underneath.
    { id: "repohealth", persisted: false, render: () => {
      const repo = healthRepo.get();
      return repo ? createElement(RepoHealthAliasSheet, { repo }) : null;
    } },
  ],
  boot: () => bootRepoHealthEvent(),
  settings: [
    // Last in Sessions: the last question about one is how large it may grow.
    { group: "sessions", order: 30, render: () => createElement(AutoCompactSettings) },
  ],
};
