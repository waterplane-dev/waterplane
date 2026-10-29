/**
 * Host tools: the thin sheets that read or poke the desktop and this phone —
 * speed test, secrets, feature usage, storage, connection health, the local
 * runner, repo colours and the conversation archive. README.md says what it
 * owns and which rules apply.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import {
  ArchiveToolSheet, FeaturesToolSheet, LocalRtToolSheet, NetHealthToolSheet, RepoColorToolSheet, SecretToolSheet,
  SpeedTestToolSheet, StorageToolSheet,
} from "./ToolSheets";
import { bootStripDoors } from "./actions";
import { localRtFocus, netFocus } from "./store";

export const manifest: FeatureManifest = {
  id: "tools",
  sheets: [
    { id: "speedtest", persisted: false, render: () => createElement(SpeedTestToolSheet) },
    { id: "secret", persisted: false, render: () => createElement(SecretToolSheet) },
    { id: "features", persisted: false, render: () => createElement(FeaturesToolSheet) },
    { id: "storage", persisted: true, render: () => createElement(StorageToolSheet) },
    // A focus is about the tap that opened the sheet, so it goes when the
    // sheet does — however it was left (×, Back, another sheet on top).
    { id: "nethealth", persisted: false, render: () => createElement(NetHealthToolSheet), onLeave: () => netFocus.set(undefined), keep: keepStores(netFocus) },
    { id: "localrt", persisted: false, render: () => createElement(LocalRtToolSheet), onLeave: () => localRtFocus.set(undefined), keep: keepStores(localRtFocus) },
    { id: "repocolor", persisted: true, render: () => createElement(RepoColorToolSheet) },
    { id: "archive", persisted: true, render: () => createElement(ArchiveToolSheet) },
  ],
  boot: () => bootStripDoors(),
};
