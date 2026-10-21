import { useEffect, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { ago } from "./format";
import type { NotificationItem } from "@waterplane/shared";
import { clearToastLog, onToastLog, type ToastEntry } from "./toast";
import { ConfirmButton } from "./Confirm";
import { RowSub } from "./kit/Row";

/**
 * The messages THIS PHONE has shown, in the notification feed.
 *
 * Reported: toasts *"disappear too fast to read and also don't list in the
 * notification list"*. The feed answered "what happened?" for exactly the half
 * of this app's sentences that arrived over the wire; the other half — every
 * `showToast`, 225 call sites of them — was painted for two seconds and then
 * existed nowhere. So the feed carries both, under two headings.
 *
 * Two headings and not one merged list, deliberately. A host notification is a
 * thing that happened on the DESKTOP while you were not looking, it can be
 * muted per kind, it can carry a file to open, and it is pushed to the OS. A
 * row here is a thing this screen said about a tap you had just made. Sorting
 * them into one stream would put "copied" between two prompts that need a
 * person, which is the state the notification kinds exist to prevent. They are
 * labelled apart, cleared apart, and only the host's half moves the badge.
 *
 * A plain toast's row carries no action: it is a sentence, and the thing it was
 * about is reached from the screen that fired it. A toast that ANNOUNCED a
 * desktop alert is different — it carries the alert (`ToastEntry.notif`) and
 * its row opens it exactly as the desktop row does (`onOpen`). Reported as
 * "can not click the notifications": the host's feed is in memory, so after a
 * host restart these rows are the only copy of "Needs your decision" left.
 */
export function useToastLog(): ToastEntry[] {
  const [rows, setRows] = useState<ToastEntry[]>([]);
  useEffect(() => onToastLog(setRows), []);
  return rows;
}

export function ToastLog({ rows, onOpen }: { rows: ToastEntry[]; onOpen: (n: NotificationItem) => void }) {
  if (!rows.length) return null;
  return (
    <>
      <div className="notif-sec">
        <span className="notif-sec-title">
          <MessageSquare size={13} /> On this phone · {rows.length}
        </span>
        {/* Local and re-derivable from nothing, so the delete is real: it goes
            through the arming button rather than a native modal (`Confirm.tsx`). */}
        <ConfirmButton className="key" confirm="clear all?" title="clear messages" aria-label="clear messages" onConfirm={clearToastLog}><Trash2 size={13} /></ConfirmButton>
      </div>
      {rows.map((r) => (
        <div key={`${r.ts}:${r.text}`} className="notif-row">
          {r.notif ? (
            <button className="notif-open" onClick={() => onOpen(r.notif!)}>
              <span className="notif-icon"><MessageSquare size={16} /></span>
              <span className="notif-body">
                <span className="notif-text">{r.text}</span>
              </span>
            </button>
          ) : (
            <>
              <span className="notif-icon"><MessageSquare size={16} /></span>
              <span className="notif-body">
                <span className="notif-text">{r.text}</span>
              </span>
            </>
          )}
          {r.n > 1 && <RowSub>×{r.n}</RowSub>}
          <RowSub className="notif-time">{ago(r.ts)}</RowSub>
        </div>
      ))}
    </>
  );
}
