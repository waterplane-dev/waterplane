/**
 * The SENTENCES: `intentReasonText` (the one place a block reason becomes
 * words), the block-reason order, the automatic-slot wording, and the
 * ladder's own wordings with `wait` and `chainLoops`. Those last are exported
 * for the sibling slices only; the barrel does not re-export them.
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import type { ScheduleRule } from "../schedule.js";
import { describeHours, hoursZone } from "../schedule.js";
import { SERIAL_WAIT_TEXT } from "../queue.js";
import type { BlockReason } from "./types.js";
import type { IntentSettlement } from "./facts.js";

/** Build a `wait` with its sentence already finished. */
export function wait(reason: BlockReason, detail?: string): { kind: "wait"; reason: BlockReason; detail: string } {
  return { kind: "wait", reason, detail: intentReasonText(reason, detail) };
}

// ── The sentences ────────────────────────────────────────────────────────────

/**
 * The ONE place a block reason becomes a sentence.
 *
 * It replaces four separate wordings that all answered the same question for
 * different surfaces — `blockedReasonText` and `queueIdleReason`
 * (`shared/queue.ts:877, :904`), `BacklogManager.waiting()`'s hand-written
 * lines, and `describeLaunch`. Those were good sentences, and none of their
 * specificity is dropped here: where one of them said something the others did
 * not, that is the version below.
 *
 * `detail` is the caller's more specific sentence for this particular row (the
 * names of the files still uploading, the instant that has not arrived, which
 * of the two "no session" situations this is). When present it IS the answer;
 * the generic line is what a row says when nobody knew any better. Passing a
 * sentence this function already produced is a no-op, so a UI holding only
 * `(blockReason, blockDetail)` can call it again safely.
 */
export function intentReasonText(reason: BlockReason, detail?: string): string {
  const specific = detail?.trim();
  if (specific) return specific;
  switch (reason) {
    case "offline":
      // Deliberately not "still offline — staying queued": that sentence was
      // written when the queue expired things, and the one thing a person needs
      // to know here is that this one does not.
      return "still on this phone — it goes to the desktop the moment the link is back, in full, and nothing expires while it waits";
    case "gate":
      // "auto", not "auto-fire": the switch is labelled *auto* on every surface
      // that draws it, and a sentence naming a control nobody can find is a
      // sentence that sends somebody looking for a second switch.
      return "auto is off — run it by hand, or turn auto on";
    case "budget":
      return "paused — the account is past your usage budget; it resumes when the window resets";
    case "sessionBudget":
      return "held — this session is over its own budget; raise or clear it to let this go";
    case "sessionBusy":
      return "waiting — the session is working";
    case "sessionGone":
      return GONE_SESSION;
    case "awaitingAnswer":
      return "waiting — the session is waiting for an answer";
    case "limit":
      return "the session is blocked on a usage limit — waiting for it to reopen";
    case "filesMissing":
      return "waiting for its files to finish uploading";
    case "notYet":
      return "not due yet";
    case "serial":
      return SERIAL_WAIT_TEXT;
    case "hostBusy":
      return "waiting for the desktop to be free — something else is starting or running";
    case "noSlot":
      // Says OPEN, not busy: an automatic session that is not set to close
      // when done holds its slot until a person closes it, idle or not.
      // No numbers in here, deliberately. The cap and how many of it are in use
      // are the HOST's facts — this module is handed `autoSlotsFree` and never
      // the ceiling it was subtracted from — and a sentence that guessed at
      // "3 at a time" would be wrong on any desktop that set `WATERPLANE_BACKLOG_
      // SESSIONS`. The host fills them in as `detail` ("…this desktop runs 3
      // automatic sessions at a time and 3 are busy"), exactly the arrangement
      // `budgetDetail` has: the specific sentence when somebody knows it, this
      // one when nobody does, and never a plausible number nobody measured.
      return "waiting for a free slot — every automatic session this desktop runs at a time is working";
    case "localModel":
      // The host replaces this with its own numbers (`localSlotWaitText`) or
      // the loading sentence; this is what is true when nobody said which.
      return "waiting for the local model — another local session is working, or the model is still loading";
    // TOTAL on purpose: `reason` arrives on the wire, and a newer host's reason
    // reaches an older bundle that has no case for it — that must still read
    // as a sentence, never `undefined`.
    default:
      return "waiting — the desktop is holding this for a reason this app version cannot name yet";
  }
}

/**
 * Does the session a row opened close itself once the work is done?
 *
 * The row's own `closeWhenDone` when it said one (either way), else the
 * person's global setting (`closeWhenDoneSetting`, off by default). One
 * implementation so the sweep, the reap and the phone's row cannot disagree
 * about the same session. No row at all (a session the sheet's own button
 * opened, or one whose row has been compacted away) is the global answer.
 */
export function closeWhenDoneOf(row: { closeWhenDone?: boolean } | undefined | null, globalDefault: boolean): boolean {
  return typeof row?.closeWhenDone === "boolean" ? row.closeWhenDone : globalDefault;
}

/**
 * The automatic-session cap as FACTS, for the `noSlot` sentence and for the
 * phone's "close one to make room": the ceiling, and every automatic session
 * open right now with whether it is WORKING and whether it will close itself.
 * A fact, never an action — closing one stays a person's tap on the ordinary
 * session close.
 *
 * **Only a working session holds a slot** (R-automation-042). The cap bounds
 * how many agents RUN at once; an idle automatic session left open — the
 * default, close-when-done is off — is a conversation waiting to be read, and
 * it used to hold its slot until a person closed it, so a desktop with three
 * finished items open fired nothing more, timed rows included.
 */
export interface AutoSlotFacts {
  /** `WATERPLANE_BACKLOG_SESSIONS` — how many automatic sessions may WORK at once. */
  max: number;
  /** Every running automatic session (`backlog · …`), oldest first. `busy`
   *  absent is an older host, which counted every open one: read as busy. */
  open: { id: string; closeWhenDone: boolean; busy?: boolean }[];
}

/** The open automatic sessions that hold a slot — the working ones. */
export function autoSlotsBusy(f: AutoSlotFacts): AutoSlotFacts["open"] {
  return f.open.filter((s) => s.busy !== false);
}

/**
 * The `noSlot` wait in the host's own numbers — `undefined` while a slot is
 * free (the cap is not what holds the row, so there is nothing to say).
 *
 * Every session it counts is WORKING, so a slot frees itself when one of them
 * goes idle; closing one by hand is the way to make room sooner, and it stops
 * that session's work.
 */
export function autoSlotsWaitText(f: AutoSlotFacts): string | undefined {
  const busy = autoSlotsBusy(f).length;
  if (busy < f.max) return undefined;
  const sessions = (n: number): string => `${n} automatic session${n === 1 ? "" : "s"}`;
  return `waiting for a free slot — this desktop runs ${sessions(f.max)} at a time and ${busy} ${busy === 1 ? "is" : "are"} working; a slot frees when one goes idle`;
}

/**
 * The local-model cap as FACTS: the ceiling (`null` = no cap) and the local
 * sessions counted as working right now, oldest first.
 */
export interface LocalSlotFacts {
  max: number | null;
  working: { id: string; name?: string }[];
}

/**
 * The `localModel` wait in the host's numbers — `undefined` while a local turn
 * may start (the cap is not what holds the row). One wording for both ends:
 * "waiting for the local model — 1 local session is working".
 */
export function localSlotWaitText(f: LocalSlotFacts): string | undefined {
  const n = f.working.length;
  if (f.max == null || n < f.max) return undefined;
  const lead = `waiting for the local model — ${n} local session${n === 1 ? " is" : "s are"} working`;
  const named = f.working.length === 1 && f.working[0].name ? ` (${f.working[0].name})` : "";
  return `${lead}${named}; this desktop runs ${f.max} at a time`;
}

/**
 * What a person's own start is TOLD when it goes past the cap — never a
 * refusal (nothing refuses; an explicit start beats a hold). `undefined` when
 * the cap is not exceeded. `working` excludes the session being started.
 */
export function localSlotOverText(f: LocalSlotFacts): string | undefined {
  const n = f.working.length;
  if (f.max == null || n < f.max) return undefined;
  const named = n === 1 && f.working[0].name ? ` (${f.working[0].name})` : "";
  return `another local-model session is working${named} — this desktop runs ${f.max} at a time, so they share the local model and turns may be slower`;
}

/**
 * Precedence when several rows are blocked for several reasons and one sentence
 * has to speak for all of them — `queueIdleReason`'s `order`, kept because the
 * argument behind it survives the move.
 *
 * It is ordered by what the user can DO about it, not by ladder position: the
 * gate is one tap away; `budget` is the only reason here that is about the
 * ACCOUNT rather than one row's position, so when it is true it is the answer
 * for every row at once; `sessionGone` sits above the self-resolving waits
 * because it is the only one that never clears on its own.
 */
export const INTENT_BLOCK_ORDER: readonly BlockReason[] = [
  "offline", "gate", "budget", "sessionBudget", "sessionGone", "limit", "awaitingAnswer", "notYet", "filesMissing", "serial", "hostBusy", "localModel", "noSlot", "sessionBusy",
];

/**
 * The "no session" sentences. Kept as constants because the whole point of them
 * is that they are different.
 *
 * There used to be two more. *No backlog session open for this repo* went with
 * the thing it named — every item opens a session of its own, so there is no
 * shared conversation left for a repo to be missing. *Automatic work never
 * types into a session you opened by hand* went with the branch that produced
 * it: `cleanTarget` normalises every repo target to `fresh`, so no row can
 * reach a rung that wants to adopt somebody's open session.
 *
 * They say "this repo's backlog" and not "this repo's work items": a *work
 * item* is the retired name for a row in the shared per-repo conversation, and
 * these two sentences were still offering it, verbatim, on the one screen where
 * a person is being told what to do next.
 */
export const GONE_SESSION = "that session is gone — aim it at another session, or at this repo's backlog";
export const GONE_SESSIONS = "every session this was aimed at is gone — aim it at this repo's backlog instead";
export const BUSY_OTHER_INTENT = "another item is running in that session";

/** File names for a row, never full paths: the row is 40 characters wide and
 *  `.claude/inbox/` is the same on every one of them. */
const baseNames = (paths: readonly string[]): string[] => paths.map((p) => p.split("/").pop() || p);

export function filesWaiting(missing: readonly string[]): string {
  const names = baseNames(missing);
  return names.length === 1
    ? `waiting for ${names[0]} to finish uploading`
    : `waiting for ${names.length} files to finish uploading`;
}

export function filesGaveUp(missing: readonly string[]): string {
  const names = baseNames(missing);
  return names.length === 1
    ? `${names[0]} never arrived — the words are still here; re-attach it and send again`
    : `${names.length} files never arrived (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}) — the words are still here; re-attach and send again`;
}

/**
 * **No wall clock goes into a wire string.**
 *
 * These two sentences are written on the HOST and read on the phone, and
 * `toLocaleString()` answers in the host's locale: a German phone showing
 * "Do., 10. Sept., 21:52" two lines above got "9/10/2026, 9:52:00 PM" inside
 * the sentence underneath, for the same instant. The date is not this
 * function's to format — every surface that shows these already prints the
 * instant itself (`describeRule`, the `next …` chip, `ScheduleResult.
 * occurrence`) in the reader's own locale, from the number.
 *
 * `graceMin` stays: it is a DURATION the person configured, and a count of
 * minutes reads the same everywhere.
 */
export function notYetText(_due: number): string {
  return "not due yet — it fires at the time on this row";
}

/**
 * It claims what the rule KNOWS — the clock — and not what it does not.
 *
 * The old wording was *"the desktop was not running when it was due"*, which is
 * a cause this function cannot see: a row can spend its whole grace ALIVE on
 * the desktop, held below this rung on `serial`, `hostBusy` or `noSlot`, or
 * above it on `budget`, and then miss. The sentence then told a person to go
 * and look at a machine that had been up the entire time, while the real reason
 * was a full desktop or a paused account — both of which the row says elsewhere
 * and neither of which this line may guess at.
 */
export function missedText(_due: number, graceMin: number): string {
  return `missed — more than ${graceMin} min past its time, and it could not start in time`;
}

/**
 * The OTHER miss: an occurrence rung 3 released, held below rung 3 past
 * `HELD_MAX_MS`.
 *
 * Deliberately a different sentence from `missedText`, because it is a
 * different fact and the person can do a different thing about it. `missedText`
 * means *nothing ever cleared it to start*; this means *it was cleared, and then
 * never got a free moment*. Naming the grace alongside the wait is the only way
 * a reader can tell that the 120 minutes they configured is not what binned it.
 *
 * Same rule as `missedText` about what it may claim: the clock, and nothing
 * about the cause. Which rung held it (a busy repo, a full desktop, a paused
 * account, a local model still loading) is said on the row while it waits,
 * by `intentReasonText` — this line must not guess at it hours later.
 */
export function heldOutText(graceMin: number, deadlineMs: number): string {
  const hours = Math.round(deadlineMs / 3_600_000);
  return `missed — it was due and cleared to start, then waited ${hours} h without ever getting a free moment (the grace you set was ${graceMin} min)`;
}

/**
 * Outside the rule's run window.
 *
 * The hours themselves DO go in the string, where `notYetText`'s wall clock
 * deliberately does not, and the difference is whose clock each one is. A due
 * instant is a point in time that every surface already prints in the reader's
 * own locale from the number; a run window is a pair of wall clocks the user
 * typed, in the zone they typed them in, and re-deriving "22:00–07:00" from
 * two integers on the phone would be a second spelling of something
 * `describeRule` already says on the row above. `describeHours` is that one
 * spelling, called from both.
 */
export function outsideHoursText(rule: ScheduleRule): string {
  const hours = describeHours(rule);
  // With the zone, always — `hoursZone` says "host clock" when the rule carries
  // none, which is the reading `inHours` actually uses and the one a person
  // cannot otherwise see. A window with no zone on it moves with the daemon's
  // `TZ`: the same 07:00–22:00 rule was open at 05:30Z on a Tokyo host and shut
  // on a UTC one, and the row said "outside its hours (07:00–22:00)" in both.
  return hours
    ? `outside its hours (${hours}${hoursZone(rule)}) — runs when they open`
    : "outside the hours it may run — runs when they open";
}

/**
 * **Does following this chain come back to where it started?**
 *
 * A bounded walk, not a search: every step is one map lookup, and `seen` makes
 * the walk terminate on the first repeated id whether or not that id is this
 * row's own. That matters — the loop a row is caught in need not contain the
 * row (A waits on B, B waits on C, C waits on B: A never runs either), and a
 * guard that only looked for its own id would report those as ordinary waits
 * for ever.
 *
 * `undefined` edges means the host has not told us who waits for whom, and the
 * answer is then "no evidence of a loop" rather than a guess — except for the
 * one loop that needs no map at all: a row naming ITSELF.
 *
 * **A SETTLED row is a chain END, not a link.** `chainWaits` carries every
 * row's `after` edge, terminal rows included, so a row that has already
 * finished still appears to be waiting on whatever it named when it was posted.
 * Walk through one and a loop that is over — A↔B, B run by hand and done —
 * fails A for ever, although B has settled and A is exactly the row B was
 * supposed to release. Stopping at the first settled id is the same posture the
 * rung takes one line down: a settled predecessor is an answer, never a
 * question. Absent `settled` walks as before.
 */
export function chainLoops(
  id: string,
  waitsOn: string,
  edges: ReadonlyMap<string, string> | undefined,
  settled: ReadonlyMap<string, IntentSettlement> | undefined,
): boolean {
  if (waitsOn === id) return true;
  if (!edges) return false;
  const seen = new Set<string>([id]);
  let cur: string | undefined = waitsOn;
  while (cur) {
    if (seen.has(cur)) return true;
    if (settled?.has(cur)) return false;
    seen.add(cur);
    cur = edges.get(cur);
  }
  return false;
}

/** The seven sentences a chained row can wear. The title is a snapshot taken
 *  when the chain was made (`IntentTrigger.after.title`) — absent, every one of
 *  them still reads, which is the whole reason it is optional. */
export const chainWaitText = (title?: string): string =>
  title ? `waits for “${title}” to finish` : "waits for the item before it to finish";

export const chainGoneText = (title?: string): string =>
  title
    ? `the item this waited for is gone (“${title}”) — nothing is going to release it; give it a time, or chain it to another`
    : "the item this waited for is gone — nothing is going to release it; give it a time, or chain it to another";

export const CHAIN_PREDECESSOR_FAILED =
  "the item it waited for failed, and this one was set to run only if that one succeeded";

export const CHAIN_PREDECESSOR_CANCELED =
  "the item it waited for was called off — nothing is going to release this; give it a time, or chain it to another";

export const CHAIN_LOOP =
  "these items are waiting on each other in a circle, so none of them can ever start — give one of them a time instead";

/** `missedText`'s reasoning, on the chain's clock: what this knows is that the
 *  predecessor finished more than N minutes ago and this never started. WHY it
 *  never started — a busy desktop, a paused account, its own turn in a serial
 *  queue — is not visible from here, and the deadline is wall-clock, so time
 *  spent waiting on the rungs below counts against it. */
export const chainMissedText = (graceMin: number): string =>
  `missed — more than ${graceMin} min since the item it waited for finished, and it could not start in time`;

export const chainSetAsideText = (title?: string): string =>
  (title
    ? `the item this waits for (“${title}”) is archived, so nothing is going to start it`
    : "the item this waits for is archived, so nothing is going to start it")
  + " — bring it back to release this, or give this one a time";

export const chainRecurringText = (title?: string): string =>
  (title
    ? `the item this waited for (“${title}”) is a repeating rule, so it never finishes`
    : "the item this waited for is a repeating rule, so it never finishes")
  + " — nothing is going to release this; give it a time, or chain it to one run of that work";
