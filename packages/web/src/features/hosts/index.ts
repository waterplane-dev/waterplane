/**
 * Several desktops on one phone: the switcher sheet, the launcher menu's host row, the
 * header tag and the Settings rows — plus pairing (the QR sheet, the paired
 * devices list, the pairing deep-link `…://pair` link) — see README.md. Storage is `hosts.ts`.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { onShellPair } from "../../shellLink";
import { HostSwitcherSheet } from "./HostSwitcherSheet";
import { HostQrSheet } from "./HostQrSheet";
import { PairedDevicesSheet } from "./PairedDevicesSheet";
import { HostsSettings } from "./HostsSettings";
import { askPairFromLink, openEditActiveHost } from "./actions";
import { hostRouteEditor } from "../../hostRoute";
import { isNativeShell } from "../../hostUrl";

export { openEditActiveHost, openHosts, refreshHosts, setHostRoute } from "./actions";
export { useHosts, useHostRoute, type HostRouteView } from "./store";
export { HostMenuItem } from "./HostMenuItem";
export { HostNameTag } from "./HostNameTag";

export const manifest: FeatureManifest = {
  id: "hosts",
  sheets: [
    { id: "hosts", persisted: false, render: () => createElement(HostSwitcherSheet) },
    { id: "pairqr", persisted: false, render: () => createElement(HostQrSheet) },
    { id: "devices", persisted: false, render: () => createElement(PairedDevicesSheet) },
  ],
  settings: [
    // The very head of Connection, before the host tools' app version row.
    { group: "connection", order: -20, render: () => createElement(HostsSettings) },
  ],
  // A pairing deep-link `…://pair` link while the app is up opens the pair form, prefilled.
  // (Before a host exists, `main.tsx`'s setup screen takes it instead.)
  // Connection health's route sentence gets a button to this host's form —
  // shell only, the one place hosts are saved and edited.
  boot: () => {
    // Wrapped: `set` reads a bare function as an UPDATER and would call it —
    // which opened this host's edit form on every shell boot.
    if (isNativeShell()) hostRouteEditor.set(() => openEditActiveHost);
    const stop = onShellPair(askPairFromLink);
    return () => { hostRouteEditor.set(null); stop(); };
  },
};
