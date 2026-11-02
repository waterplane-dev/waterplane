/**
 * The Android apps extension's web half: "your repos' apps on this phone", one card per app with its
 * three steps (build, download, install) and the install history. Imports only `@waterplane/sdk`,
 * `@waterplane/kit`, `@waterplane/shared`, react, lucide-react and its own folder
 * (`local/extension-boundary`). Contract: `shared/wire.mts`.
 *
 * What it contributes to core's chrome:
 *  - the launcher's ☰ line `android apps`, with the count of builds waiting to install. A count is a
 *    filter: with n on it the tap opens exactly those (`openCount` → the `waiting` cut). The count is
 *    the sheet's own (`readyApps` over the same caps, allow list and log), never a cheaper copy. It is
 *    NOT lifted into the header beside the bell (`headerKey: false`): it can sit for days.
 *  - `appsDoor`: how core's Downloads, Build and Pull sheets open this screen without naming it.
 *  - `hideWhen`: the line exists only in the Android shell with this extension on — a browser has no
 *    installer to offer, and an entry that opens a screen saying "not here" is worse than none.
 *  - `boot` + `pushes`: the install log's client half, attached once for the page's life (an overlay
 *    returning early in `App.tsx` must not be able to switch reporting off).
 */
import { createElement } from "react";
import { Boxes } from "lucide-react";
import {
  featureSheetId, isExtensionEnabled, registerDemoPlugin, shellInstall, useInstallAllow, useInstallCaps, usePullRecords, useStore,
  type FeatureManifest, type LauncherItemCount,
} from "@waterplane/sdk";
import { AppsSheet } from "./AppsSheet.tsx";
import { appRows, buildsOf, readyApps } from "./appRows.ts";
import { setNextCut } from "./appsPane.ts";
import { onChanged, startInstallLog } from "./installLog.ts";
import { APPS_SHEET, installLog } from "./state.ts";
import { demoCalls, demoListed } from "./demofixture.ts";

// The demo desktop lists this builtin as on (`demo/host`), so its answers hold in every demo.
registerDemoPlugin("android-apps", { calls: demoCalls, pushes: () => [], always: true, listed: demoListed });

/** A HOOK (the launcher's `useCount`): builds waiting to install, cut exactly as the sheet's `waiting`. */
function useWaiting(): LauncherItemCount | null {
  const records = usePullRecords();
  const { caps } = useInstallCaps();
  const allow = useInstallAllow();
  const log = useStore(installLog);
  // Not known yet = no badge at all, never a count over NO_INSTALL that changes a moment later. The
  // caps are core's ONE shared reading (re-asked on resume), the same the sheet's waiting cut reads.
  if (!caps) return null;
  const n = readyApps(appRows(buildsOf(records), allow, caps, log.doc.entries)).length;
  return n > 0 ? { n, title: `android apps — ${n} build${n === 1 ? "" : "s"} waiting to install` } : null;
}

export const manifest: FeatureManifest = {
  id: "android-apps",
  // The literal form (`tools/webshape.test.mjs` reads it); `state.ts` opens the same id as APPS_SHEET.
  sheets: [{ id: featureSheetId("android-apps", "main"), persisted: false, render: () => createElement(AppsSheet) }],
  launcherItems: [{
    id: "apps",
    label: "android apps",
    title: "android apps — your repos' APKs on this phone: build, download, install",
    icon: Boxes,
    open: (c) => { c.say.track("overlay:apps"); setNextCut({ kind: "all" }); c.nav.open(APPS_SHEET); },
    useCount: useWaiting,
    openCount: (c) => { c.say.track("overlay:apps"); setNextCut({ kind: "waiting" }); c.nav.open(APPS_SHEET); },
    // Builds can wait for days: the ☰ line badge and the ☰ total say it, never a key beside the bell.
    headerKey: false,
  }],
  appsDoor: {
    open: (c, cut) => { setNextCut(cut); c.nav.open(APPS_SHEET); },
  },
  hideWhen: () => isExtensionEnabled("android-apps") === false || !shellInstall.supported(),
  pushes: { changed: () => onChanged() },
  boot: () => startInstallLog(),
};
