/**
 * Host tools: the thin sheets that read or poke the desktop and this phone —
 * speed test, secrets, feature usage, storage, connection health, the local
 * runner, repo colours and the conversation archive. README.md says what it
 * owns and which rules apply.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import {
  ArchiveToolSheet, FeaturesToolSheet, ConnectionToolSheet, LocalRtToolSheet, RepoColorToolSheet, SecretToolSheet,
  StorageToolSheet,
} from "./ToolSheets";
import { bootStripDoors } from "./actions";
import { localRtFocus, netFocus } from "./store";
import { archiveOpen } from "../../archiveOpen";

export const manifest: FeatureManifest = {
  id: "tools",
  sheets: [
    { id: "secret", persisted: false, render: () => createElement(SecretToolSheet) },
    { id: "features", persisted: false, render: () => createElement(FeaturesToolSheet) },
    { id: "storage", persisted: true, render: () => createElement(StorageToolSheet) },
    // A focus is about the tap that opened the sheet, so it goes when the
    // sheet does — however it was left (×, Back, another sheet on top).
    { id: "speedtest", persisted: false, render: () => createElement(ConnectionToolSheet, { id: "speedtest", tab: "speed" }) },
    { id: "nethealth", persisted: false, render: () => createElement(ConnectionToolSheet, { id: "nethealth", tab: "health" }), onLeave: () => netFocus.set(undefined), keep: keepStores(netFocus) },
    { id: "connection", persisted: false, render: () => createElement(ConnectionToolSheet, {}), onLeave: () => netFocus.set(undefined), keep: keepStores(netFocus) },
    { id: "localrt", persisted: false, render: () => createElement(LocalRtToolSheet), onLeave: () => localRtFocus.set(undefined), keep: keepStores(localRtFocus) },
    { id: "repocolor", persisted: true, render: () => createElement(RepoColorToolSheet) },
    { id: "archive", persisted: true, render: () => createElement(ArchiveToolSheet), onLeave: () => archiveOpen.set(undefined), keep: keepStores(archiveOpen) },
  ],
  boot: () => bootStripDoors(),
};
