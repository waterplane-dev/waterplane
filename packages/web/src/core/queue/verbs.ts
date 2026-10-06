/**
 * What a person does to a queued row — the queue sheet's and Activity's verbs,
 * the recovery bar's Restore and Dismiss. Lifted verbatim from App; every one
 * writes through `writeOutbox` and nothing else.
 */
import { canRetarget, isLocalCommand, moveInLane, retargetEntry, serialGroup } from "@waterplane/shared";
import {
  clearDeadUpload, isCreateOp, isSerializable, loadDraft, newAckId, noteDeadUpload, saveDraft, type OutboxEntry,
} from "../../outbox";
import { dropKept } from "../../attachments";
import { idbDel } from "../../idb";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { entryProse, onlyUploadsFailed, restorableFailed } from "../../activityRows";
import { sendModeToast } from "../../composeSend";
import { pendingLaneId, unpark } from "./logic.ts";
import type { QueueCtx, VerbFns } from "./types.ts";

export function verbFns(c: QueueCtx): VerbFns {
  const { outboxRef, outbox, pendingKept, activeIdRef, connRef, sessions, activeId } = c;
  const writeOutbox = (list: OutboxEntry[]) => c.writeOutbox(list);
  const flushOutbox = (armAll?: boolean) => c.flushOutbox(armAll);
  const idleReason = (fallback?: string) => c.idleReason(fallback);
  const holdWall = (sessionId: string) => c.holdWall(sessionId);
  const retainUploadBytes = (e: OutboxEntry, drop?: boolean) => c.retainUploadBytes(e, drop);
  const failPendingCreates = (lane: string, reason: string, createAck?: string) => c.failPendingCreates(lane, reason, createAck);
  const queueSessionPrompt = (cwd: string, text: string, createAck: string) => c.queueSessionPrompt(cwd, text, createAck);
  const openSend = c.openSend;
  const sendTargetFor = c.sendTargetFor;
  const setActiveId = c.setActiveId;
  const setCompose = c.setCompose;

  /**
   * Put the newest not-delivered message somewhere it can actually be seen.
   *
   * It used to write into the compose box and delete the row. This bar renders
   * on the LAUNCHER as well as inside a session, and the launcher has no
   * compose box — which is also the screen a person is on when a send stops
   * coming back. So the tap deleted the red row, put the words in a textarea
   * two screens away, and said nothing: the button looked broken and the
   * message looked lost.
   *
   * It opens the one send surface instead. That exists on every screen, it
   * keeps the row until the sheet actually posts (`retireSendSource` retires it
   * by `ackId`), and it lets the destination and the timing be re-decided —
   * which is the normal case here, since the session these words were aimed at
   * is per-boot and may not have survived the outage.
   */
  function restoreOutbox() {
    // Ops and UPLOADS are skipped: their `text` is a description ("open myapp ·
    // main", "file · 1000074239-….jpg"), not something anyone would want to
    // re-send as a prompt. A failed op is dropped via Dismiss or re-fired by
    // tapping the thing again; a failed upload is recovered by re-attaching its
    // bytes, which is the strip's button and not this one. `restorableFailed`
    // is that rule, tested.
    const e = restorableFailed(outbox);
    if (!e) {
      showToast(onlyUploadsFailed(outbox)
        ? "those are files, not text — open the message that names one and re-attach it there"
        : "nothing to put back — the failed items are actions, not text");
      return;
    }
    const rest = outbox.filter((x) => x.status === "failed" && x.mode !== "op").length - 1;
    openSend({
      prompts: [entryProse(e)],
      target: sendTargetFor(e.sessionId, e.cwd),
      cwdHint: e.cwd, repoId: repoIdOfEntry(e), ackId: e.ackId, repair: true,
      openAfter: true,
      // One tap restores one message. Say how many are still behind it and
      // where they are, or the bar dropping from 2 to 1 is the only hint.
      origin: rest > 0 ? `This one never went — ${rest} more under Manage` : "This one never went",
    });
  }
  /** Discard all not-delivered messages. */
  function dismissOutbox() {
    for (const e of outboxRef.current) if (e.status === "failed" && e.mode === "upload") void retainUploadBytes(e);
    writeOutbox(outboxRef.current.filter((e) => e.status !== "failed"));
  }
  // ── Manage the queue (the sheet behind "manage" on the recovery bar) ──
  /** Rewrite a queued message. Offline text goes stale — by the time the link is
   *  back the agent may have done half of it — so editing in place beats
   *  discard-and-retype. Only `queued` entries: a `pending` one may already be
   *  on a live PTY, where an edit would change nothing but the record. */
  function editQueued(ackId: string, text: string) {
    writeOutbox(outboxRef.current.map((e) => {
      if (e.ackId !== ackId || e.status !== "queued") return e;
      // An OP is a payload, not prose. Only the two whose whole point IS the
      // text (a fan-out prompt and its follow-up) are rewritable, and the
      // payload has to be rewritten with it or the queue would show one thing
      // and send another. `session.create`/`build.run` are filtered out by
      // `isEditableEntry` before the sheet ever offers an edit.
      if (e.mode === "op") {
        const op = e.op;
        // A create's prose is its `prompt` (what runs once the CLI is up), a
        // fan-out's is its `text`. Anything else is a payload with no body —
        // `isEditableEntry` never offers it.
        if (op?.t === "session.create") return { ...e, text, op: { ...op, prompt: text } };
        if (!op || (op.t !== "fanout.run" && op.t !== "fanout.followup")) return e;
        return { ...e, text, op: { ...op, text } };
      }
      return { ...e, text, label: e.mode === "backlog" ? text.slice(0, 40) : e.label };
    }));
  }
  /**
   * Point a queued message at a DIFFERENT session or repo — the fix for "I typed
   * this offline and the session it was for is gone / has moved on by now".
   *
   * The rules live in shared/queue.ts (`retargetEntry`), pinned by e2e-queue:
   * the ackId is minted FRESH here (the host may already hold a verdict for the
   * old one, and reusing it would have that stale verdict re-acked instead of
   * the message being delivered), attempts reset, and input↔backlog fields flip
   * to match the new destination. `canRetarget` refuses a `pending` entry (it
   * may already be on a live PTY) and any op (its payload names its own
   * subject — "send this build somewhere else" is meaningless).
   */
  function retargetQueued(ackId: string, to: { sessionId: string; cwd: string; mode?: "input" | "backlog"; targetSessionId?: string }) {
    const cur = outboxRef.current;
    const e = cur.find((x) => x.ackId === ackId);
    if (!e) return;
    if (!canRetarget(e)) { showToast(e.mode === "op" ? "an action can't be re-aimed" : "already on its way"); return; }
    track("action:queue.retarget");
    writeOutbox(retargetEntry(cur, ackId, { ...to, ackId: newAckId() }));
    showToast(to.mode === "backlog" ? "moved to that repo's backlog" : "moved to that session");
  }
  /**
   * **"when it's free", on a message already in the queue — handed to the
   * DESKTOP.**
   *
   * `toggleHoldQueued` below parks the entry on THIS PHONE, which is right for
   * exactly one lane (a prompt chained behind a session that does not exist
   * yet) and wrong everywhere else: send into a busy live session, tap the
   * strip's wait verb, lock the phone — and nothing is ever delivered. That is
   * the second holder this whole change removed from the composer, reachable in
   * two taps from the same strip it was removed from.
   *
   * So the entry is RE-AIMED into the desktop's own queue instead: the same
   * `retargetEntry` the queue sheet uses, into `backlog` mode aimed back at the
   * session it was already for, with the auto-fire flag that makes it a pinned
   * item rather than one waiting on the global switch (`retargetEntry` does not
   * set that — it knows nothing about what *when it's free* means). A fresh
   * ackId, attempts reset and the phone-side park dropped, because the entry
   * that goes up is a different message on the wire.
   */
  function handToDesktop(ackId: string) {
    const cur = outboxRef.current;
    const e = cur.find((x) => x.ackId === ackId);
    if (!e) return;
    if (!canRetarget(e)) { showToast("already on its way"); return; }
    /**
     * **The one message the desktop must not be handed, on this path too.**
     *
     * `sendCompose` already refuses it (`isLocalCommand`): `/usage` and `/model`
     * open a VIEW and start no turn, so a pinned work item delivered with
     * `watch: "turn"` never settles — it sits `running` in Activity for ever.
     * This strip had no such check, and the route is reachable: type `/usage`
     * with the link down, the entry sits in the queue un-held, the strip offers
     * *when it's free*, and one tap turns it into a desktop work item that can
     * never finish. Same verdict as the composer's, so it is the phone's own
     * park and the same sentence says why.
     */
    if (isLocalCommand(e.text ?? "")) {
      if (!e.holdUntilIdle) toggleHoldQueued(ackId);
      showToast(sendModeToast("idle", {
        online: connRef.current.status === "open", holder: "phone", phoneHold: "opens-a-view",
      })!);
      return;
    }
    track("action:queue.handtodesktop");
    const fresh = newAckId();
    writeOutbox(
      retargetEntry(cur, ackId, { sessionId: e.sessionId, cwd: e.cwd, ackId: fresh, mode: "backlog", targetSessionId: e.sessionId })
        .map((x) => (x.ackId === fresh ? { ...x, autoFire: true, holdUntilIdle: undefined, kind: undefined } : x)),
    );
    flushOutbox();
    // `composeSend.ts`'s sentence, not a second one that says the same thing in
    // different words: this is the composer's `When free` applied to a message
    // already in the queue, and one decision with four receipts is what a
    // person reads as four behaviours.
    showToast(sendModeToast("idle", { online: connRef.current.status === "open", holder: "desktop" })!);
  }
  /** Park / un-park one entry until its session's turn ends. Queued entries only
   *  — a `pending` one is already on the wire, where waiting is moot. */
  function toggleHoldQueued(ackId: string) {
    track("action:queue.hold");
    writeOutbox(outboxRef.current.map((e) => e.ackId === ackId && e.status === "queued"
      ? { ...e, holdUntilIdle: e.holdUntilIdle ? undefined : true }
      : e));
    flushOutbox();
  }
  /**
   * Flip "wait for this repo's other sessions" on one queued open.
   *
   * The per-entry counterpart to the `serialSessions` switch: that one decides
   * the default for what gets queued NEXT, this one decides about a message
   * already sitting in the queue. Only meaningful for an open that carries a
   * prompt (`isSerializable`) — nothing else starts an agent.
   */
  function toggleSerialQueued(ackId: string) {
    track("action:queue.serial");
    writeOutbox(outboxRef.current.map((e) => e.ackId === ackId && e.status === "queued" && isSerializable(e)
      ? { ...e, serial: e.serial ? undefined : serialGroup(e.cwd) }
      : e));
    flushOutbox();
  }
  /**
   * Deleting a schedule takes its own queue rows with it.
   *
   * A `schedule.run` / `schedule.save` op names a schedule by id and carries no
   * words of its own — the prompt lives in the schedule, which the user has
   * just deleted (host-side it is archived, so nothing of theirs is lost). Left
   * behind, such a row keeps the schedule's NAME on the Activity screen with a
   * "try again" that can now only ever be refused, which is what made a delete
   * that worked perfectly read as a button that does nothing.
   *
   * Only rows that never left: a `pending` one is on the wire and its receipt
   * still has to land on something.
   */
  function scheduleQueueRows(scheduleId: string): OutboxEntry[] {
    return outboxRef.current.filter((e) => {
      if (e.mode !== "op" || e.status === "pending") return false;
      if (e.op?.t === "schedule.run") return e.op.id === scheduleId;
      if (e.op?.t === "schedule.save") return e.op.entry?.id === scheduleId;
      return false;
    });
  }
  /** The delete itself, once the desktop has actually been told. The count is
   *  read BEFORE the send (it goes into that toast) and dropped only after it,
   *  so a refused offline delete leaves the queue exactly as it found it. */
  function dropScheduleQueue(rows: readonly OutboxEntry[]): void {
    if (!rows.length) return;
    const ids = new Set(rows.map((e) => e.ackId));
    writeOutbox(outboxRef.current.filter((e) => !ids.has(e.ackId)));
  }

  function removeQueued(ackId: string) {
    // An upload's bytes are parked in IndexedDB under the same key — dropping the
    // entry without them would leak a photo per discard. They are moved aside
    // rather than erased (`retainUploadBytes`): the text naming this path lives
    // in a different entry and usually outlives it, and "the file was canceled"
    // is only actionable while there is still a copy to re-attach.
    const gone = outboxRef.current.find((e) => e.ackId === ackId);
    // A create that is dropped has no session coming: forget what its pending
    // screen was showing, so it cannot go on claiming the desktop has it.
    pendingKept.current.delete(ackId);
    if (activeIdRef.current === pendingLaneId(ackId)) setActiveId(null);
    if (gone) void retainUploadBytes(gone); else void idbDel("uploads", ackId);
    // Discarding an upload does not discard the path it left in a compose draft
    // or a backlog item — remember that it is dead so sending that text later
    // is refused rather than pointing the agent at a file nobody is sending.
    if (gone?.mode === "upload" && gone.upload) noteDeadUpload(gone.upload.relPath, "the upload was canceled");
    writeOutbox(outboxRef.current.filter((e) => e.ackId !== ackId));
    // Discarding the create that would have opened the session strands the
    // prompts written to run in it: nothing will ever bind them, and a
    // `pendingCreate` entry holds its lane rather than being delivered. Surface
    // them as failed (text kept, re-aimable) instead of leaving a silent park.
    if (gone && isCreateOp(gone)) failPendingCreates(gone.sessionId, "the session it was queued for was discarded", gone.ackId);
  }
  /**
   * "…and then do this" on a queued open: append one more prompt to the chain
   * behind a `session.create`.
   *
   * A queued create on its own opens an EMPTY terminal, which is not what
   * anyone queues on a dead tunnel — the prompts are the point. The first one
   * lives in the op itself; this adds another to the same lane, held until the
   * previous turn ends. Only offered for a create that is still queued: once it
   * has been accepted the session exists and the ordinary compose path applies.
   */
  function addPromptToQueuedCreate(ackId: string, text: string) {
    const e = outboxRef.current.find((x) => x.ackId === ackId);
    if (!e || !isCreateOp(e) || e.status !== "queued") { showToast("that session is already on its way"); return; }
    track("action:queue.addprompt");
    queueSessionPrompt(e.cwd, text, e.ackId);
    showToast("queued — it runs after the one before it finishes");
  }
  /** Reorder within the session's own lane — the flat queue is global, but the
   *  order that matters is per session (see shared/queue.ts). */
  function moveQueued(ackId: string, dir: -1 | 1) {
    writeOutbox(moveInLane(outboxRef.current, ackId, dir));
  }
  /**
   * Release one entry — and everything queued AHEAD of it in its own session,
   * because a lane is delivered in order and cannot be jumped. Reorder or
   * discard the earlier ones first if that isn't what you want; other sessions
   * stay parked either way.
   */
  function sendQueuedNow(ackId: string) {
    let cur = outboxRef.current;
    const target0 = cur.find((e) => e.ackId === ackId);
    if (!target0) return;
    // A `failed` entry is given up on, not dead: the give-up bounds are about
    // not firing yesterday's prompt on its own, and an explicit tap is a fresh
    // decision. Put it back in the queue with its budget reset — the SAME ackId,
    // because the host's ledger is what makes a re-send safe: if the op did run
    // before the receipt was lost, this is re-acked instead of run twice.
    if (target0.status === "failed") {
      // …but only for a verdict the desktop did NOT remember. A retry is the
      // same ackId, so a remembered verdict comes straight back replayed
      // (`routes/session.ts`) — the entry goes `pending` for one frame and
      // lands red again, with nothing typed and nothing said. Worse, the two
      // that say the text may already be in the session (`unconfirmed`,
      // `unsubmitted` — the pair the bulk revive has always excluded) would be
      // a prompt run twice if the ledger had aged out first. Activity states
      // this per row and offers "rewrite it" instead; this is the guard for
      // every other caller, and it SAYS so rather than reviving in silence.
      const remembered = target0.failState && target0.failState !== "other";
      if (remembered) {
        showToast(target0.failState === "unconfirmed" || target0.failState === "unsubmitted"
          ? "it may already be in that session — open it and look, or rewrite it to send a fresh copy"
          : "the desktop remembers refusing this exact message — rewrite it to send it as a new one");
        return;
      }
      // Failing an upload also records the PATH as dead, which is what stops
      // the prompt naming it from being sent into a session where the file
      // will never exist. Reviving the bytes has to lift that record too —
      // otherwise the upload retries, lands, and the message it belongs to is
      // still refused for naming a file that is now sitting in the inbox.
      if (target0.mode === "upload" && target0.upload) {
        clearDeadUpload(target0.upload.relPath);
        void dropKept(target0.upload.relPath);
      }
      cur = writeOutbox(cur.map((e) => e.ackId === ackId
        ? { ...e, status: "queued" as const, attempts: 0, tries: 0, round: undefined, retryAt: undefined, waitReason: undefined, ts: Date.now(), reason: undefined, armed: true }
        : e));
    }
    const target = cur.find((e) => e.ackId === ackId);
    if (!target) return;
    const idx = cur.indexOf(target);
    const ahead = cur.filter((e, i) => i < idx && e.sessionId === target.sessionId && e.status === "queued" && !e.armed);
    // …and the park, on the same argument — unless the session is behind a wall
    // a delivery would be typed INTO (see `holdWall`). Refusing has to say which
    // wall: this used to leave the hold on and fall through to a flush that could
    // only block again, i.e. a tap that did nothing at all.
    const wall = target.holdUntilIdle && !target.pendingCreate ? holdWall(target.sessionId) : null;
    if (wall) { showToast(wall); return; }
    // An explicit tap also CLEARS the backoff: waiting out a doubling delay is
    // the automatic path's caution, and the user asking for it now overrides it.
    // …and it drops the "wait for the other session in this repo" hold on the
    // tapped entry only. `serial` is a default about how a queue drains on its
    // own; a tap is a decision about this one message, and it wins. `holdUntilIdle`
    // goes with it, and for the same reason: a park is how a queue drains when
    // nobody is watching, and typing into a session whose only busy fact is a
    // turn in flight is what every un-parked entry does anyway.
    //
    // The entries AHEAD of it in the lane lose their park too. A lane is
    // delivered in order and a held entry HOLDS it (`selectSendable`), so
    // releasing only the tapped one would have left it behind a message that was
    // still waiting — the tap would again have sent nothing.
    writeOutbox(cur.map((e, i) =>
      e.ackId === ackId ? { ...e, armed: true, retryAt: undefined, waitReason: undefined, serial: undefined, holdUntilIdle: unpark(e) }
        : (i < idx && e.sessionId === target.sessionId && e.status === "queued")
        ? { ...e, armed: true, retryAt: undefined, waitReason: undefined, holdUntilIdle: unpark(e) } : e));
    // NOT a global un-hold: releasing one session's message must not drain the
    // rest of the queue. An armed entry is eligible on its own.
    if (!flushOutbox()) showToast(idleReason("nothing left to send"));
    else if (ahead.length) showToast(`${ahead.length} earlier message${ahead.length > 1 ? "s" : ""} in this session go first`);
  }
  /**
   * Revive every given-up row that is provably un-sent, in one tap.
   *
   * Rows land here in BATCHES, which is why the bulk control exists: a host
   * that refuses a whole lane (its session is gone), or a create whose failure
   * cascades onto every prompt chained behind it, turns twenty messages red in
   * one pass. A retry on each is the right control for one message and the
   * wrong one for twenty.
   *
   * Same reset as `sendQueuedNow`, and the same reason it is safe: the ackId is
   * KEPT, so the host's ledger re-acks anything that did run rather than
   * running it twice. `unconfirmed` and `unsubmitted` are excluded — those were
   * typed into a live composer and never seen to submit, so re-sending one is a
   * decision about that message, made by a person, one at a time.
   *
   * And so are `stale` and `refused`, for the mirror reason: keeping the ackId
   * is what makes the retry safe, and it is also what makes it futile once the
   * desktop has RECORDED a no. Those rows come back refused within the second,
   * which in a batch of twenty is twenty rows that flicker and stay red. Their
   * way out is a rewrite, one at a time (see `sendQueuedNow`).
   */
  function retryFailedQueued() {
    const revive = outboxRef.current.filter((e) => e.status === "failed"
      && (!e.failState || e.failState === "other"));
    if (!revive.length) { showToast("nothing to try again"); return; }
    // The dead mark AND the copy kept against it: this row is going to upload
    // from its own ackId again, so a second copy under the path would outlive
    // the reason it was made.
    for (const e of revive) if (e.mode === "upload" && e.upload) {
      clearDeadUpload(e.upload.relPath);
      void dropKept(e.upload.relPath);
    }
    const ids = new Set(revive.map((e) => e.ackId));
    writeOutbox(outboxRef.current.map((e) => ids.has(e.ackId)
      ? { ...e, status: "queued" as const, attempts: 0, tries: 0, round: undefined, retryAt: undefined, waitReason: undefined, ts: Date.now(), reason: undefined, failState: undefined, failedAt: undefined, armed: true }
      : e));
    const sent = flushOutbox();
    showToast(sent ? `${revive.length} back in the queue — sending…` : `${revive.length} back in the queue — ${idleReason("waiting")}`);
  }

  /** Take one message back out of the queue and into a compose box — the one
   *  belonging to ITS session, not whichever session happens to be open. The
   *  queue sheet is reachable from anywhere, so pasting into the visible box
   *  would hand session A's prompt to session B. Falls back to the current box
   *  when the entry has no live session left (a work item, or one that died). */
  function restoreQueued(ackId: string) {
    const e = outboxRef.current.find((x) => x.ackId === ackId);
    if (!e) return;
    if (e.mode === "op") { showToast("that's an action — discard it instead"); return; }
    // A prompt still waiting for its session has no live target to hand the
    // text back to, so it always lands in the compose box below.
    if (e.pendingCreate) {
      removeQueued(ackId);
      setCompose((c) => (c ? `${c}\n${e.text}` : e.text));
      showToast("moved into the message box");
      return;
    }
    removeQueued(ackId);
    const target = sessions.find((s) => s.id === e.sessionId);
    if (!target) {
      setCompose((c) => (c ? `${c}\n${e.text}` : e.text));
      showToast("moved into the message box");
      return;
    }
    const existing = loadDraft(target.id);
    const merged = existing ? `${existing}\n${e.text}` : e.text;
    saveDraft(target.id, merged);
    if (activeId === target.id) setCompose(merged);
    showToast(`moved into ${target.title}'s message box`);
  }

  /** Which repo an entry's `.claude/inbox/…` paths belong to. */
  function repoIdOfEntry(e: OutboxEntry): string | null {
    return c.repoForCwd(e.cwd)?.id ?? null;
  }

  return {
    restoreOutbox, dismissOutbox, editQueued, retargetQueued, handToDesktop, toggleHoldQueued, toggleSerialQueued,
    scheduleQueueRows, dropScheduleQueue, removeQueued, addPromptToQueuedCreate, moveQueued, sendQueuedNow,
    retryFailedQueued, restoreQueued, repoIdOfEntry,
  };
}
