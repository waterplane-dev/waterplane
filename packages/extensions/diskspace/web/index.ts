/**
 * The disk-space extension's web half: the sheet, its line in the launcher's ☰ menu (This desktop),
 * its row in Settings › Tools, and the host's one
 * push (`changed` → read the state again). Imports only `@waterplane/sdk`, `@waterplane/kit`, react,
 * lucide-react and its own folder (`local/extension-boundary`). Contract: `shared/wire.mts`.
 *
 * Nothing here deletes by itself: every delete is a tap plus a confirm, and names a row's id.
 */
import { createElement } from "react";
import { HardDrive } from "lucide-react";
import { featureSheetId, isExtensionEnabled, type FeatureManifest } from "@waterplane/sdk";
import { PUSH_CHANGED } from "../shared/wire.mts";
import { DiskSheet } from "./DiskSheet.tsx";
import { DiskRow } from "./DiskRow.tsx";
import { onChanged, openDisk } from "./state.ts";

export const manifest: FeatureManifest = {
  id: "diskspace",
  // The literal form (`tools/webshape.test.mjs` reads it); `state.ts` opens the same id as DISK_SHEET.
  sheets: [{ id: featureSheetId("diskspace", "main"), persisted: false, render: () => createElement(DiskSheet) }],
  pushes: { [PUSH_CHANGED]: () => onChanged() },
  launcherItems: [{
    id: "disk", label: "Disk space", icon: HardDrive, order: 5, open: () => openDisk(),
    title: "disk space — what is filling this desktop's disk, and deleting what rebuilds itself",
  }],
  // Off until switched on (experimental): no ☰ line for a screen whose host half is not running.
  hideWhen: () => !isExtensionEnabled("diskspace"),
  settings: [{
    group: "tools", order: 30, render: () => createElement(DiskRow),
    rows: [{ id: "disk-space", label: "Disk space", keywords: "desktop free full volume scan large files folders delete clean" }],
  }],
};
