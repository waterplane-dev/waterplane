/**
 * The Notifications group's first two rows: the door into the feed, and which
 * kinds of alert may fire at all. How an alert REACHES this phone (Web Push, the
 * APK's background link) is the host tools' rows, drawn after these.
 */
import { NOTIFICATION_KINDS, notifyEnabled } from "@waterplane/shared";
import { Bell, BellOff } from "lucide-react";
import { SetAction, SetCustom, SetSwitch } from "../../SettingsKit";
import { openNotifs, setNotifyKind } from "./actions";
import { NOTIF_LABEL } from "./logic";
import { NOTIF_ICON } from "./NotificationsSheet";
import { useNotifyPrefs, useUnread } from "./store";

export function NotificationSettings() {
  const unreadNotifs = useUnread();
  const notifyPrefs = useNotifyPrefs();
  return (
    <>
      <SetAction
        id="notif-feed" label={`open the feed${unreadNotifs > 0 ? ` (${unreadNotifs})` : ""}`} icon={Bell} opens
        onClick={() => { openNotifs(); }}
        note="Every alert you leave switched on below lands in the in-app feed — works even without HTTPS."
      />

      {/* Six switches, one searchable row: they are one decision asked
          six times, and six full rows of prose was most of what made
          this screen unreadable. */}
      <SetCustom
        id="notif-kinds" label="what may fire" icon={BellOff}
        note="A kind switched off is dropped by the host — no feed row and no OS push, on every device."
        more={<p>The mute follows the account, not the browser, because the push is sent from the desktop.</p>}
      >
        <div className="set-kinds">
          {NOTIFICATION_KINDS.map((k) => {
            const on = notifyEnabled(notifyPrefs, k);
            const Icon = NOTIF_ICON[k] ?? Bell;
            const meta = NOTIF_LABEL[k];
            return (
              <SetSwitch
                key={k} label={meta?.name ?? k} icon={on ? Icon : BellOff}
                on={on}
                onChange={() => setNotifyKind(k, !on, meta?.name ?? k)}
                note={meta?.note}
              />
            );
          })}
        </div>
      </SetCustom>
    </>
  );
}
