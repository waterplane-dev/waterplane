/**
 * Several desktops on one phone: the switcher sheet, the launcher menu's host row, the
 * header tag and the Settings rows — plus pairing (the QR sheet, the paired
 * devices list, the pairing deep-link `…://pair` link) — see README.md. Storage is `hosts.ts`.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { onShellPair, resyncShellLink } from "../../shellLink";
import { HostSwitcherSheet } from "./HostSwitcherSheet";
import { HostQrSheet } from "./HostQrSheet";
import { PairedDevicesSheet } from "./PairedDevicesSheet";
import { HostsSettings } from "./HostsSettings";
import { ElsewhereSheet } from "./ElsewhereSheet";
import { askPairFromLink, openEditActiveHost, pairActiveByCode, startElsewherePoll } from "./actions";
import { hostRouteEditor, hostRoutePair } from "../../hostRoute";
import { isNativeShell } from "../../hostUrl";
import { activeHost, browserKV, listHosts, realHosts, takeOpenAfter, takeSwitchFailure } from "../../hosts";
import { cachedPassive } from "../../passiveMode";
import { core, isDemo } from "../../sdk";
import { switchFailText } from "./logic";
import { hosts } from "./store";

export { activeDesktopId, openEditActiveHost, openFromOtherDesktop, openHosts, refreshHosts, setHostRoute } from "./actions";
export { useHosts, useHostRoute, type HostRouteView } from "./store";
export { HostMenuItem } from "./HostMenuItem";
export { HostNameTag } from "./HostNameTag";
export { HostSwitchKey } from "./HostSwitchKey";
export { ElsewhereChip } from "./ElsewhereChip";

export const manifest: FeatureManifest = {
  id: "hosts",
  sheets: [
    { id: "hosts", persisted: false, render: () => createElement(HostSwitcherSheet) },
    { id: "pairqr", persisted: false, render: () => createElement(HostQrSheet) },
    { id: "devices", persisted: false, render: () => createElement(PairedDevicesSheet) },
    { id: "elsewhere", persisted: false, render: () => createElement(ElsewhereSheet) },
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
    if (isNativeShell()) { hostRouteEditor.set(() => openEditActiveHost); hostRoutePair.set(() => pairActiveByCode); }
    // A switch the last boot could not carry out (storage full) says so once,
    // in words — before, the switch key just kept naming the old desktop.
    const failed = isNativeShell() ? takeSwitchFailure(browserKV()) : null;
    if (failed) core().say.toast(switchFailText(failed, hosts.get().hosts));
    // A tap on one waiting item of another desktop switched here to land on it: once, through
    // the shell's own open bridge (it parks the target until `useOutsideOpens` has a handler).
    const open = isNativeShell() ? takeOpenAfter(browserKV(), activeHost()?.id ?? null) : null;
    if (open) (window as { shellOpen?: (s: string) => boolean }).shellOpen?.(open);
    const stop = onShellPair(askPairFromLink);
    // The background link watches every saved desktop; an add or remove that reloaded the page
    // (a switch, "add + switch") happened before this boot — re-point it once (only if it is on).
    if (isNativeShell() && !isDemo()) void resyncShellLink();
    // Ask the OTHER desktops what waits on the person there — shell only, two or more of their
    // own desktops, never the demo or a passive (kids') device.
    const watch = isNativeShell() && !isDemo() && !cachedPassive() && realHosts(listHosts()).length >= 2;
    const stopPoll = watch ? startElsewherePoll() : null;
    return () => { hostRouteEditor.set(null); hostRoutePair.set(null); stop(); stopPoll?.(); };
  },
};
