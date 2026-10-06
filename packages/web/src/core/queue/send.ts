/**
 * The flusher and every way words, ops and bytes enter the queue — the ONE
 * send path. Lifted verbatim from App; the functions it calls in the other
 * files of the core are reached through the per-render context (`types.ts`),
 * bound once at the top so the bodies read exactly as they did.
 *
 * `newAckId()` is minted in this folder and nowhere else in the tree
 * (`queue.test.mjs` counts the sites): a retry re-sends `entry.op`'s bytes or
 * the same `ackId`, and only a provably-new message gets a fresh one.
 */
import {
  adoptReferencedUploads, applyRelease, busySerialGroups, danglingUploadRefs, isLocalCommand, promptFingerprint,
  queueIdleReason, roundDelay, MIN_TRY_MS, selectSendable, sendEligible, serialGroup, uploadAttemptWasted,
  type ClientMessage, type SessionInfo,
} from "@waterplane/shared";
import {
  deadUploadReason, newAckId, plannedInboxPath, MAX_SEND_ATTEMPTS, type OutboxEntry,
} from "../../outbox";
import { keepUploadBytes } from "../../attachments";
import { idbDel, idbGet, idbSet } from "../../idb";
import { noteAckTimeout, noteSendExpired, rttP95, syncSnapshot } from "../../link";
import { showToast } from "../../toast";
import { api } from "../../api";
import type { UploadError } from "../../api";
import { rememberMtime } from "../../fileMtime";
import { noteUploadRate } from "../../uploadScale";
import type { DurableOp, QueueBacklogOpts } from "../../sdk/types.ts";
import {
  ACK_TIMEOUT_MS, LANE_GAP_MS, PENDING_PREFIX, UPLOAD_STALL_MS, ackWindow, goneLanesOf, isPendingId, laneFor, requeue,
  serialStates, serialTextFor, markAttempt, entryFrame,
} from "./logic.ts";
import type { QueueCtx, SendFns } from "./types.ts";

export function sendFns(c: QueueCtx): SendFns {
  const { connRef, sessionsRef, exitedRef, outboxRef, ackTimers, uploadsInFlight, uploadAborts, busyLanesRef, budgetHeldLanesRef,
    busySerialRef, serialWatchRef, budgetRef, autoSendRef, holdQueueRef, flushIdleReason, queueBlockedRef,
    readModeRef, serialSessionsRef, sessions } = c;
  const { inflightRef, upBytesRef } = c.up;
  const refreshUploadLabel = () => c.up.refreshUploadLabel();
  const writeOutbox = (list: OutboxEntry[]) => c.writeOutbox(list);
  const addOutbox = (e: OutboxEntry, frontOfLane?: boolean) => c.addOutbox(e, frontOfLane);
  const addOutboxFirstInLane = (e: OutboxEntry) => c.addOutboxFirstInLane(e);
  const failOutbox = (ackId: string, reason: string, state?: OutboxEntry["failState"]) => c.failOutbox(ackId, reason, state);
  const holdWall = (sessionId: string) => c.holdWall(sessionId);
  const queueSessionPrompt = (cwd: string, text: string, createAck: string, kind?: "prompt" | "command") =>
    c.queueSessionPrompt(cwd, text, createAck, kind);

  /**
   * An upload entry is going away — keep its BYTES, keyed by the path the text
   * already names.
   *
   * Deleting them was the quiet half of a lost prompt. The file and the message
   * naming it are separate queue entries with separate verdicts, so an upload
   * could fail, be discarded or age out while the prompt survived — and the
   * prompt then read perfectly and pointed at a path that could never exist
   * again, because the only copy of the photo had just been erased from the one
   * device that had it. Keeping it (bounded, oldest-first — see
   * `attachments.ts`) is what makes "re-attach" a button rather than an
   * apology.
   */
  async function retainUploadBytes(e: OutboxEntry, drop = true): Promise<void> {
    if (e.mode !== "upload") return;
    const blob = e.upload ? await idbGet<Blob>("uploads", e.ackId) : null;
    if (blob && e.upload) await keepUploadBytes(e.upload.relPath, blob);
    // `drop: false` for a row that is merely FAILED. The row is still there and
    // `retryFailedQueued` may revive it under the same ackId, which flushes from
    // `uploads/<ackId>` — deleting that copy here would revive an entry with no
    // bytes and fail it on the first attempt, with the only copy somewhere the
    // flusher does not look. Two copies for as long as a dead row lives, bounded
    // by KEEP_CAP; the revival paths drop the kept one.
    if (drop) await idbDel("uploads", e.ackId);
  }

  /** How long this entry's receipt may take before we put it back in the
   *  queue — `logic.ts`'s `ackWindow` over the measured p95 ping. */
  function ackWindowFor(e: OutboxEntry): number {
    return ackWindow(e, rttP95());
  }

  /**
   * A whole attempts ladder spent with nobody ever answering — so wait longer
   * and try the lot again. **Not a failure, and the row does not go red.**
   *
   * This is the path that used to end in `failOutbox("delivery kept failing")`,
   * and it was the one red row in this app that was never about the message: a
   * refusal is answered on the wire and fails on the spot, so everything that
   * reaches here is a delivery the desktop never got to have an opinion about.
   * Telling somebody their prompt is undelivered because their phone was in a
   * lift is a verdict on the lift.
   *
   * The attempts counter resets (the next round is a fresh ladder) while
   * `tries` and `round` do not, so the wait grows 5 → 10 → 20 → 30 minutes and
   * stays there, for ever. Safe to repeat for the same reason every other retry
   * here is: the host keys delivery on `ackId` in its durable Intent store and
   * re-acks work it has already done rather than running it twice.
   */
  function nextRound(ackId: string): void {
    const now = Date.now();
    writeOutbox(outboxRef.current.map((x) => {
      if (x.ackId !== ackId || x.status === "failed") return x;
      const round = (x.round ?? 0) + 1;
      const wait = roundDelay(round);
      return {
        ...x,
        status: "queued" as const,
        attempts: 0,
        round,
        retryAt: now + wait,
        waitReason: "the desktop hasn't answered yet",
      };
    }));
    // Said once, on the FIRST round only. The point of the long backoff is that
    // nobody has to watch it; a toast every five minutes would undo that, and
    // the queue bar carries the countdown for anyone who does look.
    const e = outboxRef.current.find((x) => x.ackId === ackId);
    if (e && (e.round ?? 0) === 1) {
      showToast(`still sending — the desktop hasn't confirmed yet. Retrying in ${Math.round(roundDelay(1) / 60000)} min; your text is safe.`);
    }
  }

  /** Delivery deadline for one attempt. No receipt in the window ⇒ put it back in
   *  the queue for the next flush rather than failing it — the socket may simply
   *  have gone away mid-flight, which is the normal case on a phone. */
  function armAckTimeout(ackId: string, windowMs = ACK_TIMEOUT_MS) {
    const t = window.setTimeout(() => {
      ackTimers.current.delete(ackId);
      const cur = outboxRef.current;
      // Was there anything to receive a receipt ON? A socket that closed inside
      // the window never carried the message to a host that could answer it, so
      // counting that as a delivery attempt spends the entry's give-up budget on
      // the network being down — which is the one condition the queue exists to
      // ride out. Roll the attempt back in that case; a timeout on a socket that
      // stayed open is a real attempt and stays counted.
      const wasted = connRef.current.status !== "open";
      if (cur.some((x) => x.ackId === ackId && x.status === "pending")) {
        noteAckTimeout();
        writeOutbox(cur.map((x) => x.ackId === ackId ? requeue(x, wasted) : x));
      }
      // Retry immediately if we still have a socket; otherwise the reconnect
      // flush picks it up. It stays eligible on its own (attempts > 0 — the
      // same send, not a new one the switches get a say over).
      flushOutbox();
    }, windowMs);
    ackTimers.current.set(ackId, t);
  }

  /**
   * Lane keys whose SESSION IS GONE — the entries that must not be written to
   * the socket at all.
   *
   * The host refuses a message for a session it does not have with
   * `ok:false, reason:"session not available"` and no `retryable`, which
   * `input.ack` correctly turns into a give-up. Correct per message, wrong per
   * LANE: five prompts queued for one closed session were fired one at a time
   * over five flushes and produced five red rows and five toasts for a single
   * fact, none of which named the move that fixes it (re-aim it, `⋯` → aim at
   * another session). `selectSendable` now holds the whole lane instead, and
   * the row says why.
   *
   * Two conditions on trusting the list, because the cost of getting this wrong
   * is a queue that refuses to send into a session that is alive:
   *   • the socket is open, and
   *   • a `session.list` has landed on THIS connection (`syncSnapshot().pending`
   *     is the same test `netsync` shows the user) — the list from the previous
   *     connection is exactly the stale data that would strand live lanes.
   * Offline the answer is the empty set, which is the pre-existing behaviour.
   *
   * Only `input` entries are read from this. An op lane is `create:<cwd>` /
   * `fanout` / `build:<id>`, an upload is an HTTP POST to the repo inbox, a work
   * item is added to the REPO (the host resolves a dead `targetSessionId` by
   * falling back to that repo's default session), and a `pendingCreate` entry
   * names a session that does not exist YET. `selectSendable` states the same
   * rule where it applies it.
   */
  function goneLanes(): string[] {
    if (connRef.current.status !== "open") return [];
    if (syncSnapshot().pending.includes("sessions")) return [];
    // `running: false` counts as gone: that is the host's own test
    // (`main.ts`'s `!info || !info.running`), and a just-exited session stays in
    // the list for a while.
    const live = new Set(sessionsRef.current.filter((x) => x.running).map((x) => x.id));
    return goneLanesOf(outboxRef.current, live, exitedRef.current);
  }


  /**
   * Write the sendable `queued` entries to the socket — the ONLY place a
   * compose/slash send or a queued work item reaches the wire. Offline, an
   * entry just stays queued (in localStorage, so a reload or the OS killing
   * the tab doesn't lose it) and this runs again on reconnect.
   *
   * ONE IN FLIGHT PER SESSION (`selectSendable`). Draining the whole queue at
   * once mangles anything typed more than once for the same session: the PTY
   * composer concatenates the writes into a single line and the Returns that
   * follow submit the mush. Different sessions still go out together.
   *
   * Eligibility, per entry, so the "hold the queue" switches stay honest:
   *   • attempts > 0 — already went out once; this is the SAME message being
   *     retried, not a new decision the switches get a say over.
   *   • `armed` — the user released this one explicitly (tapped Send, "Try
   *     now", or "Send all" on the reconnect prompt). Persisted with the entry,
   *     so the intent survives a reload.
   *   • otherwise only when auto-send is on AND no reconnect confirmation is
   *     pending.
   * `armAll` marks every queued entry armed first — that IS the explicit
   * release, and it clears the reconnect hold.
   */
  function flushOutbox(armAll = false): number {
    if (armAll) {
      holdQueueRef.current = false;
      // The park goes too — "send everything queued" is the same decision
      // `sendQueuedNow` makes, taken over the whole queue — except for a lane
      // sitting behind a wall a delivery would be typed into (`holdWall`): those
      // keep their hold and stay in the queue, so the sheet still explains them
      // instead of a prompt landing in a question box.
      writeOutbox(outboxRef.current.map((e) => e.status === "queued"
        ? { ...e, armed: true, retryAt: undefined, waitReason: undefined,
            // A `pendingCreate` entry is the exception: its lane is a session
            // that does not exist yet, so its park is not a wait it is serving
            // now — it is the flag it needs AFTER `bindPendingSession` points it
            // at a real id (see `selectSendable`). Stripping it here would let a
            // prompt queued behind an open be typed while the CLI is still
            // starting up.
            holdUntilIdle: e.holdUntilIdle && (e.pendingCreate || holdWall(e.sessionId)) ? true : undefined }
        : e));
    }
    if (connRef.current.status !== "open") {
      flushIdleReason.current = queueIdleReason([], { online: false, queued: 1 });
      return 0;
    }
    // Before anything is selected: a lane whose session has been gone for a
    // while is not a queue problem to be reported, it is a target problem to be
    // fixed. Runs first so the entries it moves are sendable on THIS pass.
    const gone = goneLanes();
    const plan = selectSendable(outboxRef.current, {
      now: Date.now(),
      // Written to the socket (receipt outstanding) OR uploading over HTTP. Both
      // hold their lane: an image still going up must not be overtaken by the
      // prompt that names the path it is going to land at.
      inflight: [...ackTimers.current.keys(), ...uploadsInFlight.current],
      // The only give-up bound left. There is no `ttlMs`: an entry that cannot
      // reach the host waits, visibly, for as long as that takes.
      maxAttempts: MAX_SEND_ATTEMPTS,
      // …and it may not be spent in less than a minute of actually trying. A
      // count of eight receipt windows is not a duration, and on a bad radio it
      // used to run out while the link was still coming back — putting a red
      // "delivery kept failing" row under words that were typed seconds ago.
      minTryMs: MIN_TRY_MS,
      // Only `holdUntilIdle` entries consult this; everything else still sends
      // into a working session, because typing while the agent works is normal.
      busyLanes: busyLanesRef.current,
      // "One session at a time in this repo" — the groups whose previous open is
      // still working (`serial`). Recomputed here rather than only on the
      // session-list effect so a flush fired by an ack sees the watch the ack
      // itself just added.
      busySerial: (() => {
        const g = busySerialGroups(serialStates(sessionsRef.current), serialWatchRef.current, Date.now());
        busySerialRef.current = g.busy;
        serialWatchRef.current = g.watches;
        return g.busy;
      })(),
      // Past the usage ceiling the user set: hold everything that would START
      // work, and nothing else (an explicit send, an answer to a live question,
      // and bytes still go — see `SelectSendableOpts.budgetBlocked`).
      budgetBlocked: budgetRef.current?.verdict.blocked ?? false,
      // Lanes whose session has gone. Only entries with NO `cwd` are held on
      // this now (see `selectSendable`): given one, the host writes the words to
      // that repo's work items itself and answers `rescued`, so holding it here
      // is what stopped the rescue from ever running.
      goneLanes: gone,
      // Sessions over their OWN budget: the same three exemptions (armed, an
      // answer, bytes). Unknown never lands in this set — `sessionBudgetHeld`.
      budgetHeldLanes: budgetHeldLanesRef.current,
    });
    // Persist the release: a `holdUntilIdle` entry whose lane just went quiet is
    // an ordinary queued message from here on, and the flag has to come off on
    // disk or every pass reports the same release again.
    if (plan.release.length) writeOutbox(applyRelease(outboxRef.current, plan.release));
    for (const x of plan.expire) { noteSendExpired(); nextRound(x.ackId); }
    const gate = { autoSend: autoSendRef.current, hold: holdQueueRef.current };
    let sent = 0;
    // The ladder's own refusals, plus the ones the user's switches make below —
    // `sendEligible` is deliberately not part of `selectSendable` (one answers
    // "would it corrupt the session?", the other "did the user mean to send
    // it?"), so the two halves of the explanation are joined here.
    const blocked = [...plan.blocked];
    for (const e of plan.send) {
      // Not eligible ⇒ this lane stays parked. Only THIS lane: `plan.send` holds
      // one entry per session, so a held session can't stall another.
      if (!sendEligible(e, gate)) { blocked.push({ ackId: e.ackId, sessionId: e.sessionId, reason: "gate" as const }); continue; }
      // `markAttempt` stamps `firstTryAt` on this ackId's FIRST attempt and keeps
      // it on every retry; it is the wire's `firstSentAt` (`entryFrame`).
      const now = Date.now();
      const attempt = markAttempt(e, now);
      writeOutbox(outboxRef.current.map((x) => (x.ackId === e.ackId ? markAttempt(x, now) : x)));
      if (e.mode === "upload") {
        // Not a socket message at all — an HTTP POST of the image bytes parked in
        // IndexedDB. No ack timeout is armed (see `uploadsInFlight`): the upload
        // settles itself, and requeuing it on a 6 s deadline would send the same
        // photo twice.
        void runUpload(e);
        sent++;
        continue;
      }
      // The frame is built in the queue's pure half (`logic.ts`'s `entryFrame`),
      // where every mode's shape — and the first-send stamp it carries — is
      // asserted by `logic.test.mjs`.
      const frame = entryFrame(attempt);
      if (frame) connRef.current.send(frame);
      armAckTimeout(e.ackId, ackWindowFor(e));
      sent++;
    }
    // Recorded BEFORE the sentence is woven, and from the same array: the
    // sentence is a summary of this map, so the two can never disagree.
    const blockedBy = new Map(blocked.map((b) => [b.ackId, b.reason]));
    queueBlockedRef.current = blockedBy;
    c.setQueueBlocked(blockedBy);
    flushIdleReason.current = sent
      ? null
      : queueIdleReason(blocked, {
          online: true,
          queued: outboxRef.current.filter((e) => e.status === "queued").length,
          serialText: (() => {
            const b = blocked.find((x) => x.reason === "serial");
            const e = b && outboxRef.current.find((x) => x.ackId === b.ackId);
            return e?.serial ? serialTextFor(e.serial, sessionsRef.current) : undefined;
          })(),
        });
    return sent;
  }

  /** The sentence for a flush that sent nothing, for the taps that have to say
   *  something. Falls back only when the queue is genuinely empty. */
  function idleReason(fallback = "nothing queued"): string {
    return flushIdleReason.current ?? fallback;
  }

  /** Hand the lane back after a delivery settled: the next entry for that
   *  session may go out now. Delayed so the submitting Return has been written
   *  and the TUI has processed it — the next prompt must land in an EMPTY
   *  composer, not glued onto one still holding the last line. */
  function releaseLane(): void {
    window.setTimeout(() => { flushOutbox(); }, LANE_GAP_MS);
  }

  /**
   * Tie a message to the images it NAMES, before it is queued.
   *
   * Attaching an image parks it in the queue and drops the path it will land at
   * into the compose box; the message carrying that path is queued later, from
   * wherever the user sends it. Nothing connected the two but the lane key they
   * happened to be parked under — and it differed whenever the attach was made
   * for a repo rather than a session (`uploadMany`, the backlog/gallery
   * annotate flows), or the user switched sessions in between. Two lanes drain
   * at the same time, so the prompt beat its own picture up the wire and the
   * agent read a `.claude/inbox/<file>` that did not exist yet. With the link
   * up, which is why it never looked like a queue problem.
   *
   * Two halves, both in `shared/queue.ts` so `e2e-queue.mjs` can pin them:
   * adopt every live upload this text references into THIS lane (the
   * one-in-flight-per-lane rule then makes the message wait for the bytes), and
   * refuse outright when the text names an upload that already failed. The
   * refusal keeps the text where it is — the picture has to be re-attached, and
   * sending a path that will never resolve only makes both ends disagree about
   * what happened.
   */
  /**
   * The REFUSAL half, on its own and lane-independent: does this text name an
   * upload that is never going to arrive? Returns the sentence to say, or null.
   *
   * Split out because the adopt half needs a lane and the refusal does not, and
   * a chain has to be able to ask the second question about EVERY step before
   * the first step is sent (`guardChain`).
   */
  function uploadRefusal(text: string): string | null {
    // A path whose entry is gone entirely (failed then discarded, evicted by
    // the cap) is remembered on its own — the draft holding it outlives the
    // queue by design.
    const failed = danglingUploadRefs(outboxRef.current, text)[0];
    const dead = failed ? { relPath: failed, reason: "it never uploaded" } : deadUploadReason(text);
    return dead ? `${dead.relPath.split("/").pop()} — ${dead.reason}. Re-attach it before sending.` : null;
  }

  function guardUploadRefs(text: string, lane: string): boolean {
    const said = uploadRefusal(text);
    if (said) { showToast(said); return false; }
    const next = adoptReferencedUploads(outboxRef.current, text, lane);
    if (next.some((e, i) => e !== outboxRef.current[i])) writeOutbox(next);
    return true;
  }

  /**
   * **Every step, before ANY step.**
   *
   * A chain is sent one post at a time, and the per-post guard therefore asked
   * its question after the earlier posts had already gone: step 3 naming a dead
   * upload was refused with a toast while steps 1 and 2 were on the wire, the
   * arm still reported a send, and `SendSheet.go()` cleared the draft on it.
   * Step 3's words were then nowhere — not queued, not in the draft, not on the
   * pad, only named in a toast that scrolls away. A draft is the last copy, so
   * the whole chain is judged first and a refusal keeps the sheet up with all
   * of the words still in it.
   *
   * The joined text is what `danglingUploadRefs` / `deadUploadReason` read, and
   * both find a path anywhere in a string, so joining is not a trick — it is
   * the same question asked once over everything that is about to be posted.
   */
  function guardChain(steps: readonly string[]): boolean {
    const said = uploadRefusal(steps.join("\n"));
    if (said) { showToast(said); return false; }
    return true;
  }

  /** Queue text for a session. Delivery — and the submitting Return — happen in
   *  `flushOutbox`/the ack handler, so this works identically online and off.
   *  An entry typed with the link UP is `armed` (tapping Send is the release);
   *  one typed while OFFLINE is not, so the reconnect prompt can ask about it.
   *
   *  false = refused (the text names an image that will never arrive); the
   *  caller must keep the text rather than clearing the box on it. */
  function submitInput(id: string, cwd: string, text: string, kind: "prompt" | "command", holdUntilIdle = false): boolean {
    /**
     * **A view is not an interjection.**
     *
     * Everything typed here goes in AT ONCE, on the rule that typing at a
     * working agent is something a person means to do. That rule is right for
     * prose and wrong for a TUI-local command, which does not submit a prompt at
     * all — it opens a modal. Delivered into a session mid-turn it lands a
     * settings dialog over a streaming agent, contests the composer that turn is
     * using, and is dismissed again by the next thing that touches the screen:
     * reported from a phone as `/usage` followed by the CLI's own "Settings
     * dialog dismissed", 22 minutes into a turn, and from the other side as a
     * delivery stuck at "Sending… 10s" holding the composer while the agent
     * streamed underneath it.
     *
     * So a local command aimed at a BUSY session is parked instead — the queue
     * already has the mechanism, the strip above the composer says it is waiting
     * and offers *send now* for the case where interrupting is the point. An
     * idle session takes it immediately, which is every ordinary use of it.
     */
    if (!holdUntilIdle && isLocalCommand(text)) {
      const s = sessions.find((x: SessionInfo) => x.id === id);
      const busy = !!s && (s.hooked ? !!s.turnActive : !!s.running && !s.idle);
      if (busy) {
        holdUntilIdle = true;
        showToast(`${text.trim().split(/\s+/)[0]} opens a view — held until this turn ends`);
      }
    }
    // A pending session's lane is the create's, not its screen id — the text
    // has to adopt the lane its FILES are in (`adoptReferencedUploads`), and
    // those are parked behind the create like every other chained prompt.
    if (!guardUploadRefs(text, laneFor(id, cwd))) return false;
    // The screen is a session that does not exist yet: the words go into the
    // create's OWN lane, exactly where a chained prompt has always gone, and
    // `bindPendingSession` re-aims them the moment `op.ack` names the session.
    // Not a special path — the same queue entry `startSessionWithPrompt` writes
    // for prompt 2 of a chain.
    if (isPendingId(id)) {
      queueSessionPrompt(cwd, text, id.slice(PENDING_PREFIX.length), kind);
      flushOutbox();
      return true;
    }
    const ackId = newAckId();
    const offline = connRef.current.status !== "open";
    // `view` — which screen this was written over. Stamped HERE, at the moment
    // the words are composed, because that is the fact being measured; by the
    // time the entry flushes the person may be looking at something else. It
    // changes nothing about the send (see `DeliveryShape` host-side).
    addOutbox({ ackId, sessionId: id, cwd, text, ts: Date.now(), status: "queued", attempts: 0, kind, mode: "input", offline, armed: !offline, holdUntilIdle: holdUntilIdle || undefined, view: readModeRef.current ? "read" : "term" });
    if (!offline) armLane(id);
    flushOutbox();
    return true;
  }

  /**
   * Queue a durable ACTION — "open a session here", "fan out to these repos",
   * "run this build". These used to be bare socket writes, and the ws layer
   * drops what it can't deliver: tapping a repo on a dead tunnel simply did
   * nothing, with no trace and nothing to retry.
   *
   * `laneKey` is the serialization lane, NOT a session id (an op usually has no
   * session yet). `create:<cwd>` keeps two taps on the same repo from racing,
   * `fanout` is one lane so sweeps stay in the order they were fired,
   * `fu:<runId>` keeps a run's follow-ups behind each other, `build:<repoDir>`
   * keeps one repo's builds sequential.
   *
   * The ackId is minted here and BAKED INTO the payload, because the payload is
   * what gets re-sent: identical bytes on every retry is exactly what makes the
   * host's ledger able to say "already did that".
   *
   * Deliberately NOT durable: `session.kill` and the backlog mutations. A
   * destructive command delivered an hour late is wrong, not helpful — those
   * fail fast while the link is down.
   */
  function queueOp(
    op: DurableOp,
    laneKey: string,
    text: string,
    opts?: { cwd?: string; focus?: boolean; frontOfLane?: boolean; ackId?: string; serial?: boolean },
  ): boolean {
    // Usually minted here. A caller passes one in when something else has to
    // NAME this op before it exists — the prompts chained behind a
    // `session.create` carry its ackId so they bind to the session IT makes,
    // not to whichever create for this repo acks first.
    const ackId = opts?.ackId ?? newAckId();
    const offline = connRef.current.status !== "open";
    const cwd = opts?.cwd ?? "";
    // "One session at a time in this repo", when the switch is on and this op
    // would actually START work — an open carrying a first prompt. The group is
    // the working directory, so a worktree (the thing this app makes to run work
    // in parallel SAFELY) is never held up by its parent checkout.
    // The Send sheet asks per message (`sequential`); the switch is the default
    // for everything else. One-at-a-time is now a composition-time choice, not
    // only a global preference and a repair in the queue manager.
    const wantSerial = opts?.serial ?? serialSessionsRef.current;
    const serial = wantSerial && op.t === "session.create" && op.prompt && cwd
      ? serialGroup(cwd) : undefined;
    addOutbox({
      ackId, sessionId: laneKey, cwd, text,
      ts: Date.now(), status: "queued", attempts: 0, mode: "op", serial,
      op: { ...op, ackId },
      // Only a tap made with the link up may steal the view when it lands.
      focus: opts?.focus && !offline ? true : undefined,
      offline, armed: !offline,
      // `frontOfLane`: a create that carries `needs` overtakes the uploads it is
      // waiting for. Counter-intuitive only until you see what it buys — the
      // HOST is what should be waiting for those files, not this tab, so the
      // intent has to reach it BEFORE the megabytes do. Handing it over is one
      // small JSON message; the pictures can then take as long as they take.
    }, opts?.frontOfLane);
    if (!offline) armLane(laneKey);
    flushOutbox();
    return offline;
  }

  /**
   * Park an IMAGE in the send queue instead of uploading it now.
   *
   * The compose box could already survive a dead tunnel; the picture attached to
   * it could not — `api.uploadInbox` is a plain POST, so an image picked while
   * offline died at the fetch and the prompt referencing it was left pointing at
   * a file that never arrived. The bytes go to IndexedDB (they are megabytes;
   * localStorage is where the send queue itself lives and must not be evicted),
   * the entry goes in the same queue as everything else, and the flusher does
   * the POST when the link is back.
   *
   * Returns the repo-relative path the prompt may reference RIGHT NOW —
   * predicted, because the text has to exist before the upload does — plus the
   * ackId of the queue entry holding the bytes, so the caller can drop it again
   * ("cancel uploads"). Null means the bytes couldn't be persisted (IndexedDB
   * unavailable), and the caller must not pretend the image is on its way.
   *
   * `lane` is what enforces the order: the same lane as the prompt that names
   * the path, so the file is on disk before the agent is told to look at it.
   */
  async function queueImageUpload(repoId: string, blob: Blob, filename: string, lane: string, cwd: string): Promise<{ relPath: string; ackId: string } | null> {
    lane = laneFor(lane, cwd);
    const ackId = newAckId();
    const { name, relPath } = plannedInboxPath(filename);
    await idbSet("uploads", ackId, blob);
    // Read it back before promising anything: idbSet is best-effort by design
    // (private mode resolves every op to a no-op), and an entry whose bytes were
    // never stored would fail on the first flush with the image already gone.
    if (!(await idbGet<Blob>("uploads", ackId))) return null;
    addOutbox({
      ackId, sessionId: lane, cwd, text: `file · ${name}`,
      ts: Date.now(), status: "queued", attempts: 0, mode: "upload",
      upload: { repoId, name, relPath, size: blob.size, type: blob.type || "application/octet-stream" },
      // Always released: an attached image is never the "text written against a
      // session state that has moved on" the reconnect prompt asks about, and
      // holding it would strand the prompt queued behind it in the same lane.
      armed: true,
    });
    flushOutbox();
    return { relPath, ackId };
  }

  /** POST one queued image. Settles the entry itself — there is no `input.ack`
   *  for an upload, and no ack timeout either (see `uploadsInFlight`). */
  async function runUpload(e: OutboxEntry): Promise<void> {
    const meta = e.upload;
    if (!meta) { failOutbox(e.ackId, "not an image"); releaseLane(); return; }
    uploadsInFlight.current.add(e.ackId);
    const ctrl = new AbortController();
    uploadAborts.current.set(e.ackId, ctrl);
    // Byte progress for the compose strip. The transfer is the queue's now, but
    // it is still the thing blocking Send, and a spinner with no numbers can't
    // be told apart from a stalled uplink.
    inflightRef.current++;
    if (!upBytesRef.current.startedAt) upBytesRef.current.startedAt = Date.now();
    upBytesRef.current.total += meta.size;
    refreshUploadLabel();
    let last = 0;
    const t0 = Date.now();
    // Bound SILENCE, not the transfer (see UPLOAD_STALL_MS). Every progress
    // event re-arms it; an abort lands in the catch below as an ordinary
    // failure, which is what requeues the entry. Aborting FIRST is also what
    // makes the requeue safe — the socket-level retry can't race a POST that is
    // still alive, so the same photo is never sent twice.
    let stalled = false;
    let stall = 0;
    const armStall = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(() => { stalled = true; ctrl.abort(); }, UPLOAD_STALL_MS);
    };
    armStall();
    try {
      const blob = await idbGet<Blob>("uploads", e.ackId);
      // The bytes are the one thing that can't be recovered — a retry would
      // upload nothing, so this fails for good rather than looping.
      if (!blob) { failOutbox(e.ackId, "the file's bytes are no longer on this device"); return; }
      const r = await api.uploadInbox(meta.repoId, blob, meta.name, ctrl.signal, (loaded) => {
        upBytesRef.current.sent += Math.max(0, loaded - last);
        last = loaded;
        armStall();
        refreshUploadLabel();
      }, true);
      // A 200 carrying `skipped` IS the host's verdict on this file (`.env`, an
      // unknown type) and will not change on a retry. Every other status now
      // rejects instead of landing here (see api.uploadInbox).
      const actual = r.saved?.[0]?.relPath;
      if (!actual) { failOutbox(e.ackId, r.skipped?.[0]?.error || "the host refused the file"); return; }
      // The receipt carries the mtime of the file the host just wrote — the one
      // moment this device can know it for free. It is what makes the thumbnail
      // of the picture just sent cacheable, in the prompt that names it, before
      // the tunnel has a chance to drop (fileMtime.ts).
      rememberMtime(meta.repoId, actual, r.saved[0].mtime);
      noteUploadRate(meta.size, Date.now() - t0);
      void idbDel("uploads", e.ackId);
      // The name was minted to be collision-proof, but the host still owns
      // `ensureUnique` — if it renamed the file anyway, every queued prompt that
      // was written against the prediction has to follow it, or the agent is
      // pointed at a path that doesn't exist.
      if (actual !== meta.relPath) rewriteQueuedPath(meta.relPath, actual);
      writeOutbox(outboxRef.current.filter((x) => x.ackId !== e.ackId));
    } catch (err) {
      // 413/415 is the host's answer, not the link's — retrying it eight times
      // only burns the entry's budget and ends in the same place.
      if ((err as UploadError)?.permanent) { failOutbox(e.ackId, (err as Error).message); return; }
      // Network/tunnel failure: put it back in the queue.
      //
      // The attempt is ROLLED BACK when nothing could have received the bytes —
      // the exact rule `armAckTimeout` applies to socket sends, and the one this
      // path was missing. A backgrounded phone on a flapping tunnel retries on
      // the 5 s sweep, so eight failures go by in under a minute and the image
      // was expired ("delivery kept failing") while the link was still coming
      // back — the queue spending its give-up budget on the one condition it
      // exists to ride out. A stall counts as wasted for the same reason: we
      // aborted it, the host never answered either way.
      // An attempt only counts when the HOST ANSWERED. A status (even 500) is a
      // decision about this file; a transport error is not — and the socket
      // still reading "open" proves nothing, because a host being restarted
      // kills the POST a moment before its WS close event lands. That gap is
      // how a burst of restarts could burn all eight attempts in well under a
      // minute and fail an image for good ("delivery kept failing") on a link
      // that was fine either side of it. A stall counts as wasted for the same
      // reason: we aborted it, nobody answered.
      const wasted = uploadAttemptWasted({
        responded: (err as UploadError)?.responded,
        stalled,
        socketOpen: connRef.current.status === "open",
      });
      writeOutbox(outboxRef.current.map((x) => x.ackId === e.ackId && x.status === "pending" ? requeue(x, wasted) : x));
    } finally {
      window.clearTimeout(stall);
      // Whatever happened, this upload no longer accounts for bytes in flight —
      // count the remainder so the strip can't sit at 40% forever.
      upBytesRef.current.sent += Math.max(0, meta.size - last);
      inflightRef.current = Math.max(0, inflightRef.current - 1);
      refreshUploadLabel();
      uploadAborts.current.delete(e.ackId);
      uploadsInFlight.current.delete(e.ackId);
      releaseLane(); // the prompt queued behind this image may go now
    }
  }

  /** Swap a predicted inbox path for the one the host actually used — in every
   *  queued message, in the op payloads that carry prompt text, and in the live
   *  compose draft (the path may still be sitting there unsent). */
  function rewriteQueuedPath(from: string, to: string): void {
    writeOutbox(outboxRef.current.map((x) => {
      if (!x.text.includes(from)) return x;
      const text = x.text.split(from).join(to);
      if (x.mode === "op" && x.op) {
        const op = x.op as ClientMessage & { text?: string; prompt?: string };
        const patched = { ...op } as ClientMessage & { text?: string; prompt?: string };
        if (typeof patched.text === "string") patched.text = patched.text.split(from).join(to);
        if (typeof patched.prompt === "string") patched.prompt = patched.prompt.split(from).join(to);
        return { ...x, text, op: patched as ClientMessage };
      }
      return { ...x, text, label: x.mode === "backlog" ? text.slice(0, 40) : x.label };
    }));
    c.setCompose((cur) => (cur.includes(from) ? cur.split(from).join(to) : cur));
  }

  /**
   * Release everything already queued for ONE session, and say so.
   *
   * Ordering makes this necessary: a lane is delivered head-first, so a message
   * you tap Send on right now sits behind anything parked in front of it — and
   * with the queue held (you tapped "Hold" on the reconnect prompt, or auto-send
   * is off) the head never goes, so the send you just made silently goes
   * nowhere. Addressing a session IS the decision to let that session's queue
   * run; other sessions stay held.
   */
  function armLane(sessionId: string): void {
    const parked = outboxRef.current.filter((e) => e.sessionId === sessionId && e.status === "queued" && !e.armed);
    if (!parked.length) return;
    writeOutbox(outboxRef.current.map((e) =>
      e.sessionId === sessionId && e.status === "queued" ? { ...e, armed: true } : e));
    showToast(`sending ${parked.length} earlier queued message${parked.length > 1 ? "s" : ""} first`);
  }

  /** Queue a BACKLOG work item durably. Same store, same receipts as a compose
   *  send — this used to be a bare socket write, which the ws layer drops when
   *  it can't connect, so "queue for this session" typed on a dead tunnel was
   *  simply gone. `sessionId` is the lane (the target session, else the repo),
   *  so several items queued for one session keep the order they were added. */
  function queueBacklog(opts: QueueBacklogOpts) { // the chain's shape is documented on the type
    // null = refused (it names an image that will never arrive); the caller
    // must leave the text where it is rather than reporting a queued item.
    if (!guardUploadRefs(opts.text, opts.targetSessionId ?? opts.repoDir)) return null;
    const ackId = newAckId();
    const offline = connRef.current.status !== "open";
    addOutbox({
      ackId, sessionId: opts.targetSessionId ?? opts.repoDir, cwd: opts.repoDir, text: opts.text,
      ts: Date.now(), status: "queued", attempts: 0, mode: "backlog",
      label: opts.label, fire: opts.fire, autoFire: opts.autoFire, targetSessionId: opts.targetSessionId,
      steps: opts.steps && opts.steps.length > 1 ? opts.steps : undefined,
      resume: opts.resume || undefined,
      closeWhenDone: typeof opts.closeWhenDone === "boolean" ? opts.closeWhenDone : undefined,
      budget: opts.budget,
      offline, armed: !offline,
    });
    if (!offline) armLane(opts.targetSessionId ?? opts.repoDir);
    flushOutbox();
    return offline;
  }

  /**
   * Answer a choice box on screen — through the queue, durably.
   *
   * Three things make the durable version safe:
   *   • The fingerprint. An answer is a KEYSTROKE, not text: "2" means the
   *     option you read only while that exact box is up. The host refuses the
   *     write once the question has changed (`expectPrompt`, promptid.ts) rather
   *     than typing a digit at whatever replaced it.
   *   • It jumps its lane. Anything queued behind it is prose, and prose typed
   *     into a session parked on a dialog goes INTO the dialog. The blocked
   *     session has to be unblocked first — which is also the order the user
   *     wrote them in (they answered the question they could see, then typed).
   *   • `armed`, always. "Send my answer the moment the link is back" is the
   *     entire feature, and the reconnect confirmation exists to ask about
   *     *stale prose*; an answer that went stale is refused host-side instead,
   *     which is a better answer than a dialog nobody is there to tap.
   *
   * No `holdUntilIdle` and no `submit`: a session showing a dialog is mid-turn
   * by definition (waiting for you IS the turn), and a dialog takes raw
   * keystrokes rather than the type-echo-Return composer path.
   */
  function answerPrompt(s: SessionInfo, data: string, label: string, submitBox?: boolean, choice?: number): void {
    const p = s.prompt;
    if (!p) return;
    const offline = connRef.current.status !== "open";
    addOutboxFirstInLane({
      ackId: newAckId(), sessionId: s.id, cwd: s.cwd, text: data,
      ts: Date.now(), status: "queued", attempts: 0, mode: "input",
      answer: { fingerprint: promptFingerprint(p), question: p.question, label, ...(submitBox ? { submitBox: true } : {}), ...(choice != null ? { choice } : {}) },
      // Nothing here is bounded by a clock any more, and an answer is the case
      // that argument was first made for: it is refused host-side once its
      // question is gone, so a late one is either still right or rejected —
      // which makes "the link came back an hour later and the session is still
      // waiting" the case to SERVE, not the case to give up on.
      offline, armed: true,
    });
    // Both cases, not just the offline one. Online there was no pressed state
    // and no sentence — nothing at all until the host echoed a session list
    // without the question on it, which on a slow link is seconds. A tapped
    // option that looks unchanged for two seconds is a dead button.
    showToast(offline
      ? `answer saved — “${label}” goes out when the link is back`
      : `sending “${label}”…`);
    flushOutbox();
  }

  return {
    retainUploadBytes, ackWindowFor, nextRound, armAckTimeout, goneLanes, flushOutbox, idleReason, releaseLane,
    uploadRefusal, guardUploadRefs, guardChain, submitInput, queueOp, queueImageUpload, runUpload, rewriteQueuedPath,
    armLane, queueBacklog, answerPrompt,
  };
}
