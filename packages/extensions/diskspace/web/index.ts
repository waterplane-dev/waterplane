/**
 * The disk-space extension's web half: the sheet, its row in Settings › Tools, and the host's one
 * push (`changed` → read the state again). Imports only `@waterplane/sdk`, `@waterplane/kit`, react,
 * lucide-react and its own folder (`local/extension-boundary`). Contract: `shared/wire.mts`.
 *
 * Nothing here deletes by itself: every delete is a tap plus a confirm, and names a row's id.
 */
import { createElement } from "react";
import { featureSheetId, type FeatureManifest } from "@waterplane/sdk";
import { PUSH_CHANGED } from "../shared/wire.mts";
import { DiskSheet } from "./DiskSheet.tsx";
import { DiskRow } from "./DiskRow.tsx";
import { onChanged } from "./state.ts";

export const manifest: FeatureManifest = {
  id: "diskspace",
  // The literal form (`tools/webshape.test.mjs` reads it); `state.ts` opens the same id as DISK_SHEET.
  sheets: [{ id: featureSheetId("diskspace", "main"), persisted: false, render: () => createElement(DiskSheet) }],
  pushes: { [PUSH_CHANGED]: () => onChanged() },
  settings: [{
    group: "tools", order: 30, render: () => createElement(DiskRow),
    rows: [{ id: "disk-space", label: "disk space", keywords: "desktop free full volume scan large files folders delete clean" }],
  }],
};
