/**
 * The live desktop extension's web half: one full sheet (the view), a Desktop line in the session's
 * ☰ menu whose open gives it a segment in the header beside Claude and Shell (core's
 * `headerViews.ts`, × to take it down), and a Desktop line in the launcher's ☰ menu (it once took a
 * whole row on the home screen; in the menu it costs nothing). The view has its own close. Plan:
 * docs/analysis/desktop-stream-plan.md §3–§5; contract: `shared/wire.mts`. Imports only the SDK,
 * the kit, shared, react, lucide-react and its own folder (`local/extension-boundary`).
 *
 * The entry is drawn whether or not the desktop can serve a view; when it cannot, `available()`
 * is the sentence a tap shows (`words.ts`) — from the cached `probe`, re-asked on every reconnect.
 */
import { createElement } from "react";
import { Monitor } from "lucide-react";
import { featureSheetId, type FeatureManifest } from "@waterplane/sdk";
import { DesktopSheet } from "./DesktopSheet.tsx";
import { desktopAvailability, openDesktop, refreshProbe } from "./state.ts";

export const manifest: FeatureManifest = {
  id: "desktop",
  // The literal form (`tools/webshape.test.mjs` reads it); `state.ts` opens the same id as DESKTOP_SHEET.
  sheets: [{ id: featureSheetId("desktop", "view"), persisted: false, render: () => createElement(DesktopSheet) }],
  sessionViews: [{ id: "desktop", label: "Desktop", icon: Monitor, available: desktopAvailability, open: () => openDesktop() }],
  launcherItems: [{ id: "desktop", label: "Desktop", icon: Monitor, order: 10, available: desktopAvailability, open: () => openDesktop() }],
  messages: { welcome: () => { void refreshProbe(); } },
};
