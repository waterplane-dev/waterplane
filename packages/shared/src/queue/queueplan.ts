// Cut from queue.ts (move only): selectSendable and its plan types
// The one door stays `./queue.js`; this slice imports its siblings directly, never the barrel.

import type { SendQueueEntry } from "./queueentry.js";

export interface SelectSendableOpts {
  now: number;
  /** ackIds already written to the socket and awaiting a receipt. */
  inflight?: Iterable<string>;
  /** Give up after this many delivery attempts. */
  maxAttempts: number;
  /**
   * …but never before the entry has been trying for this long (`MIN_TRY_MS`).
   * A floor, not a deadline: it can only KEEP an entry in the queue, never
   * remove one. Omitted (or 0) leaves the attempts cap standing alone, which is
   * what the pure-count tests pin.
   */
  minTryMs?: number;
  /**
   * Lane keys whose session is mid-turn right now (the caller derives it from
   * whatever "working" signal it has — `SessionInfo.turnActive`). Only
   * `holdUntilIdle` entries care; everything else sends into a busy session
   * exactly as before, because typing while the agent works is normal.
   *
   * Data in, data out: no SessionInfo is imported here, so `shared/dist` stays
   * node-runnable and the rules stay testable without a host.
   */
  busyLanes?: Iterable<string>;
  /**
   * Serialization groups whose previous member is still RUNNING — the answer to
   * "has the session the last queued open started actually finished?".
   *
   * Deliberately not derived here: it is a fact about live sessions, and this
   * module stays DOM-free and SessionInfo-free so `shared/dist` runs under node.
   * `busySerialGroups()` below computes it from primitives; the caller feeds the
   * result back in.
   */
  busySerial?: Iterable<string>;
  /**
   * The USAGE BUDGET says no: the account is past the ceiling the user set, and
   * automatic work is paused until the window resets (`shared/budget.ts`).
   *
   * A boolean, not the verdict, for the same reason `busySerial` is a set of
   * strings — this module decides what may go on the wire and knows nothing
   * about percentages. The caller asks the rule and feeds the answer in.
   *
   * Three kinds of entry are exempt, and each exemption is the point of the
   * budget rather than a hole in it:
   *
   *   • `armed` — an explicit "send this now". The budget stops work nobody is
   *     watching; a person holding the phone deciding to spend the last 8% is
   *     precisely who the reserve was kept for.
   *   • an ANSWER — it does not start a turn, it unblocks one that is already
   *     parked on a question, and it is worthless once that box is gone.
   *   • an UPLOAD — bytes cost no tokens, and the files arriving during the
   *     pause is what lets the work start the moment the window resets.
   */
  budgetBlocked?: boolean;
  /**
   * Lanes (session ids) whose OWN budget is spent (`sessionBudgetHeld`). Held
   * with the account budget's three exemptions, for the same reasons: an
   * armed send, an answer and an upload still go.
   */
  budgetHeldLanes?: ReadonlySet<string>;
  /**
   * Lane keys whose SESSION IS GONE — it exited, or it is simply not in the
   * host's session list any more. Read for `input` entries only; see the branch
   * in `selectSendable` for why the other three modes are exempt.
   *
   * Computed by the caller for the same reason `busyLanes` and `busySerial` are:
   * it is a fact about live sessions, and this module stays SessionInfo-free so
   * `shared/dist` runs under node. The caller must only fill it from a session
   * list it can trust (one that landed on the CURRENT connection) — an empty
   * set is the safe answer, and is what an offline client passes.
   *
   * **Only entries with no `cwd` are held.** The rule used to hold every one of
   * them, because the host's only answer for a dead session was `ok:false,
   * reason:"session not available"` — not retryable — so a lane of five queued
   * prompts became five red rows and five toasts, one fact told five times.
   * That is no longer the host's only answer: given a `cwd` it writes the words
   * to that repo's work items itself and replies `rescued` (`main.ts`'s
   * `deliverInput`), which is durable, happens with nobody watching, and is the
   * same destination the client's own rescue was aiming at.
   *
   * So holding a rescuable entry here is now strictly harmful: it stops the
   * message reaching the one thing that can save it. What is left is the case
   * the host genuinely cannot answer — no `cwd`, so there is no work list to
   * add to and no repo to name — and for that the original argument stands
   * unchanged.
   */
  goneLanes?: Iterable<string>;
}

/**
 * Why a queued entry did NOT go out on this pass.
 *
 * A code rather than a sentence, so `e2e-queue.mjs` pins the DECISION and the
 * UI owns the wording (`blockedReasonText`).
 */
export type SendBlockReason =
  /** Already on the wire; its receipt hasn't landed yet. */
  | "inflight"
  /** Chained behind a `session.create` — its session does not exist yet. */
  | "pendingCreate"
  /** `holdUntilIdle`, and that lane's agent is mid-turn / parked on a dialog. */
  | "held"
  /** Serialized (`serial`), and the previous member of its group is still working. */
  | "serial"
  /** Backing off after a failed attempt (`retryAt`). */
  | "backoff"
  /** Another entry for the same session is going out first. */
  | "lane"
  /** Past the usage budget — automatic work is paused until the window resets. */
  | "budget"
  /** This session's own budget is spent — its sends wait for it to be raised. */
  | "sessionBudget"
  /** The session this lane names no longer exists. Terminal: nothing but a
   *  re-aim (or a rewrite) will ever get this delivered. */
  | "sessionGone"
  /** The user's own switches (auto-send off / reconnect hold). Not decided here
   *  — `sendEligible` answers it, and the caller appends these. */
  | "gate";

export interface BlockedEntry {
  ackId: string;
  sessionId: string;
  reason: SendBlockReason;
}

export interface SendPlan<T> {
  /** Entries to write now — at most one per session, in queue order. */
  send: T[];
  /**
   * Every queued entry this pass refused to send, with the ladder branch that
   * refused it — in queue order.
   *
   * This exists because `flushOutbox()` returning 0 was being read as "the link
   * is down". It is not: six different things below leave a queued entry where
   * it is with the socket wide open, and the phone reported every one of them as
   * "still offline — staying queued" over a header chip that said `open`. Two
   * flatly contradictory statements about the same instant, and the one the user
   * can act on ("the agent is mid-turn", "it is waiting for its session to
   * open") was the one thrown away.
   *
   * Same rule the backlog's `waiting()` and `pulls.whyIdle()` follow: the reason
   * is emitted BY the ladder that decided, never re-derived by a second reading
   * of the state — a parallel explanation drifts from the behaviour it explains,
   * which is worse than silence.
   */
  blocked: BlockedEntry[];
  /**
   * Entries that ran out of ATTEMPTS — and, with `minTryMs` set, only once they
   * have also been trying for that long.
   *
   * This is the END OF A ROUND, not a death sentence. Nothing here was refused
   * by the host (a refusal is answered on the wire and failed by the caller the
   * moment it lands); what is here is a delivery nobody ever answered, so the
   * caller parks it on a long backoff (`roundDelay`) and it tries the ladder
   * again. Only the caller decides whether a round boundary is ever shown to a
   * person as a failure.
   *
   * There is no AGE clock in this list — nothing here is about how long the
   * words have waited. `maxAttempts` bounds a delivery the host keeps refusing,
   * which is a fact about the request; an attempt made with no socket open is
   * rolled back by the caller, so riding out a week-long outage still costs
   * nothing.
   */
  expire: { ackId: string; reason: string }[];
  /**
   * `holdUntilIdle` entries whose lane JUST went quiet — the park is over. The
   * caller persists `applyRelease()` over its store, which drops the flag so
   * the next pass does not re-report the same release for ever.
   */
  release: T[];
}

/**
 * Decide what may go on the wire right now.
 *
 * Nothing here expires. An entry that cannot go out stays queued and is
 * REPORTED (`blocked`) — the row is the honest place for "this has not reached
 * the desktop", and it costs nothing to keep. The only list that removes an
 * entry is `expire`, and it is spent solely on `maxAttempts`.
 */
export function selectSendable<T extends SendQueueEntry>(
  entries: readonly T[],
  opts: SelectSendableOpts,
): SendPlan<T> {
  const inflight = new Set(opts.inflight ?? []);
  const working = new Set(opts.busyLanes ?? []);
  const serialBusy = new Set(opts.busySerial ?? []);
  const gone = new Set(opts.goneLanes ?? []);
  const send: T[] = [];
  const release: T[] = [];
  const expire: { ackId: string; reason: string }[] = [];
  const blocked: BlockedEntry[] = [];
  const block = (e: T, reason: SendBlockReason) => { blocked.push({ ackId: e.ackId, sessionId: e.sessionId, reason }); };
  // Lanes held by an entry that is already on the wire (a `pending` one whose
  // receipt hasn't landed, or one this pass has just picked).
  const busy = new Set<string>();
  for (const e of entries) {
    if (e.status === "pending" || inflight.has(e.ackId)) {
      busy.add(e.sessionId);
      // …and it holds its serial GROUP too. A create is on the wire for as long
      // as it takes the host to spawn a CLI and type into it; the session it
      // makes does not exist (let alone report a turn) until the ack lands, so
      // without this the very next pass would see a quiet repo and fire the
      // second open into it. The caller's `busySerial` covers the window AFTER
      // the ack; this covers the window before it.
      if (e.serial) serialBusy.add(e.serial);
    }
  }
  for (const e of entries) {
    if (e.status !== "queued") continue;
    if (inflight.has(e.ackId)) { block(e, "inflight"); continue; } // already out; its lane is marked busy
    // Parked until the agent finishes this turn. Two consequences while it
    // waits, both deliberate: the entry HOLDS its lane (anything queued behind
    // it is meant to arrive after it, not overtake it), and it is exempt from
    // the TTL and the attempts cap — waiting for hours is the whole point of the
    // flag, and expiring a deliberate park would silently drop it.
    // Waiting for a session that hasn't been created yet. Never sendable, and
    // it HOLDS the lane so the create ahead of it stays first and anything
    // behind it stays behind. Checked before the park branch on purpose: the
    // lane key is not a session, so `working` can never contain it, and the
    // release path would strip the `holdUntilIdle` flag these entries need for
    // AFTER they are bound.
    if (e.pendingCreate) { busy.add(e.sessionId); block(e, "pendingCreate"); continue; }
    // The session this lane names is gone, so this entry will never be typed
    // into it. Nothing goes out; the row is where the answer lives (re-aim it,
    // rewrite it, drop it) — see `goneLanes`.
    //
    // `input` ONLY, and the exclusions are not tidiness:
    //   • a `backlog` item is added to the REPO, and the host resolves a dead
    //     `targetSessionId` by falling back to that repo's default session
    //     (`resolveTarget`) — holding it here would stop an item that would have
    //     been accepted, which is a worse bug than the one this fixes;
    //   • an `upload` is an HTTP POST to the repo inbox and never touches the
    //     session at all;
    //   • an `op` lane is `create:<cwd>` / `fanout` / `build:<id>`, never a
    //     session id.
    // And for the same reason the lane is NOT marked busy: those modes may still
    // drain past a stranded prompt. Nothing sendable is left behind it — every
    // `input` entry in the lane hits this branch too.
    //
    // AND ONLY WITH NO `cwd`. With one, this entry is precisely what the host's
    // own rescue is for: it is sent, the host finds the session gone, writes the
    // words to that repo's work items and answers `rescued`, and the row is
    // dropped having become durable desktop-side. Holding it here instead is
    // what kept that from ever happening — the rescue was unreachable for the
    // queued-offline case it was written for, leaving only the client's own
    // 45-second grace, which needed a foregrounded tab to tick at all.
    if ((e.mode ?? "input") === "input" && gone.has(e.sessionId) && !e.cwd) {
      block(e, "sessionGone");
      continue;
    }
    if (e.holdUntilIdle && working.has(e.sessionId)) { busy.add(e.sessionId); block(e, "held"); continue; }
    // The two holds that are not about this entry's position in the queue: the
    // ACCOUNT is past the usage ceiling, and this repo already has a serialized
    // send working in it. Both used to be split in two — parked here with the
    // TTL clock stamped forward when never attempted, checked below the clock
    // once the entry had been on the wire — because a wait that legitimately
    // lasts an hour would otherwise expire the whole tail of a queued plan.
    // With no clock there is nothing to split: they are read once, below the
    // attempts check, and the entry simply waits.
    const budgetHeld = !!opts.budgetBlocked && !e.armed && !e.answer && e.mode !== "upload";
    const laneBudgetHeld = !!opts.budgetHeldLanes?.has(e.sessionId) && !e.armed && !e.answer && e.mode !== "upload";
    const serialHeld = !!e.serial && serialBusy.has(e.serial);
    // Backing off after a failed attempt (see `retryAt`). It holds its lane
    // while it waits, for the same reason a `pending` entry does: what is behind
    // it was queued behind it.
    if (e.retryAt != null && e.retryAt > opts.now) {
      busy.add(e.sessionId);
      block(e, "backoff");
      continue;
    }
    // Out of attempts — but only out of TIME as well (`MIN_TRY_MS`). A count of
    // eight can be spent in seconds by a radio dropping receipt windows, and
    // "not delivered" said that fast is a verdict on the link dressed up as a
    // verdict on the message. Under the floor the entry falls through and is
    // attempted again; the backoff above still paces it.
    const tryingFor = e.firstTryAt == null ? Infinity : opts.now - e.firstTryAt;
    if ((e.attempts ?? 0) >= opts.maxAttempts && tryingFor >= (opts.minTryMs ?? 0)) {
      expire.push({ ackId: e.ackId, reason: "delivery kept failing" });
      continue;
    }
    // Past the usage ceiling the account is under, and one at a time in this
    // repo. Both describe something OUTSIDE this entry, so they sit below the
    // attempts check — an entry that has run out of attempts has run out of
    // them whatever the account is doing.
    if (budgetHeld) { busy.add(e.sessionId); block(e, "budget"); continue; }
    if (laneBudgetHeld) { busy.add(e.sessionId); block(e, "sessionBudget"); continue; }
    if (serialHeld) { busy.add(e.sessionId); block(e, "serial"); continue; }
    if (busy.has(e.sessionId)) { block(e, "lane"); continue; } // lane taken — this one waits its turn
    busy.add(e.sessionId);
    // One member of a group per pass, even across lanes: two opens picked in the
    // same flush would start together, which is the entire thing this prevents.
    if (e.serial) serialBusy.add(e.serial);
    // …and the park is OVER, because this pass is SENDING it into the quiet
    // lane it was waiting for. Report it as released; the caller drops the flag
    // (`applyRelease`) so the next pass sees an ordinary queued entry rather
    // than releasing this one again for ever.
    //
    // Released HERE and not above the budget/serial/lane refusals, which is
    // where it used to be: a pass that found the lane quiet and then refused
    // the entry for the account being past its ceiling still dropped the flag,
    // and when the ceiling lifted an hour later the entry was an ordinary send
    // that could be typed into a RUNNING turn. That is the concatenation this
    // flag exists to prevent, on the one job the client-side hold still owns —
    // a chain queued behind a `session.create`, where step 2 must not be typed
    // while step 1's turn is going.
    if (e.holdUntilIdle) release.push(e);
    send.push(e);
  }
  return { send, expire, release, blocked };
}
