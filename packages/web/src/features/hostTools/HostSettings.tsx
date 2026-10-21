/**
 * The host tools' Settings rows, in two groups:
 *  - Notifications (order 20, after the feed and the mutes): how an alert
 *    REACHES this phone — Web Push, or the APK's background link.
 *  - Connection (order -10, before the password rows): the app version, and
 *    the ways to reach this host from a browser. Which hosts the APK knows is
 *    `features/hosts` (order -20).
 * The two door rack entries (`tool-host-stat`, `tool-screenshot`) stay in the
 * core sheet's rack — they sit mid-rack, and a feature's band can only open it.
 */
import { useState } from "react";
import { BatteryCharging, Bell, BellOff, Copy, ExternalLink, Smartphone, Wifi, WifiOff } from "lucide-react";
import { core } from "../../sdk";
import { SetAction, SetCustom, SetNote, SetSwitch, SetWarn } from "../../SettingsKit";
import { copyText } from "../../api";
import { requestShellBatteryExemption, shellLinkSupported } from "../../shellLink";
import { usePhoneSetup } from "../../usePhoneSetup";
import { setupSummary } from "../../phoneSetup";
import { SetupStepRows } from "./PhoneSetupSheet";
import { isNativeShell } from "../../hostUrl";
import { AppUpdateSection } from "../../AppUpdate";
import { showToast } from "../../toast";
import { refreshShellLink, togglePush, toggleShellLink, useShellLinkPoll } from "./actions";
import { NO_BACKGROUND_ALERTS, endpoints, serveCmd } from "./logic";
import { useHostPush, useShellLink } from "./store";
import { Button } from "../../kit";

const ICON = 16;

/**
 * **This phone's setup, as one checklist.** Every step is a system dialog or a
 * Settings switch only the person can flip; each missing one gets the one tap
 * that leads there, and the list re-reads itself when the app comes back to the
 * front (`usePhoneSetup`). The launcher's banner opens `PhoneSetupSheet`, which
 * draws the same rows cut to the missing ones.
 */
function PhoneSetupChecklist() {
  const { steps, refresh } = usePhoneSetup();
  const [open, setOpen] = useState(false);
  if (!steps) return null;
  // Everything allowed: one line, not four "done" rows. The line says so and
  // names the way back to the rows.
  if (steps.every((s) => s.done) && !open) {
    return (
      <SetCustom id="phone-setup" label={`phone setup · ${setupSummary(steps)}`} icon={Smartphone}>
        <SetNote>
          Everything Android needs is allowed. <button className="link-btn" onClick={() => setOpen(true)}>show the {steps.length} steps</button>
        </SetNote>
      </SetCustom>
    );
  }
  return (
    <SetCustom id="phone-setup" label={`phone setup · ${setupSummary(steps)}`} icon={Smartphone}
      note="What Android needs you to allow before this app works with the app closed. Nothing is granted without your tap.">
      <SetupStepRows steps={steps} refresh={refresh} />
    </SetCustom>
  );
}

/** Notifications group: OS push, the background link, and its battery ask. */
export function HostNotifySettings() {
  // The only screen that draws the link's state polls it, for exactly as long
  // as it is drawn (Settings unmounts under every other sheet).
  useShellLinkPoll(true);
  const push = useHostPush();
  const shellLink = useShellLink();
  const cmd = serveCmd(core().conn.info);
  return (
    <>
      {shellLink && <PhoneSetupChecklist />}
      {push === "insecure" ? (
        <SetCustom id="notif-push" label="OS push" icon={BellOff}>
          <SetWarn>
            OS-level push is off: you're on {location.protocol}//{location.host} — plain HTTP over Tailscale
            is not a secure context, so service workers &amp; Web Push are disabled. The in-app feed above still works.
          </SetWarn>
          <SetNote>
            <div>Enable OS push — run on the desktop host, then reopen via the HTTPS name (if 443 is already taken here, use any free port instead: <code>--https=8771</code>):</div>
            <div className="cmd-copy">
              <code>{cmd}</code>
              <Button onClick={async () => showToast(await copyText(cmd) ? "command copied" : "copy failed")}><Copy size={ICON} /></Button>
            </div>
          </SetNote>
        </SetCustom>
      ) : push === "native" && !shellLinkSupported() ? (
        /* A shell with no background link — the iOS shell. No push either
           (that needs a paid Apple account and APNs), so alerts exist only
           while the app is on screen, and the row says exactly that. */
        <SetCustom id="notif-push" label="OS push" icon={BellOff} note={NO_BACKGROUND_ALERTS} />
      ) : push === "native" ? (
        /* The shell has no Web Push (no service worker in the APK, by
           design — see `push.ts`). What matters is not that the switch
           is missing but WHICH alerts stop and WHEN: the background
           link talks to the host over the tunnel, so a tunnel that is
           down is a phone that says nothing, and saying nothing is what
           "nothing happened" also looks like. Browser push does not
           share that failure — the host posts it out to the push
           service over ordinary internet, no tailnet involved — so the
           honest fix is the installed PWA, and it is named. */
        <SetCustom
          id="notif-push" label="OS push" icon={BellOff}
          note="This app has no OS push of its own — alerts reach it through the background link below."
          more={<>
            <p>The link speaks to the desktop over Tailscale, so when the tunnel is down this phone goes quiet — and quiet here does not mean nothing happened. Anything sent while it was down arrives when the link comes back.</p>
            <p>For alerts that survive a dead tunnel, open the host's HTTPS name in the browser and install it to the home screen: the desktop sends those out over the internet, not over the tailnet.</p>
          </>}
        />
      ) : push === "demo" ? (
        <SetCustom id="notif-push" label="OS push" icon={BellOff}
          note="The demo sends no alerts — it never leaves this device. With your own desktop connected, alerts reach this phone." />
      ) : push === "unsupported" ? (
        <SetCustom id="notif-push" label="OS push" icon={BellOff}
          note="This browser has no Web Push support — use the in-app feed." />
      ) : (
        <SetSwitch
          id="notif-push" label="OS push" icon={push === "denied" ? BellOff : Bell}
          on={push === "on"}
          state={push === "on" ? "on" : push === "denied" ? "blocked in browser" : "off"}
          tone={push === "denied" ? "danger" : undefined}
          onChange={togglePush}
          note="OS-level push on top of the in-app feed."
        />
      )}

      {/* The APK's background link. Not an alternative to the rows
          above but the thing that makes them possible at all in the
          shell: with no foreground service Android's cached-app freezer
          suspends the whole process minutes after backgrounding — JS,
          timers and the socket — and Android System WebView has no Push
          API to wake it. The service's mere existence keeps the process
          out of the freezer; it speaks its own small socket only for
          the one case the page cannot cover, the app swiped away. */}
      {shellLink && (
        <SetSwitch
          id="notif-shell-link" label="background link" icon={shellLink.running ? Wifi : WifiOff}
          on={!!shellLink.running}
          state={shellLink.enabled ? (shellLink.running ? shellLink.state : "starting…") : "off"}
          tone={shellLink.error ? "danger" : undefined}
          onChange={toggleShellLink}
          note="Keeps the connection alive with the app closed, and drains queued sends in the background."
        >
          {shellLink.error && <SetWarn>{shellLink.error}</SetWarn>}
          {shellLink.enabled && !shellLink.notifications && (
            <SetWarn tone="plain">
              Notification permission is off, so the link runs but cannot tell you anything —
              the queue still drains. Allow it under phone setup above.
            </SetWarn>
          )}
        </SetSwitch>
      )}

      {shellLink?.enabled && !shellLink.batteryExempt && (
        <SetAction
          id="notif-shell-battery" label="allow background use" icon={BatteryCharging}
          onClick={async () => { await requestShellBatteryExemption(); await refreshShellLink(); }}
          note="Not only battery: a dozing app cannot start the service from the background."
          more={<p>So this is also what makes the link come back after a reboot.</p>}
        />
      )}
    </>
  );
}

/** Connection group, head: the app version, the endpoints. */
export function HostConnectionSettings() {
  const list = endpoints(core().conn.info);
  return (
    <>
      {/* Which desktops this APK knows is the `hosts` feature's row, drawn
          just above this group's head (order -20). */}
      {/* Its own component, because the update state machine (checking,
          downloading, staged, applying) is more than a row. `bare` so it
          draws into this group rather than opening a section of its
          own. */}
      {isNativeShell() && (
        <SetCustom id="app-version" label="app version" icon={Smartphone}>
          <AppUpdateSection bare onToast={showToast} />
        </SetCustom>
      )}

      {/* Hidden in the Android shell: every button here NAVIGATES to
          another origin, which in the APK means leaving the bundled
          shell for the network — throwing away the exact property the
          APK exists for. The shell's equivalent is the "hosts" row. */}
      {list.length > 0 && !isNativeShell() && (
        <SetCustom
          id="endpoints" label="how you reach this host" icon={ExternalLink}
          note="Reopen the app on a different path to this host."
          more={<p>Same WiFi? The LAN address skips the tunnel. Want OS push &amp; install? Use the HTTPS name.</p>}
        >
          <div className="set-chips">
            {list.map((e) => {
              const here = location.origin === new URL(e.url).origin;
              return (
                <Button
                  key={e.url}
                  className={here ? "active" : ""}
                  title={e.note}
                  onClick={() => { if (!here) location.href = e.url; }}
                >
                  <ExternalLink size={12} /> {e.label}: {e.url.replace(/^https?:\/\//, "")}{here ? " ✓" : ""}
                </Button>
              );
            })}
          </div>
        </SetCustom>
      )}
    </>
  );
}
