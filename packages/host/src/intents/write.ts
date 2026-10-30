/**
 * The store's WRITE verbs: taking a row in (`post`, `upsert`), and every edit a
 * person or a machine makes to one that is not a lifecycle transition —
 * `waive`, `update`, `retarget`, `edit`, `name` — plus `snapshotConv`, the
 * conversation snapshot every aimed write takes.
 *
 * Moved verbatim from `manager.ts` (docs/notes/host-architecture.md, package
 * I3); the facade keeps a one-line delegation for each public verb. Reaches the
 * rest of the manager only through `core` — rows are read through
 * `core.rows()` and replaced through `core.setRows()`, never cached.
 */
import {
  BUDGET_NOT_HOLDING,
  budgetLeftoverOf,
  budgetWaiverPeriod,
  budgetWaiverUntil,
  categoryRefusedText,
  cleanCategory,
  cleanHeadline,
  cleanIntentRow,
  clockKey,
  headlineRefusedText,
  intentPaused,
  isTimedWorkRow,
  ruleRecurs,
  type BudgetWaiver,
  type Intent,
  type IntentDraft,
  type IntentTrigger,
  type IntentPatch,
  type IntentTarget,
  type ItemCategory,
  type ItemName,
  type NameAuthor,
  type SessionBudget,
} from "@waterplane/shared";
import { isTerminal, PENDING_MAX, type IntentCore } from "./contract.js";

/**
 * The pause, carried from the stored row onto a new trigger that is SILENT
 * about it — an edit is a patch, and silence is "unchanged" (bughunt
 * 2026-10-29 BLD-1). No sheet can state the pause (`ScheduleEntry.enabled` is
 * derived on the way out and every sheet sends `true` back), so it is always
 * carried — EXCEPT onto a one-off made out of a standing rule: picking one
 * instant is choosing when it runs, and a paused one-off aimed at one place
 * lands in the backlog, where no pause switch is drawn to undo it.
 *
 * The pause used to be inferred from the stored rule and pinned as
 * `nextAt: null` onto the draft's rule, which on a one-off reads as SPENT: a
 * paused weekly rule re-timed as "once, Friday 18:00" failed on the next tick
 * as "that instant has passed" (review D F1). A carried flag disarms the row
 * in `cleanIntentRow` instead.
 */
export function carryPause(prevRow: Intent | undefined, incoming: IntentTrigger): IntentTrigger {
  const next = withoutPause(incoming);
  const prev = prevRow?.trigger;
  if (next.kind !== "at" || prev?.kind !== "at") return next;
  if (!intentPaused(prevRow!)) return next;
  return ruleRecurs(next.rule) || !ruleRecurs(prev.rule) ? { ...next, paused: true } : next;
}

/**
 * A trigger off a draft or a patch, with the pause taken off. `trigger.paused`
 * is the pause switch's (`setArmed`) and the disk migration's to write, never
 * a draft's: every write path here (`post`, `upsert`, `update`) is reachable
 * from a client (`intent.post`, `intent.update`, `schedule.save`, the agent
 * and peer routes), and a pause carried in on one would switch a rule off with
 * no switch pressed — on a row aimed at one place, with no switch drawn to
 * undo it (bughunt 2026-10-29 review D2). Whether an edit KEEPS the stored
 * pause is `carryPause`'s, from the stored row alone.
 */
export function withoutPause(t: IntentTrigger): IntentTrigger {
  if (t.kind !== "at" || t.paused === undefined) return t;
  const { paused: _paused, ...rest } = t;
  return rest;
}

/**
 * The refusal for a row that could not be written, worded for a person: what
 * failed, in the error's own words, and that nothing was queued — so the words
 * are still theirs to keep. `readOnly()` is asked first because a read-only
 * store writes nothing by design and already has its own sentence.
 */
export function notSavedText(core: Pick<IntentCore, "readOnly" | "lastWriteError">): string {
  return core.readOnly() ?? `could not save to disk: ${core.lastWriteError() ?? "the write failed"} — nothing was queued`;
}

export class WriteSlice {
  constructor(private readonly core: IntentCore) {}

  // ── Writing ───────────────────────────────────────────────────────────────

  /**
   * Take ownership of a piece of work, or hand back the row a replay already
   * made.
   *
   * Synchronous on purpose: the caller acks AFTER this returns, so `ok` on the
   * wire is a statement about the disk. Returning the existing row rather than
   * adding a second one is the at-most-once guard the ack ledger cannot give —
   * its records expire in 45 minutes and a parked launch may wait six hours.
   */
  post(draft: IntentDraft, now = Date.now()): { ok: boolean; intent?: Intent; existing?: boolean; reason?: string } {
    const existing = this.core.rows().find((r) => r.id === (draft.id ?? "").trim());
    if (existing) return { ok: true, intent: existing, existing: true };
    // `ok` is a statement about the disk, and a read-only store has none.
    const ro = this.core.readOnly();
    if (ro) return { ok: false, reason: ro };
    // Every field below is the HOST's to write, and `cleanIntentRow` keeps
    // whatever it is handed — so a draft off the wire must have them stripped
    // here, not merely left undeclared on `IntentDraft`. `wire/intent.ts` says
    // why the DTO is not `Partial<Intent>`: a client that could set `state`
    // could mark work done, one that could set `lastOccurrence` could make a
    // weekly sweep fire twice. `dismissedAt` is the worst of them — it is the
    // gate a terminal row passes before `compact()` may evict it, so a posted
    // row carrying one can fail and be swept out of the live file without ever
    // being seen. `upsert()` has always stripped its three; this is the same
    // rule on the other write path, which had none.
    const row = cleanIntentRow({
      ...draft,
      ...(draft.trigger ? { trigger: withoutPause(draft.trigger) } : {}),
      state: "queued",
      createdAt: now,
      result: undefined,
      sessionId: undefined,
      startedAt: undefined,
      settledAt: undefined,
      dismissedAt: undefined,
      lastOccurrence: undefined,
      nextAt: undefined,
      attempts: undefined,
    }, now);
    if (!row) return { ok: false, reason: "that intent names nothing runnable" };
    if (this.core.pending().length >= PENDING_MAX) {
      // Loud, not quiet. See PENDING_MAX.
      return { ok: false, reason: `this host is already holding ${PENDING_MAX} intents that have not run — clear some before adding more` };
    }
    if (row.trigger.kind === "at") row.nextAt = this.core.armNew(row, now);
    this.snapshotConv(row);
    this.core.rows().push(row);
    // `ok` is a statement about the disk, so a write that did not land is a
    // REFUSAL, and the row comes back out of memory before anything could fire
    // it: nothing has run, only been queued, so refusing is the honest answer —
    // and an `ok` here, written nowhere, is a prompt a restart lets run twice.
    if (!this.core.persist()) {
      this.core.setRows(this.core.rows().filter((r) => r !== row));
      return { ok: false, reason: notSavedText(this.core) };
    }
    // Do not wait for the tick: everything a `now` trigger needs may already be
    // true, and a create that could have been instant must not pay two seconds
    // for the privilege of being durable. It is kicked BEFORE the broadcast so
    // the row's first appearance on a phone already carries its verdict — a
    // list that says "ready" for one frame and "auto-fire is off" for the next
    // is a list that has to be read twice.
    this.core.kick();
    this.core.deps.onChange(row);
    return { ok: true, intent: row };
  }

  /**
   * **Write down WHICH CONVERSATION a session-targeted row is aimed at.**
   *
   * A session id lasts as long as the process. A clock row is written for an
   * instant that may be days out, and until now the phone answered that by
   * REFUSING the combination and re-aiming the row at the repo — so *tell that
   * session this after the reset* became *open a new, empty session in that
   * repo*, and the conversation the words were about was not in the window.
   *
   * The conversation outlives the process, so it is what the row remembers. It
   * is asked HERE, where the session is still live and both facts are known,
   * and never at fire time: by then the answer is gone, and a store that
   * guessed ("the newest conversation in that directory") is the guess
   * `revivedSessionFor` exists to have stopped making.
   *
   * Only ever FILLS: `prev`'s snapshot wins over a fresh lookup for the same
   * session, and a lookup that answers nothing leaves the row exactly as it
   * was. A row that cannot name its conversation keeps every rule it had —
   * `reopensConversation` is false for it, so rung 5 still holds it on
   * `sessionGone` when its session goes.
   */
  private snapshotConv(row: Intent, prev?: Intent): void {
    if (row.target.kind !== "session" || row.target.resumeConvId) return;
    const carried = prev?.target.kind === "session" && prev.target.sessionId === row.target.sessionId
      ? prev.target.resumeConvId
      : undefined;
    const convId = carried ?? this.core.deps.convIdFor?.(row.target.sessionId) ?? undefined;
    if (convId) row.target = { ...row.target, resumeConvId: convId };
  }

  /**
   * Upsert — the schedule adapter's path, where a re-sent edit must overwrite
   * the row rather than add a second copy of "every Thursday". History
   * (`lastOccurrence`, `result`) belongs to the host and is carried over: a
   * client that could clear it could make one sweep fire twice.
   *
   * ── Everything the SHEET has no vocabulary for is carried, not cleared ────
   *
   * This is a rebuild from a DRAFT, and `ScheduleEntry` is a lossy view of an
   * intent: it can say when and what and where, and it cannot say what the row
   * is CALLED, where it sits in a list, whether somebody dragged it there,
   * whether it is set aside, or how many times it has been put back. Every one
   * of those is the host's, and none of them arrives in the draft — so a field
   * left to `...draft` alone is a field this path DELETES.
   *
   * **`revivedShape`'s rule, one path over, and this is the one that bit.** A
   * one-off with a clock is a BACKLOG row (`isTimedWorkRow`), so a person types
   * a title into it in the backlog's own editor — stamped `hand`, the one
   * author no machine may write over — and then changes its time in the send
   * sheet. That goes `schedule.save` → `scheduleToIntent` → here, and before
   * this block the title, the kind and both authors were gone. Worse than gone:
   * the row was then untitled, so the next naming pass wrote machine words into
   * the field a person had typed in, which is the single failure the whole
   * `NameAuthor` apparatus exists to make impossible.
   *
   * Carried PAIRWISE and only when the draft is silent, because a draft that
   * DOES name a title means it (`intent.post` can, and `cleanIntentRow` drops a
   * value whose author is missing either way) — the same shape as every other
   * "the client did not say, so nobody said" field in this file.
   */
  upsert(draft: IntentDraft, now = Date.now()): Intent | null {
    const r = this.upsertResult(draft, now);
    return r.ok ? r.intent : null;
  }

  /** `upsert`, saying WHY when it wrote nothing (`reason` absent ⇒ the draft named nothing runnable). */
  upsertResult(draft: IntentDraft, now = Date.now()): { ok: true; intent: Intent } | { ok: false; reason?: string } {
    // Read-only (a newer host's file): nothing could be saved, so nothing is.
    const ro = this.core.readOnly();
    if (ro) return { ok: false, reason: ro };
    const prev = this.core.rows().find((r) => r.id === (draft.id ?? "").trim());
    // ── The CLOCK's two host facts, carried the same way ────────────────────
    // An edit is a PATCH over the stored row: a draft silent about a field
    // means "unchanged", never "the default". `keepAfterRun` is not a field any
    // sheet's save states (a draft's `undefined` is silence; an explicit
    // `false` is a person clearing it), and the pause (`trigger.paused`, the
    // pause switch's own flag) is not a field a sheet can state at all —
    // `carryPause` says when it rides onto the new rule. Resuming is
    // `setArmed`'s, the pause switch, and nothing else: "nothing applies
    // itself" (bughunt 2026-10-29 BLD-1). A carried pause disarms the row in
    // `cleanIntentRow`; `nextAt: null` is no longer pinned here, because on a
    // one-off it means SPENT (review D F1).
    const kept = draft.trigger?.kind === "at" && draft.trigger.keepAfterRun === undefined
      && prev?.trigger.kind === "at" && prev.trigger.keepAfterRun === true
      ? { ...draft.trigger, keepAfterRun: true }
      : draft.trigger;
    const trigger = kept ? carryPause(prev, kept) : kept;
    const row = cleanIntentRow({
      ...draft,
      trigger,
      state: prev && !isTerminal(prev) ? prev.state : "queued",
      createdAt: prev?.createdAt ?? now,
      lastOccurrence: prev?.lastOccurrence,
      result: prev?.result,
      sessionId: prev?.sessionId,
      ...(draft.headline === undefined
        ? { headline: prev?.headline, headlineBy: prev?.headlineBy }
        : { headline: draft.headline, headlineBy: draft.headlineBy }),
      ...(draft.category === undefined
        ? { category: prev?.category, categoryBy: prev?.categoryBy }
        : { category: draft.category, categoryBy: draft.categoryBy }),
      // The LIST facts, for the same reason and with the same test. `order` and
      // `handOrdered` are where a person put the row — re-saving a time is not
      // a request to un-place it — and `archived` is "I set this aside", which
      // re-timing must not undo. The requeue history is the row's account of
      // itself: `requeueCount` is a NUMBER a screen quotes ("3rd time"), and a
      // cleared one reads as *never put back*, which is a wrong answer rather
      // than an absent one.
      order: draft.order ?? prev?.order,
      // Not on `IntentDraft` at all — a client cannot claim a person placed a
      // row — so it is simply the previous one's or nothing.
      handOrdered: prev?.handOrdered,
      archived: draft.archived ?? prev?.archived,
      requeues: prev?.requeues,
      requeueCount: prev?.requeueCount,
      // A person's waiver: re-timing the row is not a request to hold it for
      // the budget again. Only a host draft (a merge, a child) states it.
      pastBudget: draft.pastBudget ?? prev?.pastBudget,
      // The before-reset lift a rule's child was minted with is the HOST's
      // stamp, and a re-save from the phone never states it — so it is
      // carried, or re-titling a child re-exposes it to the cap it was exempt from.
      budgetPass: draft.budgetPass ?? prev?.budgetPass,
      // The tick's stamp, like `budgetPass`: a re-save never states it.
      leftoverOf: draft.leftoverOf ?? prev?.leftoverOf,
      // A person's answer about the session this row opens. `schedule.save`
      // rebuilds the row from a draft, and a draft that is silent about it
      // (an older bundle, a re-time) must not turn "keep this one open" back
      // into "follow the global".
      closeWhenDone: draft.closeWhenDone ?? prev?.closeWhenDone,
      flagWhenDone: draft.flagWhenDone ?? prev?.flagWhenDone,
      // The budget the session this row opens is born with — the same answer,
      // the same rule: a re-time from a bundle that never heard of it must not
      // delete the cap somebody set. A draft that SAYS `null` is a person
      // clearing it, which only an explicit value can express.
      budget: draft.budget === null ? undefined : draft.budget ?? prev?.budget,
    }, now);
    if (!row) return { ok: false };
    // A draft cannot say which conversation a session is in, so re-saving one
    // would DELETE the snapshot the row was written with — `revivedShape`'s
    // rule, and the whole reason every host-only field above is carried.
    this.snapshotConv(row, prev);
    if (!prev && this.core.pending().length >= PENDING_MAX) {
      return { ok: false, reason: `this host is already holding ${PENDING_MAX} intents that have not run — clear some before adding more` };
    }
    if (row.trigger.kind === "at") {
      row.nextAt = row.nextAt === null ? null
        : row.lastOccurrence != null ? this.core.armFrom(row, row.lastOccurrence, now)
          : this.core.armNew(row, now);
    }
    this.core.setRows(prev ? this.core.rows().map((r) => (r.id === row.id ? row : r)) : [...this.core.rows(), row]);
    // `post()`'s rule: a write that did not land is a refusal, and memory goes
    // back to what the disk still says — the previous row, or no row.
    if (!this.core.persist()) {
      this.core.setRows(prev ? this.core.rows().map((r) => (r === row ? prev : r)) : this.core.rows().filter((r) => r !== row));
      return { ok: false, reason: notSavedText(this.core) };
    }
    this.core.kick();
    this.core.deps.onChange(row);
    return { ok: true, intent: row };
  }

  /**
   * Lift ONE rung for one row — `intent.waive`. Today only the budget: the row
   * gets `pastBudget` and still waits behind `serial`, `holdForHost` and the
   * slots, which is what the re-time sheet's *let past the budget*
   * promises and what sending `intent.run` per row (the old bulk path, into
   * `runNow`, which skips the whole ladder) could not keep.
   *
   * Touches no state, order, clock or `clearedOccurrence`: a waiver is not an
   * edit to the row, so the row keeps its place and its turn. `on: false` is
   * the undo. Refused in words on anything already going, finished or set
   * aside — there is no next start left for the waiver to be about.
   *
   * **Scoped to the window it is granted in** (`BudgetWaiver.until`, the latest
   * reset among the ceilings tripped NOW — `budgetWaiverUntil`). A bare flag
   * lived until the row started, so a one-off for tomorrow waived tonight fired
   * tomorrow past a fresh, unrelated block. Refused when nothing is tripped or
   * no tripped ceiling says when it resets: there is then no window to scope it
   * to, and inventing one would be a guessed number.
   */
  waive(id: string, rung: string, on: boolean): { ok: boolean; reason?: string } {
    const row = this.core.get(id);
    if (!row) return { ok: false, reason: "that intent is gone" };
    if (rung !== "budget") return { ok: false, reason: `only the budget can be lifted this way, not "${String(rung).slice(0, 40)}"` };
    if (this.core.inflight.has(id) || row.state === "starting" || row.state === "running") return { ok: false, reason: "it is already running" };
    if (isTerminal(row)) return { ok: false, reason: `it is already ${row.state}` };
    let next: BudgetWaiver | undefined;
    if (on) {
      if (row.archived) return { ok: false, reason: "it is set aside — put it back on the list first" };
      const now = Date.now();
      // The leftover ceiling holds a row exactly as a tripped cap does, so a
      // person may let a leftover past it — the waiver is then about THIS week.
      const leftover = budgetLeftoverOf(row, now) !== null ? this.core.deps.leftoverOver?.() : null;
      const over = [...(this.core.deps.budgetOver?.() ?? []), ...(leftover ? [leftover] : [])];
      const until = budgetWaiverUntil(over, now);
      if (until == null) {
        return {
          ok: false,
          reason: over.length
            ? "the usage reading does not say when that budget window resets, so there is no window to let it past for"
            : BUDGET_NOT_HOLDING,
        };
      }
      const periodId = budgetWaiverPeriod(over, until);
      next = { until, ...(over.some((c) => c.which === "weekly") ? { weekly: true as const } : {}), ...(periodId ? { periodId } : {}) };
    }
    if (row.pastBudget?.until === next?.until && row.pastBudget?.weekly === next?.weekly && row.pastBudget?.periodId === next?.periodId) return { ok: true };
    row.pastBudget = next;
    this.core.persist();
    this.core.deps.onChange(row);
    this.core.kick();
    return { ok: true };
  }

  /**
   * An edit to work that has not started. Absolute values only — see
   * `IntentPatch`.
   *
   * ── The one carve-out: a FAILED one-off whose clock has passed ────────────
   *
   * `runNow` already has this exception and states its reason: a spent one-off
   * is the one terminal row a person can still MEAN, because the words are
   * sitting there in front of them. The same is true a keystroke earlier —
   * *this missed its time, run it in turn instead* — and that is a patch, not a
   * fire, because what changes is WHEN it waits for, not that it runs now.
   *
   * The gate is deliberately narrow, and each clause earns its place:
   *  - `failed` only. `done` means it ran and `canceled` means somebody called
   *    it off; neither is a row whose words are still owed anything, and
   *    reviving one would re-run work that has already happened.
   *  - `isTimedWorkRow` only. A standing rule has no such state to be rescued
   *    from (it never terminates), and a spent SWEEP is the schedule sheet's,
   *    which has its own verbs for it.
   *  - the patch must CARRY a trigger. A text-only edit of a failed row is
   *    still refused, exactly as before: rewording a gravestone quietly turns
   *    it back into pending work, and nothing on the screen said so. The
   *    trigger is the person saying what it should wait for INSTEAD — which is
   *    what the phone's *drop the clock* sends, as `{trigger: {kind: "idle"}}`.
   *
   * A revival is a `requeue()` that also carries an edit, so it clears the same
   * fields that verb clears: anything less leaves a row that is queued and
   * still says it started, failed, or has been filed away.
   */
  update(id: string, patch: IntentPatch, now = Date.now()): { ok: boolean; reason?: string } {
    const row = this.core.get(id);
    if (!row) return { ok: false, reason: "that intent is gone" };
    if (row.state === "starting" || row.state === "running") return { ok: false, reason: "it is already running — an edit now would describe something that never happened" };
    const reviving = row.state === "failed" && isTimedWorkRow(row) && patch.trigger !== undefined;
    if (isTerminal(row) && !reviving) return { ok: false, reason: `it is already ${row.state}` };
    /**
     * ── The spread below is a DELETE for any key carrying `undefined` ───────
     *
     * `IntentPatch` says *absent leaves the row's own value alone*, and that is
     * true of an absent KEY. A key that is present holding `undefined` is a
     * different thing here: it overwrites the row's value with nothing.
     *
     * Two callers mean exactly that and have no other way to say it —
     * `backlog.update` clears `pinned` to un-queue a row and clears `resume` to
     * start clean after all, both by passing `undefined`. So this is deliberate
     * and must not be filtered out: stripping undefined values here makes those
     * two taps do nothing, which `queuehere.test.mjs` pins.
     *
     * It is also a trap, and it sprang: the same builder emitted `payload`,
     * `label`, `cwd` and `target` unconditionally, so a text-only backlog edit
     * arrived carrying `cwd: undefined`, the row lost its checkout, and
     * `cleanIntentRow` refused the whole edit as *nothing runnable*. Every edit
     * the phone's backlog form could make was dropped except the one that
     * changed the words AND the repo. **A patch is built with conditional
     * spreads and `undefined` is written only where the delete is the point** —
     * `backlog.ts` says which is which, `backlogedit.test.mjs` holds it.
     *
     * Over the wire the question cannot arise: `JSON.stringify` drops an
     * undefined-valued key, so `intent.update` can only ever say "leave it
     * alone". This asymmetry is the in-process caller's to know about.
     */
    const merged = cleanIntentRow({
      ...row,
      ...patch,
      // A new clock is not a resume: the pause rides onto it (or not, onto a
      // one-off) by the same rule as `upsert`. The old clock's armed instant
      // does NOT ride under it: `nextAt` is an answer about the OLD rule, and
      // a spent one-off's `null` under a recurring weekly rule was the older
      // host's pause spelling — the row read as switched off and, queued
      // rather than reviving, was never armed again (review D2 F1). That
      // spelling is now migrated only at disk load (`stampLegacyPause`). Unread ⇒ the arming below computes it from the new rule; a
      // carried pause is disarmed by `cleanIntentRow`.
      ...(patch.trigger ? { trigger: carryPause(row, patch.trigger), nextAt: undefined } : {}),
      state: "queued",
      blockReason: undefined,
      blockDetail: undefined,
      ...(reviving
        ? { attempts: undefined, startedAt: undefined, settledAt: undefined, sessionId: undefined, dismissedAt: undefined }
        : {}),
    }, now);
    if (!merged) return { ok: false, reason: "that edit leaves nothing runnable" };
    // A patch may carry a target (a backlog edit moves a row between sessions
    // and repos), so the conversation snapshot is taken here too — and carried
    // from the row where the aim did not move.
    this.snapshotConv(merged, row);
    // ── A resend of the SAME clock is not a new clock ─────────────────────────
    // The Send sheet's edit of a waiting row always sends the whole trigger,
    // even when only the words changed. Read as "a new instant", that dropped
    // the release rung 3 had given (`clearedOccurrence`) and armed a `once`
    // held past its grace from scratch — to `null`, and the ladder then failed
    // the row as a spent one-off for an edit to its words. Same rule, same
    // grace ⇒ the row keeps its clock state exactly: `nextAt`, `lastOccurrence`
    // and `clearedOccurrence` (the last two are already the row's, via the
    // spread). Not on a revival (a failed row is re-clocked on purpose), and not
    // for a recurring rule sitting at an unflagged `null` — that one falls
    // through to the arming below, which is how it gets armed again.
    const sameClock = !reviving && patch.trigger !== undefined
      && row.trigger.kind === "at" && merged.trigger.kind === "at"
      && clockKey(row.trigger.rule, row.trigger.graceMin) === clockKey(merged.trigger.rule, merged.trigger.graceMin)
      && !(row.nextAt === null && ruleRecurs(merged.trigger.rule));
    if (sameClock) {
      merged.nextAt = row.nextAt;
    } else if (merged.trigger.kind !== "at") {
      // The clock is gone, so everything that was bookkeeping ABOUT that clock
      // goes with it — otherwise the row waits its turn while still carrying a
      // spent occurrence and an armed instant nothing reads. Absent is the
      // honest shape for an untimed row: it is what every item somebody typed
      // into the backlog has.
      //
      // Deliberately NOT gated on `reviving`. It was, and that covered only the
      // failed row being rescued: a row still QUEUED whose clock is dropped
      // took none of these branches and kept all three fields, because the last
      // arm below asks for `trigger.kind === "at"` and by then it is `idle`.
      // The state a row is in is not what decides whether it has a clock — the
      // trigger is. For a row that never had one this clears nothing.
      merged.nextAt = undefined;
      merged.lastOccurrence = undefined;
      merged.clearedOccurrence = undefined;
    } else if (reviving || (patch.trigger?.kind === "at" && !ruleRecurs(patch.trigger.rule))) {
      // Re-clocked rather than un-clocked. Armed from scratch (`armNew`), never
      // from the spent occurrence: the person named a new instant and the old
      // one is not a floor under it. A `once` that is STILL past its grace arms
      // to `null` and the ladder fails it again saying so — honest, and not a
      // loop, because nothing here retries on its own.
      // …and a QUEUED row handed a new one-off instant (the phone's bulk
      // *re-time these N*) is the same case: the person named a new instant.
      // The branch below re-arms only a row that was armed, so one sitting at
      // `nextAt: null` (a window rule with no reading yet) stayed unarmed under
      // its new clock. A recurring rule keeps the branch below — arming it
      // afresh could re-offer an occurrence it has already spent.
      //
      // Its old clock's bookkeeping goes with it, as on the idle branch above:
      // an occurrence of the rule it no longer has is not a floor under the new one.
      if (!reviving) { merged.lastOccurrence = undefined; merged.clearedOccurrence = undefined; }
      merged.nextAt = this.core.armNew(merged, now);
    } else if (merged.trigger.kind === "at" && merged.nextAt !== null) {
      merged.nextAt = this.core.armFrom(merged, merged.lastOccurrence ?? this.core.newBasis(merged), now);
    }
    this.core.replace(merged);
    // ── The one edit that can take a clock away ──────────────────────────────
    //
    // `replace()` announces the ROW, and every list a listener keeps is filtered
    // by something derived from that row — which list it belongs to changes
    // under an edit to the trigger, and a row LEAVING a list is not expressible
    // as a changed row (`server/intentDeps.ts`'s `onChange` says the same thing about its
    // bare form). `schedule.save` always lands on an `at` trigger and is caught
    // there by the "any clocked row goes to both lists" rule; *drop the clock*
    // is the case that rule cannot see, because the row it leaves behind has no
    // clock to test. So say it plainly: the whole store moved.
    if (row.trigger.kind !== merged.trigger.kind) this.core.deps.onChange();
    this.core.kick();
    return { ok: true };
  }

  /** Aim it somewhere else. Its own verb rather than a field of `update`
   *  because it is the recovery move — "that session is gone, send it to the
   *  repo instead" — and a row that has been re-aimed should say so. */
  retarget(id: string, target: IntentTarget, cwd?: string, now = Date.now()): { ok: boolean; reason?: string } {
    const row = this.core.get(id);
    if (!row) return { ok: false, reason: "that intent is gone" };
    if (row.state === "starting" || row.state === "running") return { ok: false, reason: "it is already running" };
    if (isTerminal(row)) return { ok: false, reason: `it is already ${row.state}` };
    // A re-aim ACROSS repos moves both, in one write. `backlog.update` always
    // did — it carried `repoDir` beside the session — and the phone would
    // otherwise have to send this twice, leaving the row momentarily aimed at
    // a session in a checkout it no longer belongs to.
    const merged = cleanIntentRow({ ...row, target, cwd: cwd || row.cwd, state: "queued", blockReason: undefined, blockDetail: undefined, sessionId: undefined }, now);
    if (!merged) return { ok: false, reason: "that target names nothing runnable" };
    // Re-aimed AT a session: the conversation it is in is snapshotted here for
    // the same reason it is on the way in, and `snapshotConv` carries the old
    // one where the aim did not actually move.
    this.snapshotConv(merged, row);
    this.core.replace(merged);
    this.core.kick();
    return { ok: true };
  }

  /**
   * The two changes that are about the LIST rather than the work: where a row
   * sits, and whether it is set aside.
   *
   * Its own verb because `update()` returns a row to `queued` — correct for an
   * edit to the words, wrong for a drag, and actively destructive for setting
   * aside something that already failed. Neither field can make an intent run
   * something different, so neither needs the "not while it is in flight" rule.
   *
   * `headline`/`category` joined it for exactly that property: what a row is
   * CALLED says nothing about whether it runs, so titling a `failed` row must
   * not queue it and titling a `running` one must not be refused. Both are a
   * PERSON's here — see the block below for what `""` means and why.
   *
   * ── Why it answers with a SENTENCE and not a boolean ──────────────────────
   *
   * `ok` was always "is there such a row"; a typed title the cleaner refused
   * returned `true` having written nothing. The phone closed its editor, the
   * row went on showing the old title, and the words somebody had just typed
   * were gone with nothing anywhere saying so. `refused` is what the route
   * toasts. It is not an error — the row is fine, the rest of the patch landed
   * — it is the half that did not, worded once, in `@waterplane/shared`'s
   * `naming.ts`, beside the rule that refuses it.
   */
  edit(id: string, patch: {
    order?: number; archived?: boolean; label?: string; handOrdered?: boolean;
    /** A title a person typed. `""` CLEARS it — see below. */
    headline?: string;
    /** A kind a person chose, one of `ITEM_CATEGORIES`. `""` CLEARS it. */
    category?: ItemCategory | "";
    /** The per-item close-when-done override; `null` CLEARS it back to the
     *  global setting. Any state, a running row included — it is about the
     *  session, not the work, and the session is open right now. */
    closeWhenDone?: boolean | null;
    flagWhenDone?: boolean | null;
    /** The cap the session this row OPENS is born with; `null` CLEARS it. Only a
     *  row that has not started: a started row's session is already born. */
    budget?: SessionBudget | null;
  }): { ok: boolean; refused?: string } {
    const row = this.core.get(id);
    if (!row) return { ok: false };
    if (typeof patch.order === "number" && Number.isFinite(patch.order)) row.order = patch.order;
    // `true` sets, `false` clears, absent says nothing — so a caller changing
    // only `order` cannot silently un-place a row a person dragged there.
    //
    // Nothing in the tree passes `false`. It exists because restoring a merged
    // row's originals has to put back the state each one HAD, and "it was not
    // hand-placed" is a real previous state: an undo that could only ever set
    // the flag would hand rows back marked with a claim nobody made. Machinery
    // never clears this of its own accord — see `Intent.handOrdered`.
    if (typeof patch.handOrdered === "boolean") row.handOrdered = patch.handOrdered ? true : undefined;
    if (typeof patch.archived === "boolean") row.archived = patch.archived || undefined;
    if (typeof patch.label === "string") row.label = patch.label.slice(0, 80) || undefined;
    if (typeof patch.closeWhenDone === "boolean") row.closeWhenDone = patch.closeWhenDone;
    else if (patch.closeWhenDone === null) row.closeWhenDone = undefined;
    if (patch.flagWhenDone === true) row.flagWhenDone = true;
    else if (patch.flagWhenDone === false || patch.flagWhenDone === null) row.flagWhenDone = undefined;

    // ── The name, as a PERSON set it ──────────────────────────────────────
    //
    // A non-empty string is stamped `hand`, which is the one author `name()`
    // below will not write over: that stamp is the whole of "a title you typed
    // is never replaced by a machine", and it is written HERE because this is
    // the only path a person's own words reach the field by.
    //
    // **`""` clears the value AND the author**, together, because the pair is
    // stored together or not at all (`naming.ts`). Absent means NOBODY HAS
    // SAID — which is the shape that lets a later assessment or naming pass
    // title the row again, and that is precisely what clearing a title has to
    // mean. Keeping `headlineBy: "hand"` on an emptied headline would make a
    // row no machine may ever name, for ever, with nothing on any screen
    // saying why it is the only untitled row in the list.
    //
    // A non-empty title the cleaner REFUSES (one that is only the opening
    // words of the prompt underneath it) writes nothing at all and leaves what
    // was there: refusing is not clearing, and a tap that was meant to rename
    // a row must never be the tap that un-names it.
    const rowText = row.payload.kind === "prompt" ? row.payload.steps[0] ?? "" : "";
    const refusals: string[] = [];
    if (typeof patch.headline === "string") {
      if (!patch.headline.trim()) { row.headline = undefined; row.headlineBy = undefined; }
      else {
        const h = cleanHeadline(patch.headline, rowText);
        if (h) { row.headline = h; row.headlineBy = "hand"; }
        else refusals.push(headlineRefusedText(patch.headline));
      }
    }
    if (typeof patch.category === "string") {
      if (!patch.category.trim()) { row.category = undefined; row.categoryBy = undefined; }
      else {
        const c = cleanCategory(patch.category);
        if (c) { row.category = c; row.categoryBy = "hand"; }
        else refusals.push(categoryRefusedText(patch.category));
      }
    }
    // **The session budget of a row still waiting** — `null` clears, an object
    // sets (already cleaned by the caller). A row that has started opened its
    // session with whatever it had: the refusal says so rather than writing a
    // cap onto a session that is already running, or already gone.
    if (patch.budget !== undefined) {
      if (row.state !== "queued" && row.state !== "blocked") refusals.push("its session is already open, so its budget is set on the session");
      else if (patch.budget === null) row.budget = undefined;
      else row.budget = patch.budget;
    }
    // Setting one aside clears the sentence explaining what it was waiting for:
    // it is not waiting for that any more, it is waiting for a person.
    if (row.archived && row.state === "blocked") { row.state = "queued"; row.blockReason = undefined; row.blockDetail = undefined; }
    this.core.persist();
    this.core.deps.onChange(row);
    // Joined with the separator every multi-clause sentence in this app uses,
    // so a patch that got both halves wrong reads as two facts rather than two
    // toasts racing each other.
    return { ok: true, ...(refusals.length ? { refused: refusals.join(" · ") } : {}) };
  }

  /**
   * What a MACHINE says this row should be called — and only where a person has
   * not already said.
   *
   * Its own verb rather than two more fields on `edit()`, because the rule is
   * the opposite one: `edit()` writes whatever it is given and stamps `hand`,
   * while everything here is conditional on `*By !== "hand"`. One function that
   * sometimes overwrites and sometimes refuses, switched by an argument, is one
   * function a caller will one day pass the wrong argument to — and the cost of
   * that mistake is a title somebody typed replaced by one nobody read, which is
   * the single failure `naming.ts` exists to prevent.
   *
   * **The two halves are decided SEPARATELY.** A row whose title a person typed
   * and whose kind nobody ever set is the ordinary case, and a rule that refused
   * the whole row on one `hand` field would leave that kind unset for ever while
   * reporting the row as named.
   *
   * Returns what was ACTUALLY written, per half — never what was asked for. The
   * caller counts a row as named on that, so a pass whose every suggestion was
   * refused reports writing nothing rather than reporting a number that means
   * "we had opinions". `assess.ts` and `naming.ts` both read it that way.
   *
   * `by` is the two machine authors and not `hand`: nothing here may claim a
   * person typed something. Persists and announces exactly as `edit()` does —
   * a title is a LIST fact, so nothing about the row's lifecycle moves.
   */
  name(id: string, n: ItemName, by: Exclude<NameAuthor, "hand">): { headline: boolean; category: boolean } {
    const none = { headline: false, category: false };
    const row = this.core.get(id);
    if (!row) return none;
    const rowText = row.payload.kind === "prompt" ? row.payload.steps[0] ?? "" : "";
    const out = { headline: false, category: false };

    if (n.headline !== undefined && row.headlineBy !== "hand") {
      // Cleaned HERE as well as wherever the document was parsed: this verb is
      // reachable from two callers and a title that is only the prompt's first
      // words is the one shape neither of them may write.
      const h = cleanHeadline(n.headline, rowText);
      if (h) { row.headline = h; row.headlineBy = by; out.headline = true; }
    }
    if (n.category !== undefined && row.categoryBy !== "hand") {
      const c = cleanCategory(n.category);
      if (c) { row.category = c; row.categoryBy = by; out.category = true; }
    }

    if (!out.headline && !out.category) return none;
    this.core.persist();
    this.core.deps.onChange(row);
    return out;
  }
}
