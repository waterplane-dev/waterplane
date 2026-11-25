/**
 * The set-up page of one repo: everything waterplane can turn on here, ticked and set up in one go.
 * README.md says what this owns and which rules apply.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { RepoSetupSheet } from "./RepoSetupSheet";
import { bootRepoSetup, leaveRepoSetup } from "./actions";
import { openOn } from "./store";

export { offerRepoSetup, openRepoSetup } from "./actions";

export const manifest: FeatureManifest = {
  id: "repoSetup",
  sheets: [{
    id: "repoSetup", persisted: false,
    // A door over the page comes back to the same repo; its ticks and outcomes live in `runs`, which no leave drops.
    keep: keepStores(openOn),
    onLeave: (reason) => { if (reason === "close") leaveRepoSetup(); },
    render: () => (openOn.get() ? createElement(RepoSetupSheet) : null),
  }],
  boot: () => bootRepoSetup(),
};
