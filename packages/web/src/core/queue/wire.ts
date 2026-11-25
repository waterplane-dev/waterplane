/**
 * The socket's receipts for the queue, as methods, so each case in App's
 * switch is one line (`case "op.ack": q.onOpAck(msg); break;`). The cases stay
 * in App — webshape forbids a case only for a frame a feature declares.
 * Lifted verbatim from App's switch.
 */
import { bindPendingSession, type RelayClaim } from "@waterplane/shared";
import { isCreateOp, type OutboxEntry } from "../../outbox";
import { notePromptedSession } from "./promptedSessions";
import { noteSendConfirmed } from "../../link";
import { dismissToastIf, showToast } from "../../toast";
import { ACK_TIMEOUT_MS, answerSendingToast, claimWritten, pendingLaneId, requeue } from "./logic.ts";
import { noteFireAck } from "./fireFate.ts";
import { noteReceiptRemoval } from "../../relayedRow";
import type { Msg, QueueCtx } from "./types.ts";

export interface WireFns {
  onBacklogAck(msg: Msg<"backlog.ack">): void;
  onOpAck(msg: Msg<"op.ack">): void;
  onInputAck(msg: Msg<"input.ack">, fromClaim?: boolean): void;
  onDeliveryList(msg: Msg<"delivery.list">): void;
  onDeliverySettled(msg: Msg<"delivery.settled">): void;
  onLaunchList(msg: Msg<"launch.list">): void;
  onLaunchOpened(msg: Msg<"launch.opened">): void;
  onBudget(msg: Msg<"budget.state">): void;
  /** The background relay handed the queue back (`relayOwner.ts`): what it did, applied. Returns how
   *  many of this queue's rows it had sent. */
  applyRelayClaim(claim: RelayClaim): number;
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
    // Before the row is retired, as `onOpAck` does (`fireFate.ts`).
    noteFireAck(msg.ackId, msg.ok, undefined, msg.reason);
    if (msg.ok) { noteReceiptRemoval(msg.ackId); writeOutbox(outboxRef.current.filter((e) => e.ackId !== msg.ackId)); }
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
    // A tracked fire's receipt (`fireFate.ts`) is recorded BEFORE its row is
    // retired, so no render sees "row gone, no receipt" and calls it dropped.
    noteFireAck(msg.ackId, msg.ok, msg.runId, msg.reason);
    // The person's continue after a sign-in has no row that changes under the
    // tap until the next session snapshot, so the host's own sentence IS the
    // receipt — ok or refused, and naming any id that was not waiting.
    if (entry?.op?.t === "signin.continue") showToast(msg.reason || (msg.ok ? "continuing after the sign-in" : "nothing was continued"));
    if (msg.ok) {
      // PARKED create (see below): its chain is marked as held by the desktop BEFORE the create's
      // row is retired, or the write's orphan reconcile (`orphans.ts`) would fail the chain.
      if (entry && isCreateOp(entry) && !msg.sessionId && msg.launchId) holdForLaunch(entry.sessionId, entry.ackId);
      // Retire the create's row AND bind its chain in ONE write: the write reconciles orphans
      // (`orphans.ts`), and a chain whose create row is gone but not yet re-aimed at the session
      // the ack named would be failed as an orphan. (Binding does not read the create row.)
      noteReceiptRemoval(msg.ackId);
      let retired = outboxRef.current.filter((e) => e.ackId !== msg.ackId);
      if (entry && isCreateOp(entry) && msg.sessionId) retired = bindPendingSession(retired, entry.sessionId, msg.sessionId, Date.now(), entry.ackId);
      writeOutbox(retired);
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
          // The first prompt travels inside the create and is typed later, once the TUI is up: the
          // session is not empty meanwhile (`promptedSessions.ts`).
          if ((entry.op as { prompt?: string }).prompt) notePromptedSession(msg.sessionId);
          // (the chain was bound in the write above.)
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
        // (`holdForLaunch`, done above before the create's row was retired.)
        // Accepted but nameless: nothing to bind to, and leaving them
        // parked would hold the lane silently forever.
        else if (!msg.launchId) failPendingCreates(entry.sessionId, "the session was never named — re-aim these or discard them", entry.ackId);
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

  function onInputAck(msg: Msg<"input.ack">, fromClaim = false): void {
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
      // The receipt retires the "sending …" toast an answer tap raised: that
      // toast ran its own clock and outlived the very thing it announced.
      if (entry?.answer) dismissToastIf(answerSendingToast(entry.answer.label));
      noteReceiptRemoval(msg.ackId);
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
      // On the page's own socket `retryable` PROVES nothing ran and nothing is in flight, so a row the
      // background link had written is the page's own again: `relayedAt` goes, or edit, discard,
      // rewrite, put back and re-aim stay refused on a prompt that never ran. A CLAIM's receipt proves
      // no such thing: the service worker keeps an earlier attempt's retryable while a later attempt
      // of the same ackId is still in flight (pending, net, worker killed), so a claim never clears it.
      writeOutbox(outboxRef.current.map((e) =>
        e.ackId === msg.ackId && e.status === "pending"
          ? { ...requeue(e, false), waitReason: msg.reason || undefined, ...(fromClaim ? {} : { relayedAt: undefined }) }
          : e));
      releaseLane();
    } else if (msg.state === "rescued") {
      // The session was gone and the host KEPT the words: they are a work
      // item in that repo now, on disk, and will run when it next has a
      // session. So this row is finished — dropping it is the whole point,
      // because failing it would offer a re-fire that posts the same prose
      // a second time.
      noteReceiptRemoval(msg.ackId);
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
    let bound = false;
    for (const l of msg.launches) {
      if (l.state === "failed" || l.state === "canceled") {
        failPendingCreates(`create:${l.cwd}`, l.reason || "the session never opened", l.id);
      }
      // A launch that OPENED while this phone was away: `launch.opened` is a
      // one-shot broadcast, so a phone off the link at that moment never hears
      // it and the prompts chained behind the parked create waited for ever.
      // The list arrives on every hello, so it is the reconciliation pass —
      // the same binding `onLaunchOpened` does, keyed on the create's ackId.
      // Someone still standing on that create's screen is moved onto it too.
      else if (l.state === "done" && l.sessionId && (hasChainFor(l.id) || c.activeIdRef.current === pendingLaneId(l.id))) {
        writeOutbox(bindPendingSession(outboxRef.current, `create:${l.cwd}`, l.sessionId, Date.now(), l.id));
        adoptPendingSession(l.id, l.sessionId);
        bound = true;
      }
    }
    if (bound) flushOutbox();
  }
  /** Prompts still parked behind this create (`pendingCreate`, its ackId). */
  function hasChainFor(createAck: string): boolean {
    return outboxRef.current.some((e) => e.pendingCreate && e.createAck === createAck);
  }
  function onLaunchOpened(msg: Msg<"launch.opened">): void {
    // The session the host was holding exists now. This is the binding the
    // `op.ack` could not do: at ack time nothing was open.
    // `msg.id` is the create op's own ackId (`LaunchIntent.id`) — so this
    // binds the chain of the create that was parked, and not that of
    // another one queued for the same repo behind it.
    writeOutbox(bindPendingSession(outboxRef.current, `create:${msg.cwd}`, msg.sessionId, Date.now(), msg.id));
    notePromptedSession(msg.sessionId); // a parked create waits for its files only because its prompt names them
    adoptPendingSession(msg.id, msg.sessionId);
    flushOutbox();
  }
  function onBudget(msg: Msg<"budget.state">): void {
    const next = { budget: msg.budget, verdict: msg.verdict, ...(msg.periods ? { periods: msg.periods } : {}), ...(msg.loss ? { loss: msg.loss } : {}) };
    deps.setBudget(next);
    deps.budgetRef.current = next; // the flusher below reads the ref
    // The gate may have just LIFTED — a window reset, or the ceiling was
    // raised. Nothing else would notice: the queue's own sweep is on a
    // timer, and this is the moment the answer changed.
    if (!msg.verdict.blocked) flushOutbox();
  }

  /**
   * A claim, applied — WRITTEN FIRST, then the receipts. Written rows become the same send
   * continuing (`claimWritten`), with their ack timer armed when they are `pending`; the receipts
   * then go through the very handlers above, which find those rows `pending` — so a `retryable`
   * receipt requeues exactly as it would have on the page's own socket. Only receipts for rows
   * still in this queue are replayed: a receipt for a row already settled says nothing new.
   */
  function applyRelayClaim(claim: RelayClaim): number {
    // The shell's record of what it sent was unreadable, so no row is marked as relayed. Nothing is
    // guessed: a plain re-send keeps its ackId and is joined or re-acked by the host (never typed
    // twice). Re-aiming, rewriting or putting a row back mints a new message, which may run it
    // twice — so the toast says that, not "never twice".
    if (claim.lost === true) showToast("the background link lost track of what it sent — check the queue. Waiting rows are safe to send as they are; re-aiming or rewriting one could run it twice");
    const known = new Set(outboxRef.current.map((e) => e.ackId));
    const touched = new Set([...claim.written.map((w) => w.ackId), ...claim.receipts.map((r) => r?.ackId)]
      .filter((id): id is string => typeof id === "string" && known.has(id)));
    if (!touched.size) return 0;
    // What the person is told as "sent": the host took it (`ok`, or `rescued`) or holds it (written,
    // no receipt yet) — the Android and service-worker notices count the same. A refusal or a
    // verdict that never came is applied below like any other receipt, never counted.
    const answered = new Set(claim.receipts.map((r) => r?.ackId));
    const sent = new Set<string>();
    for (const w of claim.written) if (known.has(w.ackId) && !answered.has(w.ackId)) sent.add(w.ackId);
    for (const a of claim.receipts) {
      if (!a || typeof a !== "object" || !known.has(a.ackId)) continue;
      const ok = (a as { ok?: unknown }).ok === true || (a as { state?: unknown }).state === "rescued";
      if (ok) sent.add(a.ackId);
    }
    const r = claimWritten(outboxRef.current, claim.written, c.connRef.current.status === "open", Date.now());
    writeOutbox(r.list);
    for (const id of r.pending) {
      const e = outboxRef.current.find((x) => x.ackId === id);
      // The relay already wrote this frame: the host holds a verdict for its ackId (a re-send is
      // joined or re-acked, never retyped), so waiting out the full delivery window (~95 s) only
      // stalls the lane. Ask again after a round trip.
      if (e && !ackTimers.current.has(id)) c.armAckTimeout(id, e.relayedAt != null ? ACK_TIMEOUT_MS : c.ackWindowFor(e));
    }
    for (const a of claim.receipts) {
      if (!a || typeof a !== "object" || !known.has(a.ackId)) continue;
      if (a.t === "input.ack") onInputAck(a, true);
      else if (a.t === "backlog.ack") onBacklogAck(a);
      else if (a.t === "op.ack") onOpAck(a);
    }
    return sent.size;
  }

  return { onBacklogAck, onOpAck, onInputAck, onDeliveryList, onDeliverySettled, onLaunchList, onLaunchOpened, onBudget, applyRelayClaim };
}
