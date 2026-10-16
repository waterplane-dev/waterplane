/**
 * The socket's receipts for the queue, as methods, so each case in App's
 * switch is one line (`case "op.ack": q.onOpAck(msg); break;`). The cases stay
 * in App — webshape forbids a case only for a frame a feature declares.
 * Lifted verbatim from App's switch.
 */
import { bindPendingSession } from "@waterplane/shared";
import { isCreateOp, type OutboxEntry } from "../../outbox";
import { noteSendConfirmed } from "../../link";
import { showToast } from "../../toast";
import { requeue } from "./logic.ts";
import type { Msg, QueueCtx } from "./types.ts";

export interface WireFns {
  onBacklogAck(msg: Msg<"backlog.ack">): void;
  onOpAck(msg: Msg<"op.ack">): void;
  onInputAck(msg: Msg<"input.ack">): void;
  onDeliveryList(msg: Msg<"delivery.list">): void;
  onDeliverySettled(msg: Msg<"delivery.settled">): void;
  onLaunchList(msg: Msg<"launch.list">): void;
  onLaunchOpened(msg: Msg<"launch.opened">): void;
  onBudget(msg: Msg<"budget.state">): void;
}

export function wireFns(c: QueueCtx): WireFns {
  const { ackTimers, outboxRef, serialWatchRef } = c;
  const deps = c;
  const writeOutbox = (list: OutboxEntry[]) => c.writeOutbox(list);
  const flushOutbox = (armAll?: boolean) => c.flushOutbox(armAll);
  const failOutbox = (ackId: string, reason: string, state?: OutboxEntry["failState"]) => c.failOutbox(ackId, reason, state);
  const releaseLane = () => c.releaseLane();
  const applyDeliverySettled = c.applyDeliverySettled;
  const failPendingCreates = (lane: string, reason: string, createAck?: string) => c.failPendingCreates(lane, reason, createAck);
  const adoptPendingSession = (createAck: string, sessionId: string) => c.adoptPendingSession(createAck, sessionId);
  const holdForLaunch = (lane: string, createAck?: string) => c.holdForLaunch(lane, createAck);

  /** Receipt for a durably-queued work item (the compose bar's queue modes).
   *  Same contract as input.ack — the host de-duped on ackId, so a reconnect
   *  re-send is confirmed, not added twice. */
  function onBacklogAck(msg: Msg<"backlog.ack">): void {
    const timer = ackTimers.current.get(msg.ackId);
    if (timer != null) { clearTimeout(timer); ackTimers.current.delete(msg.ackId); }
    if (msg.ok) writeOutbox(outboxRef.current.filter((e) => e.ackId !== msg.ackId));
    else failOutbox(msg.ackId, msg.reason || "could not queue");
    releaseLane();
  }

  /**
   * Receipt for a durable ACTION (start a session, fan out, run a build). Same
   * shape as input.ack/backlog.ack, with two deliberate differences: there is no
   * submitting Return to press (an op is not text in a composer), and no
   * session.record — nothing was typed. The host de-duped on ackId via a
   * PERSISTED ledger, so a re-send after a reload or a host restart is
   * re-acked, never re-run.
   */
  function onOpAck(msg: Msg<"op.ack">): void {
    const timer = ackTimers.current.get(msg.ackId);
    if (timer != null) { clearTimeout(timer); ackTimers.current.delete(msg.ackId); }
    const entry = outboxRef.current.find((e) => e.ackId === msg.ackId);
    if (msg.ok) {
      writeOutbox(outboxRef.current.filter((e) => e.ackId !== msg.ackId));
      // A create names the session it made: every prompt queued behind it
      // in this lane now HAS a target, so bind them and let the lane
      // drain. The first prompt travelled inside the op itself (the host
      // types it); these are the follow-ups, each held until the previous
      // turn ends. Their ackIds are kept — the lane rule proves they were
      // never sent, so no host verdict can exist for them.
      if (entry && isCreateOp(entry)) {
        // Serialized: hold this repo's group until the session we just
        // made has actually run something. Between here and its first
        // turn the live session list says "idle", and releasing on that
        // would start the next open a second later — the exact pile-up
        // the rule exists to prevent (`SerialWatch`).
        if (entry.serial && msg.sessionId) {
          serialWatchRef.current = [
            ...serialWatchRef.current.filter((w) => w.group !== entry.serial),
            { group: entry.serial, sessionId: msg.sessionId, at: Date.now() },
          ];
        }
        if (msg.sessionId) {
          writeOutbox(bindPendingSession(outboxRef.current, entry.sessionId, msg.sessionId, Date.now(), entry.ackId));
          // Someone is standing on this create's pending screen: move
          // them (and their draft) onto the session it just named.
          adoptPendingSession(entry.ackId, msg.sessionId);
        }
        // PARKED, not nameless. The create carried `needs` and the host is
        // holding it until those files land — so there is no session to
        // bind to yet and there SHOULD not be. The prompts behind it wait
        // for `launch.opened`, and they stop aging out while they do: the
        // queue's half-hour is a bound on a message nobody is holding, and
        // this one is held by the desktop, which is not going anywhere.
        else if (msg.launchId) holdForLaunch(entry.sessionId, entry.ackId);
        // Accepted but nameless: nothing to bind to, and leaving them
        // parked would hold the lane silently forever.
        else failPendingCreates(entry.sessionId, "the session was never named — re-aim these or discard them", entry.ackId);
      }
      // The op created/named a session and the user was looking at the
      // tap that asked for it → open it. Not for an op that was queued
      // offline (no `focus`): that one may land minutes later, and
      // yanking the view then is an ambush.
      if (entry?.focus && msg.sessionId) deps.focusSession(msg.sessionId);
    } else {
      // `failOutbox` cascades to the prompts queued behind a create: they
      // were written to run in a session that now won't exist.
      //
      // `refused`, not the `other` default: on the durable-op path every
      // `ok:false` is returned before anything is spawned, typed or run,
      // so the desktop DID record what became of this one. Left as
      // `other` the row said "nobody recorded whether it ran" underneath
      // the host's own sentence explaining exactly why it did not.
      failOutbox(msg.ackId, msg.reason || "could not start", "refused");
      /**
       * **A refused re-queue has to be SAID, not filed.**
       *
       * Every other durable op announces its own refusal by where it was
       * tapped: a create that will not start leaves you on a pending
       * screen that goes red, a build's row is the thing you were
       * watching. `intent.requeue` has neither — the tap is on a backlog
       * row that does not change, the outbox row lands in Activity, and
       * the sheet the person is still looking at says nothing at all. So
       * the one refusal this op actually has — the row settled AGAIN
       * after the failure the tap was taken against, which is the whole
       * point of sending `failedAt` — arrived as silence, and silence
       * after "run it again" reads as yes.
       *
       * The host's own sentence, verbatim: it is the side that compared
       * the two instants and it knows which row and which failure, and a
       * phone re-wording it is a second copy of a claim that would drift.
       * Only this op, deliberately — a blanket toast on every `ok:false`
       * would double up on the ops whose refusal is already on screen.
       */
      if (entry?.op?.t === "intent.requeue") {
        showToast(msg.reason || "it was not put back — the desktop refused it");
      }
    }
    releaseLane(); // ok or not, this lane is free — never strand what's behind it
  }

  function onInputAck(msg: Msg<"input.ack">): void {
    const timer = ackTimers.current.get(msg.ackId);
    if (timer != null) { clearTimeout(timer); ackTimers.current.delete(msg.ackId); }
    const entry = outboxRef.current.find((e) => e.ackId === msg.ackId);
    if (msg.ok) {
      // A `submit` receipt means the prompt is RUNNING — typed, echoed on
      // the rendered screen, and the Return proven to have taken (on a
      // hooked session, by the turn actually starting). The client no
      // longer presses Return itself: that keystroke used to be a bare
      // unacked write fired after this entry had already been dropped, so
      // a socket dying in the gap stranded the prompt in the composer with
      // nothing left to retry. It lives on the side of the tunnel that can
      // see whether it worked now.
      // `forked`: a bare `/fork` the desktop answered by opening a new tab
      // rather than typing it — not a delivery, so it is not timed as one,
      // and the receipt's own sentence says where the words went.
      if (msg.state === "forked") showToast(msg.reason || "forked into a new session");
      else if (entry) noteSendConfirmed(Date.now() - entry.ts);
      writeOutbox(outboxRef.current.filter((e) => e.ackId !== msg.ackId));
      releaseLane();
    } else if (msg.retryable) {
      // "Nothing was typed" — the session never reached its prompt. The one
      // failure that is safe to send again (the host did not remember the
      // verdict either), so put it back in the queue instead of failing it.
      // The attempts cap still bounds it.
      // Backed off like any other requeue: "the session never reached its
      // prompt" is a condition that needs TIME to change, and re-firing on
      // the lane-release timer is a busy-loop that holds the lane.
      // The host's reason rides as `waitReason` — "the shell is running
      // `vim`" is the one thing that tells the person what to do.
      writeOutbox(outboxRef.current.map((e) =>
        e.ackId === msg.ackId && e.status === "pending" ? { ...requeue(e, false), waitReason: msg.reason || undefined } : e));
      releaseLane();
    } else if (msg.state === "rescued") {
      // The session was gone and the host KEPT the words: they are a work
      // item in that repo now, on disk, and will run when it next has a
      // session. So this row is finished — dropping it is the whole point,
      // because failing it would offer a re-fire that posts the same prose
      // a second time.
      writeOutbox(outboxRef.current.filter((e) => e.ackId !== msg.ackId));
      showToast(msg.reason || "that session is gone — the words are a backlog item now");
      releaseLane();
    } else {
      // Not delivered, and NOT safe to retry automatically. Which of the
      // two it is decides what the user should do, so say it plainly:
      // `unsubmitted` means the text is sitting in that session's composer
      // one keypress from running (re-sending would stack a second copy),
      // `unconfirmed` means we typed into a screen we could not read.
      failOutbox(msg.ackId, msg.reason || "session gone",
        msg.state === "unconfirmed" || msg.state === "unsubmitted" || msg.state === "stale" ? msg.state : "other");
      if (msg.state === "stale") {
        // An answer that arrived after its question was gone — the host
        // refused to type it rather than aiming the keystroke at whatever
        // is up now. Name the question: by the time this lands the box is
        // long off the screen, and "not delivered" alone gives the user
        // nothing to act on. The entry stays in the recovery bar.
        const q = entry?.answer;
        showToast(q ? `“${q.label}” wasn't sent — that question is gone: ${q.question.slice(0, 60)}` : "answer not sent — that question is gone");
      } else if (msg.state === "unsubmitted") {
        showToast("prompt is in the composer but Return didn't take — open the session and press Return");
      }
      releaseLane(); // don't strand the rest of the lane behind it
    }
  }

  // What became of the deliveries the host could not confirm at the time.
  // The phone does not ask any more (see the note where the settle sweep
  // used to be): the desktop re-asks the CLI's own conversation log on its
  // own sweep, whether or not anybody is connected, and broadcasts the
  // answer. `delivery.list` arrives on hello and after a reconnect, which
  // is the reconciliation pass for verdicts settled while this tab was
  // gone — the case the old client-driven version could never cover.
  function onDeliveryList(msg: Msg<"delivery.list">): void {
    for (const q of msg.items) applyDeliverySettled(q);
  }
  function onDeliverySettled(msg: Msg<"delivery.settled">): void {
    applyDeliverySettled(msg.item);
  }

  // ── Handed-over launches ──
  function onLaunchList(msg: Msg<"launch.list">): void {
    deps.setLaunches(msg.launches);
    // A launch that ended without opening takes the prompts queued behind
    // it with it — they were waiting for a session that is not coming. The
    // text stays and stays restorable; what changes is that the row now
    // says why, in the host's words, instead of sitting silent forever.
    for (const l of msg.launches) {
      if (l.state === "failed" || l.state === "canceled") {
        failPendingCreates(`create:${l.cwd}`, l.reason || "the session never opened", l.id);
      }
    }
  }
  function onLaunchOpened(msg: Msg<"launch.opened">): void {
    // The session the host was holding exists now. This is the binding the
    // `op.ack` could not do: at ack time nothing was open.
    // `msg.id` is the create op's own ackId (`LaunchIntent.id`) — so this
    // binds the chain of the create that was parked, and not that of
    // another one queued for the same repo behind it.
    writeOutbox(bindPendingSession(outboxRef.current, `create:${msg.cwd}`, msg.sessionId, Date.now(), msg.id));
    adoptPendingSession(msg.id, msg.sessionId);
    flushOutbox();
  }
  function onBudget(msg: Msg<"budget.state">): void {
    const next = { budget: msg.budget, verdict: msg.verdict, ...(msg.periods ? { periods: msg.periods } : {}) };
    deps.setBudget(next);
    deps.budgetRef.current = next; // the flusher below reads the ref
    // The gate may have just LIFTED — a window reset, or the ceiling was
    // raised. Nothing else would notice: the queue's own sweep is on a
    // timer, and this is the moment the answer changed.
    if (!msg.verdict.blocked) flushOutbox();
  }

  return { onBacklogAck, onOpAck, onInputAck, onDeliveryList, onDeliverySettled, onLaunchList, onLaunchOpened, onBudget };
}
