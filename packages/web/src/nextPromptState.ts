/**
 * **The prompt that goes in after this one — as a decision you can reach while
 * you are watching the turn.**
 *
 * ── The gap ─────────────────────────────────────────────────────────────────
 *
 * Sending a follow-up while the agent is working already had two answers, and
 * both were made BEFORE the send: the compose chevron's *now* types it straight
 * into the working session, and *hold until idle* parks it until the turn ends.
 * What there was no way to do is change your mind — which is precisely when you
 * find out you want to. You send a follow-up, then watch the turn go somewhere
 * you did not expect and want the queued one to land NOW; or you fire one off
 * reflexively and realise it should wait for the turn to finish rather than
 * being glued onto the CLI's composer mid-thought.
 *
 * Both verbs existed (`sendQueuedNow`, `toggleHoldQueued`) and both lived in a
 * sheet two taps away, on a row you had to identify first. On the screen where
 * the progress is actually being watched there was nothing — the queue bar
 * says "3 queued" about the WHOLE queue, not about the session in front of you,
 * and offers neither verb for one message.
 *
 * ── Why this file is pure ───────────────────────────────────────────────────
 *
 * What the strip says is a ladder over four facts that do not agree with each
 * other in the obvious way — parked/not, the link, the walls, and what is
 * behind it — and every one of them has a sentence that must be exactly true.
 * "Send now" offered against a session with an open dialog is a tap that does
 * nothing, which is the one answer this app refuses everywhere. So the decision
 * is a function with tests and the component only draws it.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * The verbs themselves. This says which one applies and whether it may be
 * offered; App still owns the mutation, because `sendQueuedNow` also releases
 * the entries AHEAD of the tapped one in the lane (a lane delivers in order, so
 * releasing only the tapped one would send nothing) and that rule belongs with
 * the queue, not with a strip.
 */
import type { OutboxEntry } from "./outbox";

export interface NextPromptView {
  /**
   * **Which machine is holding this one**, and therefore what the buttons mean.
   *
   * `phone` is a queue entry in this tab's own outbox: it goes when the lane
   * frees, and the park on it is something a tap here can lift. `desktop` is a
   * work item pinned to this session on the host — it fires itself the moment
   * the session can take it, whether or not this phone is awake, and the only
   * verb that applies is "stop waiting and run it now" (`backlog.fire`).
   *
   * Two holders for one wait is what the composer's `when it's free` and `queue
   * here` were, and they are now one. This strip still has to know which,
   * because the phone-held one survives exactly one case (a prompt chained
   * behind a session that does not exist yet) and telling a person the desktop
   * is holding their words when it is not is a promise about a locked screen.
   */
  holder: "phone" | "desktop";
  /** What the buttons act on: an outbox ackId (`phone`) or the work item's id
   *  on the host (`desktop`). */
  id: string;
  /** Its own words, one line. Recognising your own prompt is the whole point —
   *  a count with no words is what the queue bar already says. */
  words: string;
  /** Parked until this turn ends. Decides WHICH verb is offered. */
  held: boolean;
  /** How many more are queued behind it for this session. */
  behind: number;
  /** Why it is not going in right now, in words. */
  why: string;
  /**
   * Why *send now* may not be offered, or null when it may.
   *
   * Not a disabled button: a dimmed control is indistinguishable from a live
   * one on a phone and its `title` is invisible, so a refusal is a SENTENCE
   * (`Unavailable.tsx`'s rule). The three walls come from App's `holdWall`,
   * which is `shared/queue.ts`'s `sessionWall` rather than a fourth copy of the
   * ladder.
   */
  wall: string | null;
  /**
   * For a row on a CLOCK aimed at this session: when, and what it is tied to.
   * A timed prompt sits here for days, and whether closing this session loses
   * it is the one question a person has about it — so it is answered on the
   * strip, not left to the backlog row. Null for everything untimed.
   */
  tie: string | null;
}

/**
 * The tie sentence for a timed row aimed at this session. `reopens` is the
 * host's `reopensConv` — the row carries this session's CONVERSATION, so a
 * closed session is reopened rather than waited for; without it the row is
 * bound to this very process.
 */
export function tieNote(when: string, reopens: boolean): string {
  return reopens
    ? `timed · ${when} · tied to this conversation — it goes into this session; close it before then and the desktop reopens this conversation and sends it there`
    : `timed · ${when} · tied to this session — keep it open until then; closed, it waits with nowhere to go`;
}

/** One line, clipped where the strip runs out. Shared by both holders so a
 *  prompt reads the same length whichever machine is sitting on it. */
function clipWords(words: string): string {
  const one = words.trim().replace(/\s+/g, " ");
  return one.length > 56 ? `${one.slice(0, 56)}…` : one;
}

/** One line of the entry's own words, however it carries them. */
export function nextWords(e: OutboxEntry, prose: (e: OutboxEntry) => string): string {
  const words = prose(e).trim().replace(/\s+/g, " ");
  if (!words) return e.mode === "upload" ? "a file" : "an action";
  return clipWords(words);
}

export function nextPromptView(o: {
  /** The whole queue, in send order. */
  entries: readonly OutboxEntry[];
  sessionId: string | null;
  /** A turn is in flight in that session. */
  busy: boolean;
  online: boolean;
  /** App's `holdWall(sessionId)` — null when an explicit send may drop the park. */
  wall: string | null;
  /** `entryProse`, injected so this file imports nothing that imports React. */
  prose: (e: OutboxEntry) => string;
  /**
   * The DESKTOP's queue for this session, in run order — work items aimed at it
   * with their own auto-fire flag set, which is what *when it's free* posts.
   *
   * Passed in already shaped rather than as `BacklogItem`s, for this file's
   * usual reason: it is pure, it is tested with plain objects, and it must not
   * learn a wire type to answer a question about two words and an order.
   */
  pinned?: readonly {
    id: string;
    words: string;
    /**
     * The HOST's own sentence for why this one has not gone yet
     * (`BacklogManager.waiting()`, which App already holds as
     * `backlogWaiting`). Absent means the ladder has nothing to say about it.
     *
     * It is passed in rather than guessed because the phone cannot see the
     * rungs a pinned row can be stuck on — the budget gate, the global switch,
     * a usage-limit block — and "the host fires it within a tick" is a fact
     * about this tab's own lane, not about the desktop's.
     */
    why?: string;
    /** `tieNote`, already worded — this file keeps no clock and no formatter. */
    tie?: string;
  }[];
  /**
   * How old the backlog snapshot `pinned` came out of is, in words, and read
   * ONLY while offline.
   *
   * Offline `pinned` is the last synced copy (`LS.snapBacklog`), so "the
   * desktop is holding it" is asserted from something that may be hours old and
   * may already have run. The Backlog sheet ages the same snapshot; this strip
   * said nothing. A string rather than a timestamp so this module keeps no
   * clock and no formatter.
   */
  asOf?: string;
}): NextPromptView | null {
  if (!o.sessionId) return null;
  // `pending` is already on the wire and there is nothing left to decide about
  // it; `failed` is over and belongs to Activity, which keeps it for ever.
  const lane = o.entries.filter((e) => e.sessionId === o.sessionId);
  const mine = lane.filter((e) => e.status === "queued");
  const next = mine[0];
  const pinned = o.pinned ?? [];
  if (!next && !pinned.length) return null;
  /**
   * A picture this lane is still moving, ordered before the prompt.
   *
   * The lane delivers in order and one delivery is in flight at a time, so a
   * prompt behind an upload CANNOT be made to jump it — `guardUploadRefs`
   * adopted the upload into this lane precisely so the agent never reads a path
   * whose bytes have not landed. Offering *send now* here would be a tap that
   * changes nothing, so the strip says the reason instead. This is the state
   * you are in immediately after sending a prompt that names a photo.
   */
  const uploadAhead = !!next && lane.slice(0, lane.indexOf(next)).some((e) => e.mode === "upload" && e.status !== "failed");
  /**
   * Only while the session cannot take it anyway — for the PHONE's lane, where
   * that is a fact this tab owns: with an idle, reachable session the entry is
   * about to go on its own, and a strip that appears for the half-second before
   * it does is flicker rather than information.
   *
   * A pinned item is drawn either way. "The desktop fires it within a tick" was
   * a guess, and it is wrong exactly when it matters: a pinned row can be held
   * on the budget gate, the global auto switch, a usage limit or an answer the
   * agent is waiting for, and none of those is visible from here. The strip
   * went blank, the queue bar said nothing (the row is not in this tab's
   * outbox), and the only sign the words existed at all was a badge.
   */
  const quiet = !o.busy && !o.wall && o.online && !uploadAhead;
  if (quiet && (next || !pinned.length)) return null;
  /**
   * The phone's lane goes first when it has anything.
   *
   * Not a ranking of importance: it is the one of the two a tap here can still
   * change. A phone-held entry is parked in this tab and nothing else knows
   * about it; a pinned item is the desktop's and will run whatever this screen
   * does. Showing the desktop's head while a parked entry sits in front of it
   * would name the wrong prompt as "next", because the parked one is.
   */
  if (!next) {
    const head = pinned[0];
    /**
     * The host's own sentence first, then a sentence that is true of the state
     * this tab CAN see. "waits for this turn to end" was said unconditionally,
     * including with no turn in flight and including offline, where there is no
     * turn to wait for and the whole row is a copy — a claim about right now,
     * made from a snapshot, about a machine this phone cannot reach.
     */
    const why = o.wall ?? head.why
      ?? (o.busy ? "waits for this turn to end" : "the desktop runs it when this session is free");
    return {
      holder: "desktop",
      id: head.id,
      words: clipWords(head.words),
      held: true,
      behind: pinned.length - 1,
      why: !o.online && o.asOf ? `${why} · as of ${o.asOf}` : why,
      tie: head.tie ?? null,
      // A dead link is not a wait HERE — the desktop is holding this one and
      // runs it either way. What the link blocks is the tap, so that is what
      // the sentence says, and it must not read as "your prompt is stuck".
      wall: o.wall
        ?? (!o.online ? "no connection — the desktop is holding it and runs it when this session is free" : null),
    };
  }
  const held = !!next.holdUntilIdle;
  // Ordered by what actually decides the outcome, not by what is most visible:
  // a wall outranks the link (a reconnect changes nothing while a dialog is
  // open), the link outranks the park (nothing goes anywhere without one), and
  // the park outranks a turn in flight (an un-parked entry is typed into a
  // working session — that is the ordinary case, not a wait).
  const why = o.wall ? o.wall
    : !o.online ? "waits for the link"
      : uploadAhead ? "waits for the picture it names to finish uploading"
        : held ? "waits for this turn to end"
          : "goes in as soon as the queue reaches it";
  return {
    holder: "phone",
    id: next.ackId,
    words: nextWords(next, o.prose),
    held,
    behind: mine.length - 1,
    why,
    tie: null,
    // Offering "send now" against a dead link is offering a tap that queues
    // what is already queued. The park is the only thing a tap can lift here.
    wall: o.wall
      ?? (!o.online ? "no connection — it goes the moment the link is back"
        : uploadAhead ? "the picture it names is still uploading — it goes the moment the bytes land"
          : null),
  };
}
