/**
 * Pull, push or sync every repo from one tap. README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { RepoSyncSheet } from "./RepoSyncSheet";

export const manifest: FeatureManifest = {
  id: "repoSync",
  sheets: [
    { id: "reposync", persisted: false, render: () => createElement(RepoSyncSheet) },
  ],
};
