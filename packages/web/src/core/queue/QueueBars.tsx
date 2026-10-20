/**
 * The queue's two bars, rendered on the launcher AND inside a session — a
 * queue built while offline is global, and "did that go?" must be answerable
 * without first finding the right session.
 *
 * Top bar = the reconnect question. Bottom bar = the standing queue/recovery
 * state (waiting / sending / not delivered).
 *
 * Lifted verbatim from App's `renderQueueBars`; everything it acts with is the
 * queue's own (`QueueApi`) or App's view state, passed in.
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle, Check, CloudOff, Hourglass, ListOrdered, Loader, Pause, Radio, RotateCw, SendHorizontal, X, Zap,
} from "lucide-react";
import type { OutboxEntry } from "../../outbox";
import type { PullRecord } from "../../pull";
import type { Overlay } from "../../routing";
import { PullBar, PullBrowserAsk } from "../../PullSheet";
import { autoPull, pulls } from "../../pull";
import { core } from "../api.ts";
import { stripRows } from "../../downloadState";
import { confirmingLine, hostStillConfirming } from "../../sendConfirm";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { setPref } from "../prefs.ts";
// Activity, cut to what a strip counted (a count on a control is a filter).
import { openActivityOn } from "../../features/activity";
import { WHICH_MAX, sendingLabel, whichWords } from "./logic.ts";
import type { QueueApi } from "./useQueue.ts";
import type { Connection } from "../conn/useConnection";

/** Stop a tap from blurring the compose box (which would dismiss the keyboard). */
const keepFocus = (e: ReactPointerEvent) => e.preventDefault();

export interface QueueBarsProps {
  q: Pick<QueueApi, "entries" | "parkedSends" | "sendSettled" | "holdQueueRef" | "flushIdleReason" | "flushOutbox"
    | "idleReason" | "restoreOutbox" | "dismissOutbox" | "laneLabel">;
  status: Connection["status"];
  reconnectAsk: boolean;
  setReconnectAsk(v: boolean): void;
  autoSend: boolean;
  confirmQueue: boolean;
  pullRecords: PullRecord[];
  setOverlay(o: Overlay): void;
  /**
   * The session whose `NextPrompt` strip is on screen right above this bar —
   * inside a session only. That strip already names the next prompt in its
   * own words, says how many are behind it, and offers *send now* and the
   * queue. When every queued entry is in that one session the bar's queued
   * branch would repeat the same fact as a bare count with a second, wider
   * *Send now*, so it steps aside.
   */
  stripSessionId?: string;
}

export function QueueBars(props: QueueBarsProps) {
  const {
    q, status, reconnectAsk, setReconnectAsk, autoSend, confirmQueue, pullRecords, setOverlay, stripSessionId,
  } = props;
  const { entries: outbox, parkedSends, sendSettled, holdQueueRef, flushIdleReason, flushOutbox, idleReason,
    restoreOutbox, dismissOutbox, laneLabel } = q;
  const now = Date.now();
  // A row the HOST has not finished asking about is not a failure yet
  // (`sendConfirm.ts`). It is split out of `failed` rather than filtered away:
  // it gets its own sentence in the same strip, because "the desktop is
  // checking" is a thing worth seeing — it is only the red triangle and the
  // three recovery buttons that are wrong while it is true.
  const confirming = outbox.filter((e) => hostStillConfirming(e, now));
  const failed = outbox.filter((e) => e.status === "failed" && !hostStillConfirming(e, now));
  // A `queued` entry that is counting down a retry backoff is NOT waiting for
  // the user or for the link — it is mid-delivery, between two attempts. It is
  // grouped with the in-flight ones for DISPLAY only, and the reason is
  // layout: the queued branch renders three buttons and wraps to two rows
  // while the sending branch is one row, so classifying a retry as "queued"
  // made the bar change HEIGHT on every attempt, shunting the whole list
  // underneath it up and down. At the old ~2 Hz retry rate that was the
  // flicker; even at a healthy three attempts it is three jumps and an
  // elapsed counter that resets to 0s each time, which reads as "the upload
  // keeps getting killed". One shape for the whole delivery, with the label
  // saying which phase it is in.
  const retrying = (e: OutboxEntry) => e.status === "queued" && e.retryAt != null && e.retryAt > now;
  const queuedAll = outbox.filter((e) => e.status === "queued" && !retrying(e));
  // Only while the link is up and nothing is held by hand: offline and a
  // manual hold are this bar's own facts (and its auto switch), not the strip's.
  // ALL or nothing — hiding some would leave a *Send now* here that flushes
  // rows the bar no longer shows.
  const covered = !!stripSessionId && status === "open" && !holdQueueRef.current
    && queuedAll.length > 0 && queuedAll.every((e) => e.sessionId === stripSessionId);
  const queued = covered ? [] : queuedAll;
  const flying = outbox.filter((e) => e.status === "pending" || retrying(e));
  const inFlight = flying.length > 0;
  const asking = reconnectAsk && parkedSends.length > 0;
  // The auto-download queue rides the same strip: it is the same kind of fact
  // ("work is in flight that you didn't have to watch"), just in the other
  // direction, and a second floating bar somewhere else would be missed.
  // Removing a stopped row from the strip is the sheet's per-row remove, done
  // for each: dropped here, and the host told about the rows that came from
  // its queue (a row this phone tapped is not in it).
  const removePulls = (rows: PullRecord[]) => {
    track("action:pull.strip.remove");
    for (const r of rows) void pulls.remove(r.item.id);
    const fromHost = rows.filter((r) => !r.local).map((r) => ({ t: "pull.dismiss" as const, id: r.item.id }));
    const done = `removed ${rows.length === 1 ? rows[0].item.name : `${rows.length} stopped downloads`}`;
    if (!fromHost.length) showToast(done);
    else core().conn.liveSendAll(fromHost, done,
      `${done} here — the desktop's queue still lists ${fromHost.length === 1 ? "it" : "them"} until the link is back`);
  };
  const pullBar = <PullBar records={pullRecords} onRemove={removePulls}
    onOpen={() => { track("overlay:pull"); setOverlay("pull"); }} />;
  // The same cut the strip draws (`stripRows`): a file waiting for a tap with
  // auto-download off here keeps no bar on screen.
  const pullActive = stripRows(pullRecords, autoPull()).length > 0;
  if (!asking && !failed.length && !confirming.length && !queued.length && !inFlight && !pullActive && !sendSettled) return null;
  return (
    <>
      {pullBar}
      <PullBrowserAsk records={pullRecords} />
      {reconnectAsk && parkedSends.length > 0 && (
        <div className="outbox-recover ask">
          <Radio size={14} />
          <span>Back online — send {parkedSends.length} message{parkedSends.length > 1 ? "s" : ""} you queued while offline?</span>
          <button className="key" onPointerDown={keepFocus} onClick={() => {
            track("action:queue.confirm.send");
            const n = flushOutbox(true);
            setReconnectAsk(false);
            showToast(n ? "sending queued messages…" : idleReason("nothing left to send"));
          }}><SendHorizontal size={14} /> Send</button>
          <button className="key" onPointerDown={keepFocus} onClick={() => { track("action:queue.confirm.review"); setOverlay("queue"); }}>
            <ListOrdered size={14} /> Review
          </button>
          <button className="key" onPointerDown={keepFocus} onClick={() => { track("action:queue.confirm.hold"); setReconnectAsk(false); }}
            title="keep them queued — nothing is sent until you release it">
            <X size={14} /> Hold
          </button>
        </div>
      )}
      {(failed.length === 0 && confirming.length === 0 && queuedAll.length === 0 && !inFlight && sendSettled) && (
        // The linger frame (see QUEUE_BAR_LINGER_MS): same shape, same height,
        // so the terminal above it does not resize between one send and the
        // next — and it says the thing the bar used to say by disappearing.
        <div className="outbox-recover sending">
          <Check size={14} />
          <span>sent</span>
        </div>
      )}
      {(failed.length > 0 || confirming.length > 0 || queued.length > 0 || inFlight) && (
        <div className={`outbox-recover ${failed.length ? "failed" : confirming.length ? "confirming" : queued.length ? "queued" : "sending"}`}>
          {failed.length > 0 ? (
            <>
              <AlertTriangle size={14} />
              {/* The reason is only shown when there is exactly ONE row it
                  can be about. With several, the newest row's sentence was
                  printed as if it explained all of them — so a banner reading
                  "2 messages not delivered" would go on to give one of the two
                  a reason that did not apply to the other, and the count and
                  the sentence contradicted each other. Several rows have
                  several reasons; that list is Manage. */}
              <span>{failed.length} message{failed.length > 1 ? "s" : ""} not delivered{failed.length === 1 && failed[0].reason ? ` — ${failed[0].reason}` : ""}</span>
              <button className="key" onPointerDown={keepFocus} onClick={restoreOutbox}><RotateCw size={14} /> Restore</button>
              <button className="key" onPointerDown={keepFocus} onClick={() => { track("action:queue.manage"); openActivityOn(failed, "the messages that were not delivered"); }}><ListOrdered size={14} /> Manage</button>
              <button className="key" onPointerDown={keepFocus} onClick={dismissOutbox}><X size={14} /> Dismiss</button>
              {/* WHICH ones. A count with no names is the whole complaint
                  this answers: "2 messages not delivered" over a Manage
                  button that opened 200 rows left the person to work out
                  which two by memory. The reason still cannot be printed up
                  here when there are several (see above) — but the WORDS can,
                  and the words are how a person recognises their own prompt.
                  Each line opens Activity showing that row alone. */}
              {failed.length > 1 ? (
                <div className="outbox-which">
                  {failed.slice(0, WHICH_MAX).map((e) => (
                    <button key={e.ackId} className="outbox-which-row" onPointerDown={keepFocus}
                      title="open this one in Activity"
                      onClick={() => { track("action:queue.which"); openActivityOn([e], "the message you tapped"); }}>
                      <span className="outbox-which-where">{laneLabel(e)}</span>
                      <span className="outbox-which-text">{whichWords(e)}</span>
                    </button>
                  ))}
                  {failed.length > WHICH_MAX ? (
                    <button className="outbox-which-row more" onPointerDown={keepFocus}
                      onClick={() => { track("action:queue.which.more"); openActivityOn(failed, "the messages that were not delivered"); }}>
                      {failed.length - WHICH_MAX} more — open the list
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : confirming.length > 0 ? (
            <>
              {/* No warning triangle and no recovery buttons: the desktop has
                  not finished asking, and the three things a person could do
                  here (restore, dismiss, re-send) are all either premature or
                  the one action that stacks a second copy of a prompt that may
                  be running. What is offered is the list, so the words can be
                  found, and nothing that acts on them. */}
              <Hourglass size={14} />
              <span>{confirmingLine(confirming.length)}</span>
              <button className="key" onPointerDown={keepFocus}
                onClick={() => { track("action:queue.confirming"); openActivityOn(confirming, "the messages the desktop is still confirming"); }}>
                <ListOrdered size={14} /> Which
              </button>
            </>
          ) : queued.length > 0 ? (
            <>
              {/* The icon is the CAUSE, as the sentence beside it is. A cloud
                  with a slash read "no connection" over a queue that was only
                  waiting for a turn to end, on a phone that was online. */}
              {status !== "open" ? <CloudOff size={14} /> : holdQueueRef.current ? <Pause size={14} /> : <Hourglass size={14} />}
              {/* With the link up, "going out one per session" was said
                  whether or not anything was actually going out — the same
                  lie the toast told. If the last flush refused to send, say
                  what refused it. */}
              <span>{queued.length} queued{holdQueueRef.current ? " — held until you send them" : status !== "open" ? " — will send when the connection is back" : inFlight ? " — going out one per session" : flushIdleReason.current ? ` — ${flushIdleReason.current}` : " — going out one per session"}</span>
              <button className="key" onPointerDown={keepFocus} onClick={() => { track("action:outbox.retry"); const n = flushOutbox(true); if (!n) showToast(idleReason("nothing left to send")); }}><RotateCw size={14} /> Send now</button>
              {/* "Send it the moment the link is back" as ONE control, right
                  where the waiting is visible. It drives both switches that
                  decide it — auto-send, and the ask-on-reconnect confirmation
                  — because either one left in the way turns "auto" into
                  another tap. The full pair is still in Settings → Install &
                  offline; this is the same state, not a third setting.
                  Only where it decides something: offline, or held by hand.
                  Online with nothing held, the queue is already going out and
                  "auto on" beside "held until the turn ends" read as a switch
                  for that wait, which it is not. */}
              {(status !== "open" || holdQueueRef.current || !(autoSend && !confirmQueue)) && <button className={`key ${autoSend && !confirmQueue ? "active" : ""}`} onPointerDown={keepFocus}
                title={autoSend && !confirmQueue
                  ? "queued messages go out by themselves as soon as the connection is back — tap to hold them instead"
                  : "send everything queued the moment the connection is back, without asking"}
                onClick={() => {
                  const on = !(autoSend && !confirmQueue);
                  track("action:outbox.auto");
                  // Both preferences, and the refs the flusher reads, move in these two calls.
                  setPref("autoSend", on);
                  setPref("confirmQueue", !on);
                  if (on) { holdQueueRef.current = false; setReconnectAsk(false); flushOutbox(); }
                  showToast(on ? "auto-send on — the queue goes out as soon as the link is back" : "auto-send off — the queue waits for “Send now”");
                }}><Zap size={14} /> auto {autoSend && !confirmQueue ? "on" : "off"}</button>}
              {/* A count is a filter: "2 queued" opens those two. Unfiltered it
                  opened all ~200 rows, ranked with the queued ones under every
                  failed and needs-you row — the words just sent were nowhere
                  on the first screen. */}
              <button className="key" onPointerDown={keepFocus} onClick={() => { track("action:queue.manage"); openActivityOn(queued, "the messages still waiting to go out"); }}><ListOrdered size={14} /> Manage</button>
            </>
          ) : (
            // "Sending…" with no clock is the exact complaint this bar was
            // meant to answer: an op's receipt window is 20 s, and twenty
            // silent seconds are indistinguishable from a dead tap. The
            // elapsed count comes from the CURRENT attempt (`sentAt`), and
            // past the ack window it says what happens next rather than
            // leaving the spinner to imply forever.
            <>
              <Loader size={14} className="spin" />
              <span>{sendingLabel(flying)}</span>
              <button className="key" onPointerDown={keepFocus} onClick={() => { track("action:queue.manage"); openActivityOn(flying, "the messages going out now"); }}><ListOrdered size={14} /> Manage</button>
            </>
          )}
        </div>
      )}
    </>
  );
}
