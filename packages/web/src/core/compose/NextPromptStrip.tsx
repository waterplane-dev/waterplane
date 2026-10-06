/**
 * What goes in after this turn, and the one decision left about it — the
 * `NextPrompt` mount on the session screen, with both queues it reads.
 *
 * Above the queue bar deliberately: that bar is about the WHOLE queue
 * ("3 queued"), this is about the one message this session takes next, which
 * is the only one a person watching this turn can still decide anything about.
 * One mount serves both faces of the session screen — the terminal with the
 * CLI's own spinner, and the reader with its working line — because they are
 * one screen.
 *
 * Lifted out of App's session screen unchanged. The desktop's half is read
 * from `features/backlog` (`useBacklog`), the phone's half from the queue core.
 */
import { describeRule, type ClientMessage, type SessionInfo } from "@waterplane/shared";
import type { OutboxEntry } from "../../outbox";
import { NextPrompt } from "../../NextPrompt";
import { nextPromptView, tieNote } from "../../nextPromptState";
import { entryProse } from "../../activityRows";
import { ago, hhmm } from "../../format";
import type { Overlay } from "../../routing";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { openBacklogIn, useBacklog } from "../../features/backlog";
import { keepFocus } from "./ComposeBar";
import { BL_OFFLINE } from "../../backlogFilter";

export interface NextPromptStripProps {
  active: SessionInfo;
  outbox: readonly OutboxEntry[];
  outboxRef: { readonly current: OutboxEntry[] };
  online: boolean;
  /** The queue core's `holdWall` — a busy TURN is not a wall; a dialog and a limit block are. */
  holdWall(sessionId: string): string | null;
  isPendingId(id: string | null | undefined): boolean;
  sendQueuedNow(ackId: string): void;
  toggleHoldQueued(ackId: string): void;
  handToDesktop(ackId: string): void;
  liveSend(frame: ClientMessage, done: string, blocked?: string): boolean;
  setOverlay(o: Overlay): void;
}

export function NextPromptStrip(p: NextPromptStripProps) {
  const { active, outboxRef, isPendingId, sendQueuedNow, toggleHoldQueued, handToDesktop, liveSend, setOverlay } = p;
  const { items: backlogItems, waiting: backlogWaiting, snapAt: backlogSnapAt } = useBacklog();
  return (
    <NextPrompt
      view={nextPromptView({
        entries: p.outbox,
        sessionId: active.id,
        // The same derivation the reader's working line uses: hooked sessions
        // report the turn exactly, and without hooks `turnActive` is the
        // silence guess `idle` already makes.
        busy: active.hooked ? !!active.turnActive : !!active.running && !active.idle,
        online: p.online,
        // `holdWall` and not a fourth copy of the ladder: a busy TURN is not a
        // wall (an explicit send types into one — that is the whole point of
        // "send now" beating the park), a dialog and a limit block are.
        wall: p.holdWall(active.id),
        prose: entryProse,
        // The desktop's half of the same question. *When free* posts a work
        // item pinned to this session with its own auto-fire flag, so the
        // prompt a person is waiting on is routinely not in this tab's queue
        // at all — before this the strip simply went blank and the composer
        // said nothing about words that were definitely going to run.
        pinned: backlogItems
          .filter((it) => it.targetSessionId === active.id && it.autoFire && it.status === "queued")
          .sort((a, b) => a.order - b.order)
          // The host's own reason, not a second reading of the ladder — the
          // same `waiting` map the Backlog sheet draws under a row. Only
          // populated while online, which is exactly when it is a fact.
          .map((it) => ({
            id: it.id, words: it.text, why: backlogWaiting[it.id],
            // A clock row says when, and whether closing this session loses it.
            tie: it.at
              ? tieNote(it.at.nextAt != null ? `${hhmm(it.at.nextAt)} (${describeRule(it.at.rule)})` : describeRule(it.at.rule), !!it.reopensConv)
              : undefined,
          })),
        // Offline, `backlogItems` is the last synced copy, so the strip has
        // to say how old the copy is rather than assert the desktop's state.
        asOf: p.online ? undefined : backlogSnapAt ? ago(backlogSnapAt) : undefined,
      })}
      onSendNow={(id, holder) => {
        track("action:nextprompt.sendnow");
        if (holder === "phone") { sendQueuedNow(id); return; }
        // The desktop's own verb for "stop waiting". Live-only and
        // deliberately not durable, like every other backlog mutation: "run it
        // now" delivered an hour late is about a turn that ended long ago.
        liveSend({ t: "backlog.fire", id }, "running it now…", BL_OFFLINE);
      }}
      onHold={(ackId) => {
        track("action:nextprompt.hold");
        const e = outboxRef.current.find((x) => x.ackId === ackId);
        // A session that does not exist yet has no id a pinned item could
        // name, so the phone keeps that one wait — and the toast says which
        // machine is sitting on the words, because that is the whole
        // difference between the two shapes this wait can take.
        if (!e || isPendingId(e.sessionId)) {
          toggleHoldQueued(ackId);
          showToast("held on this phone — it goes in when this session opens. Leave the app open");
          return;
        }
        handToDesktop(ackId);
      }}
      onOpenQueue={() => { track("overlay:queue"); setOverlay("queue"); }}
      onOpenBacklog={() => { track("overlay:backlog"); openBacklogIn(active.cwd); }}
      keepFocus={keepFocus}
    />
  );
}
