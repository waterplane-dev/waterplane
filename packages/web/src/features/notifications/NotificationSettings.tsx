/**
 * The Notifications group's first two rows: the door into the feed, and which
 * kinds of alert may fire at all. How an alert REACHES this phone (Web Push, the
 * APK's background link) is the host tools' rows, drawn after these.
 */
import { NOTIFICATION_KINDS, notifyEnabled } from "@waterplane/shared";
import { Bell, BellOff, Info } from "lucide-react";
import { SetAction, SetCustom, SetSwitch } from "../../SettingsKit";
import { openNotifs, setNotifyKind, setPushInfo } from "./actions";
import { NOTIF_LABEL, levelWords } from "./logic";
import { NOTIF_ICON } from "./NotificationsSheet";
import { pushInfo, useNotifyPrefs, useUnread } from "./store";
import { useStore } from "../../sdk";

export function NotificationSettings() {
  const unreadNotifs = useUnread();
  const notifyPrefs = useNotifyPrefs();
  const infoPushed = useStore(pushInfo);
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
                note={meta ? `${meta.note} Lands in: ${levelWords(k)}.` : undefined}
              />
            );
          })}
        </div>
      </SetCustom>

      <SetSwitch
        label="Push information too" icon={Info} on={infoPushed}
        onChange={() => setPushInfo(!infoPushed)}
        note="Off: only what needs you buzzes the phone. On: receipts (a push that went through, a new file) push as well. Either way they are listed in the feed and never count on the bell."
      />
    </>
  );
}
