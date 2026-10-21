/**
 * The notification feed: what the DESKTOP raised, then what THIS PHONE said
 * (`ToastLog.tsx`), as two labelled halves — never one merged stream.
 */
import { useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Bell, Bot, CircleDot, CornerDownLeft, Download, Fingerprint, Flag, Flame, HeartPulse, Hourglass, Images, ListTodo, Puzzle, SendHorizontal, Trash2 } from "lucide-react";
import { useCore, useStore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { Empty } from "../../Empty";
import { ToastLog, useToastLog } from "../../ToastLog";
import { phoneHalfFirst } from "../../toast";
import { ago } from "../../format";
import { viewerHandles } from "../../docKind";
import { notifs as notifStore } from "./store";
import { markAllSeen, openNotif } from "./actions";
import { Button, RowSub } from "../../kit";

// Lucide icon per notification kind (no emoji) — the feed's rows and App's
// settings switches (`NOTIF_LABEL` in `logic.ts` is the words).
export const NOTIF_ICON: Record<string, LucideIcon> = {
  prompt: CircleDot,
  approval: Fingerprint,
  idle: CornerDownLeft,
  image: Images,
  autofire: SendHorizontal,
  backlog: ListTodo,
  followup: Flag,
  health: HeartPulse,
  plugin: Puzzle,
  info: Bell,
  limit: Hourglass,
  burn: Flame,
  agent: Bot,
  artifact: Download,
  undelivered: AlertTriangle,
};

export function NotificationsSheet() {
  const core = useCore();
  const notifs = useStore(notifStore);
  // This phone's own sentences — every `showToast`, kept as rows so the feed
  // answers "what did that just say?" for the half of them that never crossed
  // the wire (`toast.ts`). Deliberately NOT counted into the unread badge: a
  // badge that counts "copied" is a badge nobody reads.
  // A row that announced an alert still in the desktop half is that alert
  // twice; it is kept only once the desktop's copy is gone (cleared, or the
  // host restarted — its feed is in memory), where it is the one way back.
  const allLocal = useToastLog();
  const hostIds = new Set(notifs.map((n) => n.id));
  const localMsgs = allLocal.filter((r) => !r.notif || !hostIds.has(r.notif.id));
  // The half holding the newest row goes first (`phoneHalfFirst`): a long
  // toast read off the bottom of the sheet was reported as not listed at all.
  const phoneFirst = phoneHalfFirst(notifs.length ? Math.max(...notifs.map((n) => n.ts)) : undefined, localMsgs);
  // Being on screen marks everything read — including anything that arrives
  // while it is open (the newest ts becomes the seen marker).
  useEffect(() => { markAllSeen(); }, [notifs]);
  return (
    <div className="sheet">
      <SheetHead title={<><Bell size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} /> Notifications</>} onClose={() => core.nav.close("notifications")}>
        {/* Clears the DESKTOP half only — this phone's own messages have
            their own clear, beside their own heading. Absent rather than
            dimmed when there is nothing to clear. */}
        {notifs.length > 0 && (
          <Button onClick={() => core.conn.liveSend({ t: "notification.clear" }, "notifications cleared")} title="clear alerts from the desktop"><Trash2 size={14} /></Button>
        )}
      </SheetHead>
      <div className="list hist">
        {notifs.length === 0 && localMsgs.length === 0 && <Empty>No notifications yet.</Empty>}
        {/* Two labelled halves, never one merged stream: what the DESKTOP
            raised while you were not looking, then what THIS PHONE said.
            See `ToastLog.tsx` for why they are kept apart. */}
        {phoneFirst && <ToastLog rows={localMsgs} onOpen={openNotif} />}
        {notifs.length > 0 && localMsgs.length > 0 && (
          <div className="notif-sec"><span className="notif-sec-title"><Bell size={13} /> From the desktop · {notifs.length}</span></div>
        )}
        {notifs.map((n) => {
          const Icon = NOTIF_ICON[n.kind] ?? Bell;
          // A readable file gets TWO verbs, because they are two different
          // wants: read it here (the row) and keep it on the phone (the
          // arrow). One button carrying both is how tapping a 6 KB report
          // started a transfer nobody asked for.
          const readable = !!n.file && viewerHandles(n.file.relPath);
          return (
            <div key={n.id} className="notif-row">
              <button className="notif-open" onClick={() => openNotif(n)}>
                <span className={`notif-icon notif-${n.kind}`}><Icon size={16} /></span>
                <span className="notif-body">
                  <span className="notif-title">{n.title}</span>
                  {n.body && <span className="notif-text">{n.body}</span>}
                </span>
              </button>
              {n.file && (
                readable
                  ? <button className="notif-dl" title={`download ${n.file.name}`} aria-label={`download ${n.file.name}`}
                      onClick={() => { core.files.downloadArtifact(n.file!); core.say.toast(`downloading ${n.file!.name}`); }}><Download size={16} /></button>
                  : <span className="notif-dl" title="download"><Download size={16} /></span>
              )}
              <RowSub className="notif-time">{ago(n.ts)}</RowSub>
            </div>
          );
        })}
        {!phoneFirst && <ToastLog rows={localMsgs} onOpen={openNotif} />}
      </div>
    </div>
  );
}
