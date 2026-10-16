/**
 * Settings → Connection, head: the desktops this phone knows (Android shell
 * only — in a browser the page is served by one host and there is no list),
 * then two rows that work in the browser PWA too (D10): "pair another phone"
 * (the QR sheet, minted by the host in use) and "paired devices" (the host's
 * device ledger, with revoke).
 */
import { FlaskConical, Globe, LogOut, Radar, QrCode, Server, Smartphone } from "lucide-react";
import { BRAND } from "@waterplane/shared";
import { SetAction, SetCustom } from "../../SettingsKit";
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
      {!isNativeShell() && (
        // The browser has no host list, so "add a desktop" is not drawn here — and
        // without this row nothing said how a second desktop (or a second phone)
        // is reached without the app.
        <SetCustom
          id="web-desktops" label="another desktop, without the app" icon={Globe}
          note="In a browser each desktop is its own address — no list, no code. Tap for the steps."
          more={<WebPairSteps />}
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

/** The no-app route, step by step — the same facts `host/pair.ts`'s landing page states. */
function WebPairSteps() {
  return (
    <ol className="web-pair-steps">
      <li>On the phone: Tailscale installed and signed in to the same tailnet as the desktop.</li>
      <li>
        Open that desktop's address in the browser — <code>https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net</code> once
        it runs <code>tailscale serve</code>, else <code>http://100.x.y.z:8770</code>. Or, on a phone already
        connected to it, Settings → pair another phone: scanning that QR opens a page whose "use web
        version" is the same address.
      </li>
      <li>Add it to the home screen — one icon per desktop (needs the https address).</li>
      <li>
        On your tailnet the address IS the sign-in: nothing to type. A desktop with a LAN password asks for
        that password instead. The pairing code is only for the Android app, which also keeps several
        desktops in one list with a switch on the launcher bar.
      </li>
    </ol>
  );
}
