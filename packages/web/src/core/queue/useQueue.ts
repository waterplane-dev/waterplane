/**
 * The send QUEUE — every compose/slash send, every durable op, every attached
 * file's bytes go through it (see outbox.ts). `queued` off the wire, `pending`
 * awaiting the host's receipt, `failed` given up on → the recovery bar offers
 * a restore.
 *
 * Lifted out of App whole, as a hook, so App's call sites keep their names:
 * `const q = useQueue({...})` and then `q.submitInput(…)`, `q.flushOutbox()`.
 * Three rules survive the move by construction:
 *   • **Ref-authoritative.** `outboxRef` is the truth; `writeOutbox` is the one
 *     writer of it, of localStorage and of the store, in one shot. Never a
 *     functional updater — the flusher runs synchronously right after a send is
 *     queued and must see the new row at once.
 *   • **At-most-once.** `newAckId()` is minted in this folder only
 *     (`queue.test.mjs` counts the sites); a retry re-sends the same ackId.
 *   • **Timers read refs.** The sweep interval, the ack deadlines and the lane
 *     release keep the closure of the render that armed them, exactly as they
 *     did in App — so everything they reach reads a ref.
 *
 * The socket's receipts arrive as methods (`onOpAck`, `onInputAck`, …) so the
 * cases in App's switch are one line each.
 */
import { useEffect, useRef, useState } from "react";
import {
  BRAND, answerInsertAt, busySerialGroups, laneBusy, padMigratedToast, sessionWall, SYNCED_SETTING_KEYS,
  type LaunchIntent, type OpenDelivery, type SendBlockReason, type SerialWatch, type SessionInfo,
} from "@waterplane/shared";
import {
  isCreateOp, loadOutbox, noteDeadUpload, saveOutbox, OUTBOX_CAP, OUTBOX_HARD_MAX, type OutboxEntry,
} from "../../outbox";
import { noteOutstanding, noteSendFailed } from "../../link";
import { reportShellQueueDepth } from "../../shellLink";
import { outstandingSync, subscribeSync } from "../../syncState";
import { showToast } from "../../toast";
import { useLinger } from "../../useLinger";
import { useStore } from "../../sdk/store.ts";
import { useLatest } from "../../sdk/hooks.ts";
import { prefRef } from "../prefs.ts";
import type { UploadApi } from "../../sdk/types.ts";
import { blockedStore, outboxStore, seedOutbox } from "./store.ts";
import {
  FLUSH_SWEEP_MS, PENDING_PREFIX, QUEUE_BAR_LINGER_MS, isPendingId, laneFor, laneLabelOf, pendingLaneId, serialStates,
  budgetHeldLaneSet, budgetReleased,
} from "./logic.ts";
import { usePendingState, pendingFns } from "./pending.ts";
import { sendFns } from "./send.ts";
import { verbFns } from "./verbs.ts";
import { useUploadState, uploadFns } from "./uploads.ts";
import { wireFns, type WireFns } from "./wire.ts";
import { migrateGiveUps, migratePadRescue } from "./migrate.ts";
import type {
  BudgetState, CoreFns, PendingFns, QueueCtx, QueueDeps, QueueEnv, QueueRefs, SendFns, UploadFns, VerbFns,
} from "./types.ts";
import { SHEET } from "../../sheetNames.ts";

export type { QueueDeps } from "./types.ts";

/** Everything App (and, through `bindCore`, a feature) asks of the queue. */
export interface QueueApi extends CoreFns, SendFns, PendingFns, VerbFns, WireFns {
  /** The queue as of this render. */
  entries: OutboxEntry[];
  /** The host's usage budget and its verdict (`budget.state`); null until said. */
  budget: BudgetState;
  /** Sessions the host is holding until their files land (`launch.list`). */
  launches: LaunchIntent[];
  outboxRef: { readonly current: OutboxEntry[] };
  /** Why each held entry is not sending — the flusher's own verdict. */
  blocked: ReadonlyMap<string, SendBlockReason>;
  /** Set while the reconnect question is pending: unforced flushes refuse it. */
  holdQueueRef: { current: boolean };
  /** Why the last flush sent nothing (`idleReason` reads it). */
  flushIdleReason: { readonly current: string | null };
  /** Offline-typed entries still waiting for the reconnect answer. */
  parkedSends: OutboxEntry[];
  /** The queue bar's linger frame (`QUEUE_BAR_LINGER_MS`). */
  sendSettled: boolean;
  /** The one-line description of a queued entry, as the strip words it. */
  laneLabel(e: OutboxEntry): string;
  // ── the pending session ──
  PENDING_PREFIX: string;
  isPendingId(id: string | null | undefined): boolean;
  pendingLaneId(ackId: string): string;
  laneFor(id: string, cwd: string): string;
  pendingEntry: OutboxEntry | null;
  pendingSession: SessionInfo | null;
  // ── the upload buffer ──
  uploads: UploadApi & UploadFns & {
    parkingRef: { readonly current: number };
    uploadBufRef: QueueCtx["up"]["uploadBufRef"];
    allBufsRef: QueueCtx["up"]["allBufsRef"];
    uploadPending: boolean;
    uploadRowLinger: boolean;
  };
}

export function useQueue(input: QueueDeps): QueueApi {
  seedOutbox(loadOutbox);
  const outbox = useStore(outboxStore);
  const queueBlocked = useStore(blockedStore);
  const { conn, ...given } = input;
  const { status, connRef, reconnectAsk, setReconnectAsk } = conn;
  const { sessions } = given;
  const sessionsRef = useLatest(sessions);
  const activeIdRef = useLatest(given.activeId);
  const confirmQueueRef = prefRef("confirmQueue");
  /**
   * The usage BUDGET and what it currently says — the host's, not this device's
   * (see `shared/budget.ts`). Held in a ref as well as state because the flusher
   * reads it synchronously, on a path that runs right after an ack lands and
   * before React has re-rendered anything (`onBudget` writes both).
   *
   * Null until the host says. A client that has never been told holds nothing
   * back, which is the same fail-open posture the rule itself takes: the
   * daemon's own gate on auto-fire is the one that cannot be skipped.
   */
  const [budget, setBudget] = useState<BudgetState>(null);
  const budgetRef = useRef<BudgetState>(null);
  /** Sessions the HOST is holding until their files land. Host-authoritative
   *  and pushed on every transition — this device may have been asleep when the
   *  gate opened, and the queue row it left behind is not the record any more.
   *  The ref is for the failure paths, which must not close over a stale render. */
  const [launches, setLaunches] = useState<LaunchIntent[]>([]);
  const launchesRef = useLatest(launches);

  // Second-resolution repaint, ONLY while a send is actually on the wire: the
  // queue bar's elapsed counter has to tick, and the outbox state itself only
  // changes on a write, so without this "Sending… 0s" would sit frozen for the
  // whole twenty-second receipt window — the frozen-spinner problem again.
  const [, setSendTick] = useState(0);
  // Also while an entry is counting down a retry backoff — the countdown it
  // renders is a function of the clock, and the outbox only changes on a write.
  const anyPending = outbox.some((e) => e.status === "pending" || (e.status === "queued" && e.retryAt != null));
  useEffect(() => {
    if (!anyPending) return;
    const t = window.setInterval(() => setSendTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [anyPending]);
  // Keep the queue bar up for a beat after the queue empties — see useLinger.
  // Driven by LIVE work only: an entry that already failed is sitting there
  // waiting to be restored or dismissed, and dismissing it is not a delivery —
  // lingering a "sent" frame after that would state the one thing that is untrue.
  const sendSettled = useLinger(outbox.some((e) => e.status !== "failed"), QUEUE_BAR_LINGER_MS);
  // Mirror of `outbox` readable from callbacks that must not close over stale
  // React state (the flusher runs from a socket event and an interval).
  const outboxRef = useRef<OutboxEntry[]>(outbox);
  // Per-send ack timers (ackId → timeout handle), cleared when the ack arrives.
  const ackTimers = useRef<Map<string, number>>(new Map());
  // ackIds of queued IMAGE uploads currently on the wire. Uploads are the one
  // queue mode that doesn't travel over the socket, so they have no `input.ack`
  // and no ack timeout: a photo on a roaming link can legitimately take a
  // minute, and the 6 s receipt deadline would requeue it mid-flight (a second
  // POST of the same bytes). This set is what keeps their lane marked busy, so
  // the prompt naming the image can't overtake it.
  const uploadsInFlight = useRef<Set<string>>(new Set());
  // Abort handles for those same POSTs (ackId → controller). Every attached
  // image now goes out through the queue, so "cancel uploads" has to be able to
  // stop a transfer it no longer owns directly.
  const uploadAborts = useRef<Map<string, AbortController>>(new Map());
  // Lanes whose session is mid-turn right now — only `holdUntilIdle` entries
  // care (see shared/queue.ts). A ref because the flusher runs from socket
  // events and an interval, neither of which can read React state.
  const busyLanesRef = useRef<Set<string>>(new Set());
  // Sessions over their own budget — a ref for the same reason. Recomputed on
  // every session update; a release (over → not over) flushes.
  const budgetHeldLanesRef = useRef<Set<string>>(new Set());
  // Repo directories whose queued work must wait — "one session at a time in
  // this repo" (shared/queue.ts's `serial`). Same reason as `busyLanesRef` for
  // being a ref: the flusher runs from socket events, not from a render.
  const busySerialRef = useRef<Set<string>>(new Set());
  // Serialized opens that have been acked but whose session hasn't reported a
  // turn yet — the one window where a busy repo looks idle. Not persisted: a
  // reload inside the 60 s grace is rare, and everything else about the rule is
  // derived from the live session list, which survives one.
  const serialWatchRef = useRef<SerialWatch[]>([]);
  // Previous turnActive per session, so the flush fires on the true→false EDGE
  // and not on every session.updated a working session emits.
  const prevTurnActive = useRef<Map<string, boolean>>(new Map());
  // Set when the socket came back with offline-queued entries still parked and
  // the confirmation is pending. While it holds, unforced flushes are refused,
  // so the sweep can't sneak the queue out from under the question.
  const holdQueueRef = useRef(false);
  /**
   * Why the last flush sent nothing — written by `flushOutbox`, read by whoever
   * has to explain it (the "Send now" taps, the reconnect prompt).
   *
   * It has to come from the flush itself. Every one of those call sites used to
   * read a zero return as "the link is down" and say so on a screen whose own
   * header said `open · 100.64.0.5` — the queue was in fact held, backing
   * off, or waiting for a session to open, and the phone reported the one thing
   * that was not true while hiding the one thing that was actionable.
   */
  const flushIdleReason = useRef<string | null>(null);
  /**
   * Which rung of the ladder refused each queued entry, by ackId.
   *
   * The flusher already computes this and then throws it away into ONE sentence
   * for the recovery bar. The Activity sheet needs it per row, and it has to be
   * **the flusher's own verdict, not a second reading**: re-deriving "why is
   * this waiting" from the same facts puts a second explanation next to the
   * behaviour it explains, and the two drift the moment one of them is edited.
   * That is the entire class of bug this rework is about.
   *
   * Ref plus mirrored store, for the usual reason: the flusher runs
   * synchronously (often inside another write) and the sheet renders.
   */
  const queueBlockedRef = useRef<ReadonlyMap<string, SendBlockReason>>(new Map());
  const { pendingKept, pendingEntry, pendingSession } = usePendingState(given.activeId, outbox, sessions);
  const up = useUploadState();

  // ── The environment every file of the core reads (`QueueEnv`) ──
  const env = {
    ...given, connRef, status, reconnectAsk, setReconnectAsk, sessionsRef, activeIdRef,
    getActive: () => sessions.find((s) => s.id === given.activeId) ?? pendingSession,
    budgetRef, setBudget, launchesRef, setLaunches,
    serialSessionsRef: prefRef("serialSessions"), confirmQueueRef, autoSendRef: prefRef("autoSend"),
  } satisfies QueueEnv;
  const deps = env;
  // ── …and the context every file adds its functions to (`types.ts`) ──
  // Built in two steps (the files close over `c`), so the partial is typed as
  // what it is until every `Object.assign` below has run.
  const c = {
    ...env,
    outbox, outboxRef, ackTimers, uploadsInFlight, uploadAborts, busyLanesRef, budgetHeldLanesRef, busySerialRef, serialWatchRef,
    holdQueueRef, flushIdleReason, queueBlockedRef, setQueueBlocked: (m: ReadonlyMap<string, SendBlockReason>) => blockedStore.set(m),
    pendingKept, pendingEntry, up,
  } satisfies QueueEnv & QueueRefs as QueueCtx;
  const writeOutbox = (list: OutboxEntry[]) => c.writeOutbox(list);
  const flushOutbox = (armAll?: boolean) => c.flushOutbox(armAll);
  const retainUploadBytes = (e: OutboxEntry, drop?: boolean) => c.retainUploadBytes(e, drop);
  const failPendingCreates = (lane: string, reason: string, createAck?: string) => c.failPendingCreates(lane, reason, createAck);
  const failDependentUploads = (e: OutboxEntry, reason: string) => c.failDependentUploads(e, reason);

  /**
   * Why a `holdUntilIdle` entry cannot be forced out RIGHT NOW — or null when
   * an explicit tap may drop the park and send.
   *
   * "Hold until idle" is one flag over four different facts (`laneBusy`), and
   * only three of them survive a decision made by a person. A turn in flight is
   * the ordinary case: typing into a working session is normal, which is why
   * every un-held entry does exactly that — so "send this one now" must beat the
   * park, the same way it already beats `serial` and the retry backoff. The
   * other three are not a wait, they are a WALL: prose delivered into an open
   * question box goes into the box (it neither runs nor answers), and one
   * delivered into a limit-blocked session is typed at a menu. Those keep the
   * hold and get named instead, because "nothing happened" is the one answer a
   * tap must never give.
   */
  function holdWall(sessionId: string): string | null {
    const s = sessionsRef.current.find((x) => x.id === sessionId);
    if (!s) return null; // no session to be parked against — attempt it and let the ack say why
    // The same three walls `laneBusy`, `sessionBlocker` and `autoFireBlocker`
    // ask about (`shared/queue.ts`'s `sessionWall`) rather than a fourth copy
    // of the ladder. `sessionBusy` is deliberately dropped: a busy TURN is not
    // a wall here — an explicit send types into one, which is the whole point
    // of "send now" beating the park.
    const wall = sessionWall({
      limitBlocked: s.limit?.blocked, awaitingInput: s.awaitingInput, promptKind: s.prompt?.kind,
    });
    if (wall === "limit") return "blocked on a usage limit — it goes out at the reset";
    if (wall === "awaitingAnswer") {
      return s.awaitingInput
        ? "a dialog is open in that session — answer it first"
        : "a question is on screen in that session — answer it first";
    }
    return null;
  }

  /**
   * The ONE writer of the queue: ref, localStorage and the store in one shot.
   *
   * Deliberately NOT a functional `setOutbox(prev => …)` updater. The flusher
   * runs synchronously right after a send is queued, and React had not yet
   * applied a queued updater at that point — so the entry was invisible to it and
   * every message sat idle until the next 5 s sweep. Every mutation therefore
   * derives from `outboxRef.current`, which this keeps current immediately.
   */
  function writeOutboxImpl(list: OutboxEntry[]): OutboxEntry[] {
    saveOutbox(list);
    outboxRef.current = list;
    outboxStore.set(list);
    // Tell the APK's background service how much is still undelivered. It
    // cannot see the queue itself — the rows are in localStorage and their
    // upload bytes in IndexedDB — and this is the one number it is told. It
    // matters for the case the page cannot cover: the app swiped away with
    // prompts still queued, where the count is the difference between "sits
    // there until you next open the app" and "the phone tells you the moment
    // sending would work". Cheap on every write — a no-op in the browser, and
    // reports only CHANGES in the shell (`reportShellQueueDepth`).
    // `failed` is excluded on purpose: those rows are kept for ever and are
    // triaged by hand in Activity, so counting them would leave a permanent
    // "3 waiting" on a phone with nothing left to send.
    reportShellQueueDepth(list.filter((e) => e.status !== "failed").length);
    return list;
  }
  /**
   * Append to the queue, and make room WITHOUT ever silently dropping something
   * that hasn't been delivered.
   *
   * `.slice(-50)` used to be the whole implementation: past the cap the OLDEST
   * entry fell off the front with no status, no reason, and nothing in the
   * recovery bar — i.e. the queue's one job, not losing text, failed quietly and
   * precisely when it was busiest.
   *
   * The cap is now 500 rather than 50, which matters more than it looks. When
   * the ledger existed, an eviction still left a clipped copy of the words
   * behind; there is no ledger, so an eviction here is the one remaining way
   * this app can delete something a person typed. So it may not happen for
   * ordinary reasons — and 47 stuck sends against a cap of 50 is an ordinary
   * afternoon on a bad tunnel.
   *
   * Past the cap the oldest rows are FAILED with a reason rather than removed:
   * the words stay on screen, in Activity, with the button that posts them to
   * the repo they were written for. Nothing is dropped from this array at all.
   */
  function addOutbox(e: OutboxEntry, frontOfLane = false) {
    // `frontOfLane` — answers only, see `addOutboxFirstInLane`. The cap logic
    // below runs either way: an answer is small and rare, but a path into this
    // queue that skips the cap is a path that can grow it without bound.
    const cur = outboxRef.current;
    // `answerInsertAt` (shared/queue.ts) is the rule: ahead of the lane's queued
    // PROSE, behind any answer already waiting there. It lives there rather than
    // here so `e2e-queue.mjs` can pin it — getting it wrong is silent and
    // specific (a checkbox box's toggles delivered in reverse, submitting the
    // wrong set).
    const at = frontOfLane ? answerInsertAt(cur, e.sessionId) : cur.length;
    let list = [...cur.slice(0, at), e, ...cur.slice(at)];
    // Past the cap the oldest live rows are FAILED, not removed: their words
    // stay on screen, in Activity, with the button that posts them to the repo
    // they were written for. Failing is what a bound may cost; deleting is not.
    if (list.length > OUTBOX_CAP) {
      const overflow = list.length - OUTBOX_CAP;
      const victims = new Set(list.filter((x) => x.status !== "failed").slice(0, overflow).map((x) => x.ackId));
      if (victims.size) {
        list = list.map((x) => {
          if (!victims.has(x.ackId)) return x;
          const reason = "queue full — older messages were pushed out";
          noteSendFailed();
          return { ...x, status: "failed" as const, reason, failedAt: Date.now() };
        });
        showToast(`queue full — ${victims.size} older message${victims.size > 1 ? "s" : ""} stopped; their words are in ${SHEET.activity}`);
      }
    }
    // The real ceiling, and the ONLY delete left on this path. See
    // `OUTBOX_HARD_MAX`: past it the localStorage quota is the next thing to
    // give, and a refused write loses the whole queue rather than the oldest
    // few. Said out loud, because it is words going away.
    if (list.length > OUTBOX_HARD_MAX) {
      const dead = list.filter((x) => x.status === "failed");
      const drop = new Set(dead.slice(0, list.length - OUTBOX_HARD_MAX).map((x) => x.ackId));
      if (drop.size) {
        list = list.filter((x) => !drop.has(x.ackId));
        showToast(`${drop.size} of the oldest failed sends had to be dropped — this device is out of room for them`);
      }
    }
    writeOutbox(list);
  }
  /**
   * Queue an entry at the FRONT of its lane rather than the back.
   *
   * Only answers use this, and only because a queued answer and a queued prompt
   * are not the same kind of thing. Everything else in this queue is text, where
   * "second typed, second delivered" is the invariant that keeps a composer from
   * being mangled. An answer is what UNBLOCKS the session the text is waiting
   * for: deliver the prose first and it is typed into the open dialog box, which
   * neither runs it nor answers the question.
   *
   * Entries already `pending` are left where they are — they may be on a live
   * PTY already, and the lane rule holds the answer behind them for one receipt.
   */
  function addOutboxFirstInLane(e: OutboxEntry): void { addOutbox(e, true); }
  /**
   * Give up on an entry: keep the text, stop retrying, offer a restore.
   *
   * `state` is the host's verdict when there was one. It is stored rather than
   * flattened into the reason string because the two ambiguous verdicts
   * (`unconfirmed`, `unsubmitted`) are the rows `settleFailed` can later go and
   * get a real answer for — the ambiguity belongs to a 4-second echo window,
   * not to the world.
   */
  function failOutboxImpl(ackId: string, reason: string, state?: OutboxEntry["failState"]) {
    const cur = outboxRef.current;
    const e = cur.find((x) => x.ackId === ackId && x.status !== "failed");
    if (!e) return;
    noteSendFailed();
    // An ambiguous verdict is a question the HOST is still working on, so it is
    // not announced as a failure: `unconfirmed`/`unsubmitted` mean the text was
    // typed and the screen could not be read back, and the desktop goes on to
    // re-ask its own conversation log and retype a provably-absent prompt up to
    // four times. Saying "not delivered" here was seven seconds after Send.
    const asking = state === "unconfirmed" || state === "unsubmitted";
    // "below" is the recovery bar on the main screen — true there, and a lie
    // anywhere else. In the queue sheet the row IS on screen, in red, right
    // where the reader is already looking.
    showToast(asking
      ? "Typed — the desktop is confirming it ran. It re-sends it itself if it never landed."
      // Worded as something to pick up, not as a casualty report. By the time
      // this fires the words are already safe in the queue and the only open
      // question is what to do with them — and the retry paths never reach here
      // any more: a delivery nobody ANSWERED goes to `nextRound` and keeps
      // going, so what is left is the desktop having answered and said no.
      : deps.overlayRef.current === "queue"
        ? `Not sent — ${reason}. Your words are kept; the row is below.`
        : `Not sent — ${reason}. Your words are kept below — restore or re-aim them.`);
    writeOutbox(cur.map((x) => x.ackId === ackId
      ? { ...x, status: "failed" as const, reason, failState: state ?? "other", failedAt: Date.now() }
      : x));
    // Whatever killed the create — refused, aged out, retries exhausted — the
    // prompts queued behind it in that lane have no session to run in and would
    // hold the lane silently (a `pendingCreate` entry is never picked). Fail
    // them with it so the text is visible and recoverable.
    if (isCreateOp(e)) failPendingCreates(e.sessionId, `the session never opened — ${reason}`, e.ackId);
    if (e.mode === "upload" && e.upload) {
      // The queue can forget this entry (discarded, evicted); the path is
      // already in a draft somewhere, so remember it separately.
      noteDeadUpload(e.upload.relPath, `it never uploaded — ${reason}`);
      /**
       * **Keep the bytes, on the one path that was not keeping them.**
       *
       * Retention was wired to the two ways a person DISCARDS an upload
       * (`dismissOutbox`, `removeQueued`) and not to the way the transport kills
       * one by itself — which is the only way it actually happens on a bad link.
       * So the whole mechanism was armed for the rare case and absent for the
       * common one: `attachState` saw the path in `dead` and not in `kept`, the
       * strip drew "not uploaded" with nothing to press, and the re-attach
       * button — which exists, and works — was unreachable. The bytes were in
       * IndexedDB the entire time, under this row's ackId.
       *
       * Not dropped, because this row can still be revived under the same ackId.
       */
      void retainUploadBytes(e, false);
      failDependentUploads(e, `the image it refers to never uploaded — ${reason}`);
      // A session may be parked on the desktop waiting for exactly these bytes.
      // Its deadline is six hours; this device now KNOWS they are not coming, and
      // leaving the host to find that out by timing out would hold an open the
      // user has already been told died. Cancelling is safe by construction —
      // only a `waiting` launch can be cancelled, so one that opened in the
      // meantime is untouched.
      for (const l of deps.launchesRef.current) {
        if (l.state === "waiting" && l.needs.includes(e.upload.relPath)) {
          connRef.current.send({ t: "launch.cancel", id: l.id });
        }
      }
    }
  }

  // ── What became of a delivery nobody could confirm ─────────────────────
  //
  // This used to be the phone's job and it was the wrong end of the wire. The
  // client asked (`input.settle`), at most three times, over a live socket,
  // from a tab that reloads on the worst link — and the rows it was asking
  // about retired an hour after they failed. So on a good day the machinery
  // worked and on a bad day, which is the day the question gets asked, nothing
  // ever revisited the row. That is how one device accumulated 67 prompts filed
  // as "reached a session but could not be confirmed as running", several of
  // which were running at the time.
  //
  // The HOST holds the question now (`opendeliveries.ts`): it re-asks the CLI's
  // own conversation log on its own sweep whether or not anybody is connected,
  // it re-sends a provably-`absent` prompt exactly once, and it broadcasts the
  // resolution. All that is left here is applying a verdict to the row it
  // names, which is what the ackId on an `OpenDelivery` is for.

  /**
   * One resolved delivery, applied to the queue row it belongs to.
   *
   * `landed` DROPS the row and says so: it ran, the red row was a false alarm
   * from the start, and "did that send?" is the question the row left open.
   * Everything else restates the row with the host's current sentence rather
   * than the one from the moment it failed — and never re-sends, because a
   * re-send is the host's decision, made against the log it owns.
   */
  function applyDeliverySettled(q: OpenDelivery): void {
    if (!q.ackId || q.verdict === "open") return;
    const e = outboxRef.current.find((x) => x.ackId === q.ackId && x.status === "failed");
    if (!e) return;
    if (q.verdict === "landed") {
      writeOutbox(outboxRef.current.filter((x) => x.ackId !== e.ackId));
      showToast(`“${e.text.slice(0, 40)}${e.text.length > 40 ? "…" : ""}” did run after all — cleared from the queue`);
      return;
    }
    // `composer`: typed, sitting one keypress from running. `absent`: it never
    // ran — and if the host re-sent it, its own row says so. `unknown`: the
    // sweep ran out of minutes without ever finding a readable log, which is a
    // different sentence from "never ran" and is the one nothing acts on.
    // The host writes the sentence, including for a row it re-sent: `onAbsent`
    // distinguishes "the session never became ready for the host's re-send"
    // from "re-sent once and still could not confirm it", and both of those are
    // the row's whole point. The `resentAt` branch that used to sit here
    // replaced them with "it never ran, so the desktop sent it again" — which
    // reads as a resolution on a row that is still red and still counted as not
    // delivered, i.e. the one sentence a person cannot act on. A re-send that
    // actually WORKED never reaches this line: it settles `landed` above.
    const reason = q.verdict === "composer"
      ? "still in that session's composer — open it and press Return"
      : q.reason ?? (q.verdict === "absent" ? "checked — it never landed" : "still unreadable — the desktop could not tell");
    // `hostSettled` is what takes the row OUT of "the desktop is still
    // confirming it" (`sendConfirm.ts`) and lets it read as a failure at last.
    // Until this arrives the host has re-sends left to spend, and a red row
    // over an open question is the one thing a person cannot act on safely.
    writeOutbox(outboxRef.current.map((x) => x.ackId === e.ackId ? { ...x, reason, hostSettled: true } : x));
  }

  Object.assign(c, {
    writeOutbox: writeOutboxImpl, addOutbox, addOutboxFirstInLane, failOutbox: failOutboxImpl, applyDeliverySettled, holdWall,
  } satisfies CoreFns);
  Object.assign(c, sendFns(c));
  Object.assign(c, pendingFns(c));
  Object.assign(c, verbFns(c));
  Object.assign(c, uploadFns(c));
  const wire = wireFns(c);

  // ── Effects ─────────────────────────────────────────────────────────────

  // The link is back. Anything typed while it was down goes out now, in order,
  // one message per session — EXCEPT that offline text is stale by definition:
  // it was written against what the session looked like before the tunnel died,
  // and the agent may have finished, asked a question or moved on since. So by
  // default the drain ASKS first (Settings → Install & offline turns it off),
  // and only entries the user already released (`armed`) go out unprompted.
  useEffect(() => {
    if (status !== "open") return;
    const parked = outboxRef.current.filter((e) => e.status === "queued" && e.offline && !e.armed);
    if (confirmQueueRef.current && parked.length > 0) {
      holdQueueRef.current = true;
      setReconnectAsk(true);
      flushOutbox(); // armed/in-flight entries still go; the parked ones wait for the answer
      return;
    }
    // No question to ask ⇒ nothing is being held. Clearing this matters: a hold
    // set by an EARLIER reconnect ("Hold") would otherwise still be in force,
    // and with the confirmation turned off since, nothing would ever release it
    // — the queue would sit there with no prompt and no explanation.
    holdQueueRef.current = false;
    const n = flushOutbox();
    if (n > 0) {
      const total = outboxRef.current.filter((e) => e.status !== "failed").length;
      showToast(total > n ? `sending ${total} queued messages…` : `sent ${n} queued message${n > 1 ? "s" : ""}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the drain runs on a status edge only; every queue fact is read through a ref (the header's "timers read refs")
  }, [status]);
  // The question is answered once nothing it was about is parked any more —
  // released, edited away, or pulled back into a compose box. Recomputed from
  // the queue rather than from a count captured at reconnect, which goes stale
  // the moment anything else releases those entries (sending a new message to
  // the same session does exactly that — see armLane).
  const parkedSends = outbox.filter((e) => e.status === "queued" && e.offline && !e.armed);
  useEffect(() => {
    if (!reconnectAsk || parkedSends.length) return;
    holdQueueRef.current = false;
    setReconnectAsk(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters and `holdQueueRef` are stable
  }, [reconnectAsk, parkedSends.length]);
  // The socket went away with sends still `pending`. Put them back NOW rather
  // than letting each one sit out its receipt deadline: a `submit` window is 90 s
  // (the host legitimately takes that long to type into a booting TUI), and a
  // pending entry HOLDS ITS LANE, so a tunnel that dropped mid-send would park
  // everything queued behind it for a minute and a half — with the link already
  // back. Nothing reached a host that could answer, so the attempt is rolled
  // back too; spending the give-up budget on the network being down is the one
  // thing this queue exists not to do.
  //
  // Safe because the re-send carries the SAME ackId: if the host did receive it
  // and is mid-delivery, the retry joins that delivery (`inputsInFlight`) or is
  // re-acked from the ledger — never typed a second time.
  useEffect(() => {
    if (status === "open") return;
    const stuck = outboxRef.current.filter((e) => e.status === "pending" && e.mode !== "upload");
    if (!stuck.length) return;
    for (const e of stuck) {
      const t = ackTimers.current.get(e.ackId);
      if (t != null) { clearTimeout(t); ackTimers.current.delete(e.ackId); }
    }
    const ids = new Set(stuck.map((e) => e.ackId));
    writeOutbox(outboxRef.current.map((e) => ids.has(e.ackId)
      // Deliberately NO backoff: the socket going away is not this entry
      // failing, and the reconnect flush is the moment it should go out.
      ? { ...e, status: "queued" as const, attempts: Math.max(0, (e.attempts ?? 1) - 1), retryAt: undefined, waitReason: undefined }
      : e));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a status edge only; `writeOutbox` and the timers are ref-backed
  }, [status]);
  // Backstop sweep: catches an entry queued during the handshake, and re-times
  // anything the ack-timeout path put back.
  useEffect(() => {
    const t = window.setInterval(() => { flushOutbox(); }, FLUSH_SWEEP_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only sweep; `flushOutbox` reads the queue through refs
  }, []);
  // WHERE THE SETTLE SWEEP USED TO BE.
  //
  // A one-minute timer that asked the host what became of every failed row, at
  // most three times each, and aged out the rest into the pad. Both halves are
  // gone: the host re-asks its own open deliveries with nobody connected
  // (`opendeliveries.ts`) and pushes `delivery.settled` whenever it lands, and
  // nothing ages out at all. A timer whose whole job was to chase an answer
  // that now arrives by itself is a second, slower opinion about the same fact.

  /**
   * "You still have N messages waiting" — the one thing a queue can't tell you
   * from inside a tab that is no longer on screen.
   *
   * A phone backgrounds this app constantly, and an entry parked behind the
   * reconnect confirmation (or with auto-send off) waits for a tap that will
   * never come if you forgot. So on hide, IF anything is still queued and
   * notification permission is already granted, the service worker shows one
   * notification with a STABLE tag — re-showing it replaces rather than stacks,
   * so backgrounding ten times leaves one. It is closed again when the page
   * comes back or the queue drains, so a stale count can't linger in the shade.
   *
   * Deliberately not Periodic Background Sync: Chrome-only, requires an
   * installed PWA, and the browser schedules it whenever it likes — which is
   * exactly the wrong shape for "tell me now that I left something behind".
   * Everything here is best-effort and must never throw: no permission, no SW,
   * a non-secure context (plain http over Tailscale) all just mean no notice.
   */
  const queuedCount = outbox.filter((e) => e.status === "queued").length;
  const queuedCountRef = useRef(queuedCount);
  queuedCountRef.current = queuedCount;
  useEffect(() => {
    const TAG = "queue";
    const reg = () => navigator.serviceWorker?.getRegistration?.();
    const close = () => {
      try {
        void reg()?.then((r) => r?.getNotifications({ tag: TAG }).then((ns) => ns.forEach((n) => n.close())).catch(() => {}))
          .catch(() => {});
      } catch { /* no SW / no permission API */ }
    };
    const show = () => {
      const n = queuedCountRef.current;
      if (n <= 0) { close(); return; }
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      try {
        void reg()?.then((r) => r?.showNotification("Messages still queued", {
          body: `${n} message${n > 1 ? "s" : ""} waiting to go out. Open ${BRAND.name} to send ${n > 1 ? "them" : "it"}.`,
          tag: TAG,
          silent: true, // a reminder, not an alert — it must not buzz the phone
        } as NotificationOptions)).catch(() => {});
      } catch { /* best effort */ }
    };
    const onHide = () => { if (document.visibilityState === "hidden") show(); else close(); };
    window.addEventListener("pagehide", show);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", show);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);
  // Queue drained while the page is open ⇒ drop any notice left from a previous
  // background, so the shade never shows a count that is no longer true.
  useEffect(() => {
    if (queuedCount > 0) return;
    try {
      void navigator.serviceWorker?.getRegistration?.()
        ?.then((r) => r?.getNotifications({ tag: "queue" }).then((ns) => ns.forEach((n) => n.close())).catch(() => {}))
        .catch(() => {});
    } catch { /* best effort */ }
  }, [queuedCount]);
  // "Send it when the agent is done" — the busy set the scheduler consults, plus
  // the release trigger. `turnActive` is exact on a `hooked` session
  // (UserPromptSubmit → Stop) and the silence guess otherwise; the UI says so
  // rather than promising precision it can't have.
  //
  // Busy is `laneBusy()` (shared/queue.ts), not `turnActive` alone: a session
  // parked on a question, on an unparsable dialog, or blocked on a usage limit is
  // quiet and CANNOT take a prompt — text delivered into it is typed at the
  // dialog. On a hooked session the turn stays active while a box is up, so the
  // hold held; on a non-hooked one `turnActive` is the silence guess and a
  // session waiting for an answer is perfectly silent, which is how a held
  // "run the tests" ended up typed into a Yes/No box. Same three facts the host
  // gates backlog auto-fire on (`sessions.autoFireBlocker`).
  //
  // Flushing on the busy→FREE edge only. A working session emits many
  // session.updated frames, and flushing on each would be a flush-storm that
  // buys nothing: the parked entry is not eligible until the lane actually frees.
  useEffect(() => {
    const busyNow = (s: SessionInfo) => laneBusy({
      turnActive: s.turnActive,
      limitBlocked: s.limit?.blocked,
      promptKind: s.prompt?.kind,
      awaitingInput: s.awaitingInput,
    });
    busyLanesRef.current = new Set(sessions.filter(busyNow).map((s) => s.id));
    // The session's own budget: held lanes now, and whether any lane was
    // released since the last pass (the over → ok edge flushes, like busy → free).
    const heldNow = budgetHeldLaneSet(sessions);
    const released = budgetReleased(budgetHeldLanesRef.current, heldNow);
    budgetHeldLanesRef.current = heldNow;
    // …and the same three facts, folded up to the REPO: "one session at a time
    // in this directory". `busySerialGroups` also carries the watches, which is
    // the only part the live session list cannot answer — a session that has
    // just been created has run no turn yet, so the repo reads idle for the few
    // seconds it takes the CLI to come up and be typed into.
    {
      const g = busySerialGroups(serialStates(sessions), serialWatchRef.current, Date.now());
      busySerialRef.current = g.busy;
      serialWatchRef.current = g.watches;
    }
    let finished = false;
    const prev = prevTurnActive.current;
    for (const s of sessions) {
      const busy = busyNow(s);
      if (prev.get(s.id) && !busy) finished = true;
      prev.set(s.id, busy);
    }
    // Forget sessions that are gone, so the map can't grow for the tab's lifetime.
    const live = new Set(sessions.map((s) => s.id));
    for (const id of prev.keys()) if (!live.has(id)) prev.delete(id);
    if (finished || released) flushOutbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a session-list change only; `flushOutbox` and the lane sets are refs
  }, [sessions]);
  /**
   * The strip's other half of the same question: how much this phone is still
   * holding that the desktop has not got.
   *
   * Two stores, one number, because a person putting the phone down does not
   * distinguish them — the durable send queue (prompts, schedules, work items,
   * uploads) and `settings.ts`'s pushes (the pad, templates, presets, every
   * synced preference). Counting only one of them would make the all-clear a
   * lie about the other, and the pad is the store whose whole point is that it
   * holds words nobody has decided about yet.
   *
   * `failed` rows are excluded and counted next door instead: they are not
   * outstanding, they are over, and the red slot is where an action lives.
   *
   * `syncTick` exists because the settings half is a plain store with its own
   * subscription, not React state. Coarse on purpose — it emits on any key,
   * this recomputes one integer, and `noteOutstanding` drops a repeat.
   */
  const [syncTick, setSyncTick] = useState(0);
  useEffect(() => subscribeSync(() => setSyncTick((n) => n + 1)), []);
  useEffect(() => {
    const inFlight = outbox.filter((e) => e.status === "queued" || e.status === "pending").length;
    noteOutstanding(inFlight + outstandingSync(SYNCED_SETTING_KEYS));
  }, [outbox, syncTick]);

  // Mount — LAST of the queue's effects, as it was in App (below the `[status]`
  // pair): on a reload with a row `pending` and the socket still connecting,
  // the stuck-requeue effect above must see it first so the wasted attempt is
  // ROLLED BACK; requeued here it would spend one of `MAX_SEND_ATTEMPTS`.
  // An entry the previous tab left `pending` was written to a socket we
  // no longer have, so its receipt can never arrive. It is NOT lost — put it
  // back in the queue and let the flusher re-send it (the host de-dupes on
  // ackId, so a re-send that already landed is re-ACKed, not retyped). Before
  // the ledger existed this had to be surfaced as `failed` and re-typed by hand.
  useEffect(() => {
    let next = outboxRef.current.map((e) => e.status === "pending" ? { ...e, status: "queued" as const, retryAt: undefined, waitReason: undefined } : e);
    // An ORPHANED chained prompt: it waits for a `session.create` that is no
    // longer in the queue (the cap evicts oldest-first, and the create is the
    // oldest entry in its own lane). Nothing will ever bind it and it holds its
    // lane, so surface it as failed — the text is kept and can be re-aimed.
    // Keyed by the create's ackId as well as its lane: the lane is per repo and
    // may still hold ANOTHER create, which is not the one this prompt was
    // written for and must not adopt it.
    const createLanes = new Set(next.filter(isCreateOp).map((e) => e.sessionId));
    const createAcks = new Set(next.filter(isCreateOp).map((e) => e.ackId));
    const orphaned = (e: OutboxEntry) =>
      e.pendingCreate && (e.createAck ? !createAcks.has(e.createAck) : !createLanes.has(e.sessionId));
    next = next.map((e) => {
      if (!orphaned(e)) return e;
      const reason = "the session it was queued for is gone";
      noteSendFailed();
      return { ...e, pendingCreate: undefined, status: "failed" as const, reason, failedAt: Date.now() };
    });
    writeOutbox(migrateGiveUps(next));
    const back = migratePadRescue();
    if (back) showToast(padMigratedToast(back));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only recovery of the previous tab's rows, read off `outboxRef`
  }, []);

  const fns = c;
  const pick = <K extends keyof QueueCtx>(...keys: K[]) => Object.fromEntries(keys.map((k) => [k, fns[k]])) as Pick<QueueCtx, K>;
  return {
    ...pick("writeOutbox", "addOutbox", "addOutboxFirstInLane", "failOutbox", "applyDeliverySettled", "holdWall"),
    ...pick("retainUploadBytes", "ackWindowFor", "nextRound", "armAckTimeout", "goneLanes", "flushOutbox", "idleReason",
      "releaseLane", "uploadRefusal", "guardUploadRefs", "guardChain", "submitInput", "queueOp", "queueImageUpload",
      "runUpload", "rewriteQueuedPath", "armLane", "queueBacklog", "answerPrompt"),
    ...pick("enterPending", "enterOldestPending", "enterLater", "retryPendingCreate", "adoptPendingSession", "queueSessionPrompt",
      "holdForLaunch", "failPendingCreates", "failDependentUploads"),
    ...pick("restoreOutbox", "dismissOutbox", "editQueued", "retargetQueued", "handToDesktop", "toggleHoldQueued",
      "toggleSerialQueued", "scheduleQueueRows", "dropScheduleQueue", "removeQueued", "addPromptToQueuedCreate",
      "moveQueued", "sendQueuedNow", "retryFailedQueued", "restoreQueued", "repoIdOfEntry"),
    ...wire,
    entries: outbox, outboxRef, blocked: queueBlocked, holdQueueRef, flushIdleReason, parkedSends, sendSettled,
    budget, launches,
    laneLabel: (e: OutboxEntry) => laneLabelOf(e, sessions),
    PENDING_PREFIX, isPendingId, pendingLaneId, laneFor, pendingEntry, pendingSession,
    uploads: {
      uploading: up.uploading, parking: up.parking, upProg: up.upProg, current: () => up.uploadBufRef.current,
      ensureUploadBuf: fns.ensureUploadBuf, queueUpload: fns.queueUpload, settleUploads: fns.settleUploads,
      cancelUploads: fns.cancelUploads,
      parkingRef: up.parkingRef, uploadBufRef: up.uploadBufRef, allBufsRef: up.allBufsRef,
      uploadPending: up.uploadPending, uploadRowLinger: up.uploadRowLinger,
    },
  };
}
