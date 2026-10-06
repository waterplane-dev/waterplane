/**
 * Settings → Connection, head: the desktops this phone knows (Android shell
 * only — in a browser the page is served by one host and there is no list),
 * then two rows that work in the browser PWA too (D10): "pair another phone"
 * (the QR sheet, minted by the host in use) and "paired devices" (the host's
 * device ledger, with revoke).
 */
import { FlaskConical, LogOut, Radar, QrCode, Server, Smartphone } from "lucide-react";
import { BRAND } from "@waterplane/shared";
import { SetAction } from "../../SettingsKit";
import { isNativeShell } from "../../hostUrl";
import { isDemo, leaveDemo, tryDemo } from "../../demoEntry";
import { openHosts, openPairQr, openPairedDevices, showAddHost } from "./actions";
import { hostAddress } from "./logic";
import { useHosts } from "./store";

export function HostsSettings() {
  const { hosts, activeId } = useHosts();
  const active = hosts.find((h) => h.id === activeId);
  return (
    <>
      {isNativeShell() && (
        <SetAction
          id="hosts" label="hosts" icon={Server} opens
          onClick={() => { openHosts(); }}
          note={active
            ? `In use: ${active.name} at ${hostAddress(active.base)}. Add, edit, switch or remove desktops.`
            : "No desktop saved yet."}
        />
      )}
      {isNativeShell() && (
        <SetAction
          id="add-desktop" label="add a desktop" icon={Radar} opens
          onClick={() => { openHosts(); showAddHost(); }}
          note={`Desktops running ${BRAND.displayName} on your tailnet are listed — one tap adds one. Typing an address or a pairing code still works there.`}
        />
      )}
      {isDemo() ? (
        <SetAction
          id="demo" label="leave the demo" icon={LogOut}
          onClick={leaveDemo}
          note="Back to your own desktop. Nothing in the demo is kept."
        />
      ) : (
        <SetAction
          id="demo" label="try the demo" icon={FlaskConical}
          onClick={() => tryDemo()}
          note="A pretend desktop with sample repos and a session to answer — nothing connects and nothing runs. Your own desktop's drafts and queue are set aside, not touched."
        />
      )}
      <SetAction
        id="pair-phone" label="pair another phone" icon={QrCode} opens
        onClick={openPairQr}
        note="Shows a QR and a one-time code from this desktop. The new phone scans it — web version or the app — and gets its own sign-in."
      />
      <SetAction
        id="paired-devices" label="paired devices" icon={Smartphone} opens
        onClick={openPairedDevices}
        note="The phones with their own sign-in for this desktop: when each was last seen, and revoke."
      />
    </>
  );
}
