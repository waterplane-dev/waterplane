/** Which items a chain may hang off, and what a clock may name. Split from `sendIntent.ts` (docs/notes/send-architecture.md); pure, no React. */
import { nextFireAt, ruleRecurs, type Intent, type WindowResets } from "@waterplane/shared";
import { type SendTarget, type SendWhen } from "./sendTypes.ts";
import { SHEET } from "../sheetNames.ts";

// ── Which items a chain may hang off ─────────────────────────────────────────

/**
 * How long a finished row stays offerable as something to chain behind.
 *
 * Six hours rather than "everything ever": the useful predecessor is one you
 * are looking at, and the store's archive tail holds rows for far longer than
 * anybody means when they say "after that one". A settled row is offered at all
 * because the common case is discovering the dependency a moment too late — the
 * migration finished while you were writing the review prompt — and a chain
 * whose predecessor is already settled is released on the very next tick, which
 * is the honest outcome rather than a refusal.
 */
export const CHAIN_RECENT_MS = 6 * 3600e3;

/**
 * The rows a picker may offer as "after this one".
 *
 * Sorted by what somebody scanning the list is looking for rather than by time:
 * what is running now, then what is waiting, then what has just finished. A
 * flat newest-first order buried the running row — the one a chain is nearly
 * always hung off — under every item queued after it.
 *
 * `selfId` drops the row being EDITED, which is the one cycle this side can see
 * and the one that is pure self-harm: a row waiting for itself settles nothing.
 * Longer cycles are the host's to catch (`facts.chainWaits`), and it fails them
 * with a sentence rather than letting two rows wait politely for each other for
 * ever — this filter is a courtesy, never the guard.
 *
 * **A RECURRING rule is not offered at all**, for a reason no sentence on the
 * row could soften: `facts.settled` is terminal-only by contract and a standing
 * rule never goes terminal — it fires, re-arms and does it again, for ever — so
 * a chain hung off "the nightly sweep" reads *waits for “the nightly sweep” to
 * finish* on every tick until the desktop is switched off. Offering a
 * predecessor that can never release the work is offering a way to lose it.
 * A schedule's individual RUN is a real predecessor and stays offerable: a
 * `backlog` action posts a child work item per occurrence, and that row
 * finishes. The ladder fails one that gets posted anyway
 * (`IntentFacts.neverSettles`) — this filter is a courtesy there too, because a
 * rule can be edited from *once* to *every day* after the chain was made.
 */
/** What the chip beside the picker means, both ways round. The OFF sentence has
 *  to carry an example, because "it runs either way" reads as a limitation
 *  until you see the case it is for. */
export const chainOkWords = (onlyIfOk?: boolean): string =>
  onlyIfOk
    ? "If that item fails, this one fails too and says so — it is never left waiting for something that cannot happen twice."
    : "It runs either way — “run the tests, then tell me what happened” wants to run when they fail. Tick it to run only after a success.";

/** What a chain IS, said once under the picker: no deadline, and not a
 *  schedule. Both halves are things a reader would otherwise have to discover
 *  by looking for the row in the wrong sheet. */
export const CHAIN_NOTE =
  "The desktop holds this, with no deadline: if it was asleep when that item finished, this still goes in when it wakes. "
  + `A chain is not a schedule — it has no clock to arm and appears in ${SHEET.activity} as work, not in ${SHEET.automation}.`;

/** An empty picker, as a SENTENCE. The segment that opens it is never dimmed:
 *  a `title` saying why is invisible on the device this sheet is used from, so
 *  "there is nothing to chain behind" has to be readable on screen. */
export const CHAIN_EMPTY =
  "Nothing to wait for — this desktop is holding no work that is running, queued, or finished in the last few hours.";

export function chainCandidates(intents: readonly Intent[], now: number, selfId?: string): Intent[] {
  const rank = (i: Intent): number =>
    i.state === "running" || i.state === "starting" ? 0
      : i.state === "queued" || i.state === "blocked" ? 1
        : 2;
  const rows = intents.filter((i) => {
    if (selfId && i.id === selfId) return false;
    // Never settles ⇒ never releases ⇒ never offered. `ruleRecurs` is the one
    // reading of recurrence both ends share, so this list and the host's
    // `neverSettles` cannot come to two different conclusions about one row.
    if (i.trigger.kind === "at" && ruleRecurs(i.trigger.rule)) return false;
    if (rank(i) < 2) return true;
    // `canceled` is settled, and a chain behind one is released immediately
    // with `ok: false` — which is a surprising thing to offer, and a completely
    // pointless one to pick. `done` and `failed` are both real answers to "has
    // it finished", and `onlyIfOk` is how the difference is said.
    if (i.state === "canceled") return false;
    return now - (i.settledAt ?? i.createdAt) <= CHAIN_RECENT_MS;
  });
  return rows.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (rank(a) === 2) return (b.settledAt ?? b.createdAt) - (a.settledAt ?? a.createdAt);
    return (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt;
  });
}

// ── A clock may name a session, because the CONVERSATION outlives it ─────────

/**
 * What a clock row aimed at a live session promises.
 *
 * This replaces a re-aim. A wall-clock or usage-window anchor used to refuse a
 * session target ("a session id is per-boot — schedule it against the repo
 * instead"), and the sheet softened that refusal by quietly re-aiming the send
 * at the session's repo and saying so. Both were honest about the id and wrong
 * about the ask: somebody scheduling a reply *to that session* for after the
 * weekly reset got a NEW, empty session in that repo, with none of the work the
 * reply was about in its window — the one outcome they had not asked for.
 *
 * The id is still per-boot. The CONVERSATION is not: the host snapshots it onto
 * the row when it is written (`IntentTarget.resumeConvId`) and reopens exactly
 * that conversation if the process has gone by the time the clock comes round
 * (`reopensConversation`). So the target stands, and this is the sentence that
 * says what will happen to it — in a `form-hint`, because a `title` is
 * invisible on the phone this sheet is used from.
 *
 * Null where the app cannot promise it: a session row carrying no `cwd` has
 * nowhere to reopen the conversation, so the send stays a send into a live
 * session and the ladder's own `sessionGone` wait is what it gets.
 */
export function clockSessionNote(t: SendTarget, w: SendWhen, sessionTitle: string): string | null {
  if (w.kind !== "at" || t.kind !== "session" || !t.cwd) return null;
  return `This goes to ${sessionTitle}. A session lasts as long as its process, so if that one has gone when the clock comes round, the desktop reopens the conversation it was in and sends it there.`;
}

/**
 * When an `at` rule fires next, from the same maths the host ticks on.
 *
 * `resets` is the usage reading this phone already has on screen. Without it a
 * window rule can only ever resolve to `null`, which is the reading the sheet
 * then has to word as "not armed yet" — with it, the common case (the meter
 * has been read) shows the real instant, which is what makes "3h before the
 * weekly window resets" checkable before saving.
 */
export const previewOf = (w: SendWhen, resets?: WindowResets): number | null =>
  w.kind === "at" ? nextFireAt(w.rule, Date.now(), resets) : null;

/**
 * What "one at a time" can actually MEAN here, or null where it means nothing.
 *
 * Two shapes can honour it with the send paths that already exist, and the
 * words differ because the mechanism does:
 *
 *  - **N repos** — the queue can either open a fresh session in each repo at
 *    once (a fan-out), or put the prompt in each repo's backlog, where that
 *    repo's own waiting work is run strictly one item at a time.
 *  - **A new session** — the send queue's `serial` flag: one agent per repo,
 *    so a queue drained on reconnect cannot spend one usage limit N ways,
 *    finish nothing, and edit one worktree from N sessions.
 *
 * Everywhere else it is already decided: a session takes one thing at a time by
 * construction, and a repo's backlog is a queue. A switch offered there would
 * be a control that does nothing, which is worse than a missing one.
 */
export function sequentialMeans(t: SendTarget): { on: string; off: string } | null {
  if (t.kind === "repos") {
    return {
      off: "all at once — a fresh session in each repo",
      on: "one at a time — it waits in each repo's backlog and opens its own session there",
    };
  }
  if (t.kind === "repo") {
    return {
      off: "start it straight away, alongside anything else queued for this repo",
      on: "wait for this repo's other queued sessions to finish first",
    };
  }
  return null;
}

