/**
 * The notification feed: what the DESKTOP raised, then what THIS PHONE said
 * (`ToastLog.tsx`), as two labelled halves — never one merged stream.
 */
import { useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Bell, Bot, CalendarClock, Check, CircleAlert, CircleDot, CornerDownLeft, Download, Fingerprint, Flag, Flame, GitBranch, HardDrive, ShieldAlert, HeartPulse, Info, Hourglass, Images, ListTodo, Puzzle, SendHorizontal, Trash2 } from "lucide-react";
import { useCore, useStore } from "../../sdk";
import { SheetHead } from "../../Sheet";
import { Empty } from "../../Empty";
import { ToastLog, useToastLog } from "../../ToastLog";
import { phoneHalfFirst } from "../../toast";
import { ago } from "../../format";
import { viewerHandles } from "../../docKind";
import { levelOf } from "@waterplane/shared";
import { notifCut, notifFocus, notifs as notifStore } from "./store";
import { clearNotifFocus, dismissInfoNote, handleNotif, infoNoteSeen, openNotif, showAllNotifs } from "./actions";
import { feedCut, feedCutWords, feedSections, handledWords, INFO_NOTE_TEXT } from "./logic";
import { Button, RowSub } from "../../kit";
import type { NotificationItem } from "@waterplane/shared";

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
  weekburn: CalendarClock,
  agent: Bot,
  disk: HardDrive,
  artifact: Download,
  undelivered: AlertTriangle,
  git: GitBranch,
  exposure: ShieldAlert,
};

export function NotificationsSheet() {
  const core = useCore();
  const all = useStore(notifStore);
  const only = useStore(notifCut);
  // A count opened this sheet on exactly its items ("3 of 41"); the cut and
  // the bell's number are one predicate (`needsYou`), see actions.openBell.
  const cut = feedCut(all, only);
  const notifs = cut.shown;
  const secs = feedSections(notifs);
  const [noteSeen, setNoteSeen] = useState(infoNoteSeen);
  // This phone's own sentences — every `showToast`, kept as rows so the feed
  // answers "what did that just say?" for the half of them that never crossed
  // the wire (`toast.ts`). Deliberately NOT counted into the unread badge: a
  // badge that counts "copied" is a badge nobody reads.
  // A row that announced an alert still in the desktop half is that alert
  // twice; it is kept only once the desktop's copy is gone (cleared, or the
  // host restarted — its feed is in memory), where it is the one way back.
  const allLocal = useToastLog();
  const hostIds = new Set(all.map((n) => n.id));
  const localMsgs = allLocal.filter((r) => !r.notif || !hostIds.has(r.notif.id));
  // The half holding the newest row goes first (`phoneHalfFirst`): a long
  // toast read off the bottom of the sheet was reported as not listed at all.
  const phoneFirst = phoneHalfFirst(all.length ? Math.max(...all.map((n) => n.ts)) : undefined, localMsgs);
  // A tap that had nowhere else to land (`openNotif`'s floor) asked for ONE
  // row: scroll it into view and flash it once, so the reader sees which.
  const focus = useStore(notifFocus);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!focus) return;
    focusRef.current?.scrollIntoView({ block: "center" });
    setFlash(focus);
    clearNotifFocus();
  }, [focus]);
  return (
    <div className="sheet">
      <SheetHead title={<><Bell size={16} style={{ verticalAlign: "-3px", marginRight: 4 }} /> Notifications</>} onClose={() => core.nav.close("notifications")}>
        {/* Clears the DESKTOP half only — this phone's own messages have
            their own clear, beside their own heading. Absent rather than
            dimmed when there is nothing to clear. */}
        {all.length > 0 && !cut.filtered && (
          <Button onClick={() => core.conn.liveSend({ t: "notification.clear" }, "notifications cleared")} title="clear alerts from the desktop"><Trash2 size={14} /></Button>
        )}
      </SheetHead>
      <div className="list hist">
        {!noteSeen && (
          <div className="filter-bar">
            <span className="filter-bar-txt">{INFO_NOTE_TEXT}</span>
            <button className="filter-bar-clear" onClick={() => { dismissInfoNote(); setNoteSeen(true); }}>got it</button>
          </div>
        )}
        {cut.filtered && (
          <div className="filter-bar">
            <span className="filter-bar-txt">{feedCutWords(cut.shown.length, cut.total)}</span>
            <button className="filter-bar-clear" onClick={showAllNotifs}>show all</button>
          </div>
        )}
        {all.length === 0 && localMsgs.length === 0 && <Empty>No notifications yet.</Empty>}
        {/* Two labelled halves, never one merged stream: what the DESKTOP
            raised while you were not looking, then what THIS PHONE said.
            See `ToastLog.tsx` for why they are kept apart. */}
        {phoneFirst && <ToastLog rows={localMsgs} onOpen={openNotif} />}
        {notifs.length > 0 && localMsgs.length > 0 && (
          <div className="notif-sec"><span className="notif-sec-title"><Bell size={13} /> From the desktop · {all.length}</span></div>
        )}
        {notifs.length > 0 && (() => {
          const row = (n: NotificationItem) => {
            const Icon = NOTIF_ICON[n.kind] ?? Bell;
            // A readable file gets TWO verbs, because they are two different
            // wants: read it here (the row) and keep it on the phone (the
            // arrow). One button carrying both is how tapping a 6 KB report
            // started a transfer nobody asked for.
            const readable = !!n.file && viewerHandles(n.file.relPath);
            const needs = levelOf(n) === "attention";
            return (
              <div key={n.id} ref={n.id === focus ? focusRef : undefined}
                className={n.id === flash ? "notif-row nh-flash" : "notif-row"}>
                <button className="notif-open" onClick={() => openNotif(n)}>
                  <span className={`notif-icon notif-${n.kind}`}><Icon size={16} /></span>
                  <span className="notif-body">
                    <span className="notif-title">{n.title}</span>
                    {n.body && <span className="notif-text">{n.body}</span>}
                    {n.handled && <span className="notif-text notif-done">{handledWords(n.handled)}</span>}
                  </span>
                </button>
                {n.file && (
                  readable
                    ? <button className="notif-dl" title={`download ${n.file.name}`} aria-label={`download ${n.file.name}`}
                        onClick={() => { core.files.downloadArtifact(n.file!); core.say.toast(`downloading ${n.file!.name}`); }}><Download size={16} /></button>
                    : <span className="notif-dl" title="download"><Download size={16} /></span>
                )}
                {needs && !n.handled && (
                  <Button onClick={() => handleNotif(n.id)} title="mark this as dealt with — opening it does not">done</Button>
                )}
                <RowSub className="notif-time">{ago(n.ts)}</RowSub>
              </div>
            );
          };
          return (
            <>
              {secs.needs.length > 0 && (
                <div className="notif-sec"><span className="notif-sec-title"><CircleAlert size={13} /> Needs you · {secs.needs.length}</span></div>
              )}
              {secs.needs.map(row)}
              {secs.handled.length > 0 && (
                <div className="notif-sec"><span className="notif-sec-title"><Check size={13} /> Done · {secs.handled.length}</span></div>
              )}
              {secs.handled.map(row)}
              {secs.info.length > 0 && (
                <div className="notif-sec"><span className="notif-sec-title"><Info size={13} /> Information</span></div>
              )}
              {secs.info.map(row)}
            </>
          );
        })()}
        {!phoneFirst && <ToastLog rows={localMsgs} onOpen={openNotif} />}
      </div>
    </div>
  );
}
