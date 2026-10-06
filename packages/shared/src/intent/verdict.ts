/**
 * `intentVerdict` — the ONE ladder deciding whether deferred work may run.
 * Its order is the specification; read its comment before moving a rung.
 *
 * A slice of `../intent.ts`, which is the one door into the intent model —
 * import from there, never from here. Layout and import order:
 * docs/notes/shared-architecture.md.
 */

import { hoursOpenFrom, inHours, nextFireAt, ruleRecurs } from "../schedule.js";
import { serialGroup, serialLead, serialWaitText } from "../queue.js";
import type { Intent } from "./row.js";
import { HELD_MAX_MS, ON_TIME_MS } from "./row.js";
import type { IntentFacts, IntentVerdict } from "./facts.js";
import { CHAIN_LOOP, CHAIN_PREDECESSOR_CANCELED, CHAIN_PREDECESSOR_FAILED, chainGoneText, chainLoops, chainMissedText, chainRecurringText, chainSetAsideText, chainWaitText, filesGaveUp, filesWaiting, heldOutText, missedText, notYetText, outsideHoursText, wait } from "./words.js";
import { budgetHold, budgetWaived } from "./budgetpass.js";
import { MANUAL_HOLD_TEXT } from "./kind.js";
import { needsSlot, targetVerdict } from "./target.js";

// ── The verdict ──────────────────────────────────────────────────────────────

/**
 * May this intent run right now? Facts in, verdict out.
 *
 * ── The ladder, and why the ORDER is the specification ─────────────────────
 *
 * This is `BacklogManager.waiting()`'s ladder (`host/backlog.ts:262`), which is
 * itself `tick()`'s eligibility ladder, in the same order and largely in the
 * same words. That is not a coincidence to be tidied away: an explanation
 * derived from a second, parallel reading of the state drifts from the
 * behaviour it describes, and an explanation that disagrees with the behaviour
 * is worse than no explanation at all. The two were kept as one function there;
 * here they are one function for every subsystem at once.
 *
 * The order is by what the user can DO about it, and by how much of the rest it
 * makes moot:
 *
 *   1. gate      — a switch. One tap, and it is the answer for every row.
 *   2. budget    — the ACCOUNT, unless a person let the row past it
 *                  (`pastBudget`, one start long, inside the window it was
 *                  granted in). Above every per-item and per-session condition,
 *                  because if the account is over the ceiling then nothing is
 *                  going to fire and saying so once is the honest answer for all
 *                  of them (`backlog.ts:112`). One more lift: a row timed
 *                  BEFORE a reset (`budgetPassOf`) runs past that SAME
 *                  window's ceiling between its own time and the reset —
 *                  a ceiling saves allowance for later in the window, and
 *                  such a row has no later. A before-WEEKLY row is lifted
 *                  past the session cap too (nothing later in that week
 *                  either); a before-session row never past the weekly one.
 *                  Never before its time, never past the reset.
 *   3. trigger   — whether this intent is even due. Everything below describes a
 *                  run that is not going to be attempted at all.
 *   4. serial    — the repo is taken.
 *   5. readiness — the target session itself.
 *
 * A row that is simultaneously gated, budget-blocked and session-busy reports
 * the GATE, because that is the one the user can flip and the other two are
 * unknowable until they do.
 */
export function intentVerdict(i: Intent, facts: IntentFacts, now: number): IntentVerdict {
  // ── 1. gate ──────────────────────────────────────────────────────────────
  // Set aside by hand. Above everything, because it is the one state whose
  // whole meaning is "not now, and I know why" — reporting the session it is
  // not waiting for would be noise.
  if (i.archived) return wait("gate", "set aside — bring it back to let it run");
  // Waits for a tap by construction (an agent's backlog add). Beside `archived`
  // and for its reason: "not by itself, and I know why" is above every rung.
  if (i.manual) return wait("gate", MANUAL_HOLD_TEXT);
  // Automatic work while the switch is off. A hand-posted intent is exempt: the
  // switch routes machinery, it was never a statement about a person's own tap.
  // `pinned` is the same exemption for work a person aimed at one session
  // themselves ("queue for this session") — that tap is not machinery either.
  if (i.auto && !i.pinned && !facts.autoFire) return wait("gate");
  // A recurring rule that has been switched off. `nextAt === null` is the
  // explicit "nothing is armed" — distinct from `undefined`, which only means
  // the manager has not computed one yet.
  // …except a `window` rule, whose unarmed state means "no reading yet" and is
  // answered in the trigger rung below, and except a ONE-SHOT `weekly` rule
  // (`oneShot: true`), whose `nextAt === null` after it fires means "spent",
  // not "paused" — `ruleRecurs` is what tells the two apart; the pause switch
  // itself is never offered to a one-shot row (`ScheduleSheet`'s `repeats`),
  // so a rule reaching here with `nextAt === null` and no recurrence left is
  // spent, and rung 3 below is what says so.
  if (i.trigger.kind === "at" && i.nextAt === null && i.trigger.rule.kind === "weekly" && ruleRecurs(i.trigger.rule)) {
    return wait("gate", "this schedule is switched off — turn it back on and the next occurrence arms itself");
  }

  // ── 2. budget ────────────────────────────────────────────────────────────
  // `budgetHold` is the ONE answer to "is this row let past the budget now":
  // a person's waiver inside its window (`pastBudget`), or a row timed BEFORE
  // a reset, past that same window's ceiling between its time and the reset
  // (`budgetPassOf`). `null` is the lift, and it lifts THIS rung and nothing
  // below it — never the repo, the host or the slots.
  if (facts.budgetBlocked && i.auto) {
    const held = budgetHold(i, facts, now);
    if (held !== null) return wait("budget", held);
  }

  // ── 3. trigger ───────────────────────────────────────────────────────────
  let occurrence: number | undefined;
  let late: boolean | undefined;
  /**
   * The instant rung 3 released, for `Intent.clearedOccurrence`.
   *
   * A SEPARATE variable from `occurrence`, deliberately: `occurrence` is the
   * `at` trigger's bookkeeping and the manager SPENDS it (`lastOccurrence`,
   * `nextAt`), which a chain has no clock for and must never be handed. But a
   * chain is released by rung 3 exactly as an `at` row is, and is held below it
   * by the same rungs — so it needs the same stamp, keyed on the instant its
   * release was measured from (the predecessor's settlement).
   */
  let cleared: number | undefined;
  switch (i.trigger.kind) {
    case "now":
    case "idle":
      // Both fall through to rungs 4 and 5, which is where the waiting actually
      // happens. They are one behaviour on purpose: an intent is DEFERRED work
      // by definition, and deferred work never types into a session that is
      // mid-turn or parked on a question. Typing into a live PTY while the
      // agent works is normal and stays exactly as it is — that is
      // `session.input`, which is not deferred and never becomes an intent.
      break;

    case "budget": {
      // Rung 2 already held every AUTO intent. This arm is what the trigger is
      // for: a person who chose "when the window allows" asked to be held, so
      // the never-budget-hold-a-person exemption does not apply to a wait they
      // picked themselves. Falling through here would make the trigger a no-op
      // for exactly the intents that name it.
      // …unless the same person later let it past (`pastBudget`, inside its
      // window), which is a newer answer to the same question.
      if (facts.budgetBlocked && !budgetWaived(i, now)) return wait("budget", facts.budgetDetail);
      break;
    }

    case "files": {
      const needs = i.trigger.needs;
      const missing = needs.filter((p) => !facts.present.has(p));
      // Presence is checked BEFORE the deadline, and this is load-bearing: a
      // file that lands one second before the deadline opens the session rather
      // than being expired by the very tick that would have opened it. Same
      // rule, same reason, as `launchVerdict`.
      if (!missing.length) break;
      if (now >= i.trigger.deadlineAt) {
        return { kind: "fail", detail: filesGaveUp(missing), missing };
      }
      return { ...wait("filesMissing", filesWaiting(missing)), missing };
    }

    case "at": {
      const t = i.trigger;
      // A `window` rule with nothing armed is WAITING FOR A READING, not
      // switched off. The two are the same `nextAt` on the wire otherwise, and
      // conflating them is the `isSpentOnce` trap from the other side: the row
      // would say "switched off — turn it back on", and the tap would re-arm to
      // the same nothing, because what is missing is a usage scrape and not a
      // decision. It resolves itself the moment `usage.ts` reads a reset.
      //
      // A ONE-SHOT window rule (`oneShot: true`) loses that reading once it has
      // fired — `lastOccurrence` is set, and a null `nextAt` after that means
      // spent, not unread. A recurring rule's null always means unread (never
      // spent, by definition), which keeps its existing "waiting for a
      // reading" reading even while paused — that is a real gap (a paused
      // recurring window rule cannot say "paused" here yet), left alone rather
      // than half-fixed by this change.
      //
      // …and a one-shot that was SKIPPED on its condition is still waiting: the
      // manager keeps it queued with `nextAt` UNDEFINED ("not computed") until
      // the next reset is read. Only an explicit `null` means spent.
      if (t.rule.kind === "window" && i.nextAt == null && (ruleRecurs(t.rule) || i.lastOccurrence == null || i.nextAt === undefined)) {
        return wait("notYet", "waiting for the first usage reading — the reset this tracks has not been read yet");
      }
      // `nextAt` is the manager's, but the rule must still be answerable
      // without one — a row loaded from a file written by an older build, or a
      // test handing in a bare trigger, has to get the same answer.
      const due = typeof i.nextAt === "number"
        ? i.nextAt
        : i.nextAt === null
          ? null
          : nextFireAt(t.rule, i.lastOccurrence ?? i.createdAt - 1);
      if (due == null) {
        // Only a spent one-off reaches here — `once`, or a `weekly`/`window`
        // rule marked `oneShot` that has already fired (a recurring rule
        // always has a next occurrence, a disabled recurring one was caught at
        // rung 1, and an unfired one-shot `window` rule was caught just above).
        return { kind: "fail", detail: "that instant has passed and this was a one-off — post it again if you still want it" };
      }
      if (due > now) return wait("notYet", notYetText(due));
      // ── the run window ───────────────────────────────────────────────────
      // DUE is not the same as ALLOWED. `nextFireAt` places the occurrence and
      // deliberately knows nothing about `hours` (an anchor is a fact about
      // when the work becomes worth doing; quiet hours are a policy over every
      // anchor), so the instant it landed on may be one the user shut the door
      // on. The row waits and says which door.
      if (!inHours(t.rule, now)) return wait("notYet", outsideHoursText(t.rule));
      // And the grace is counted from the moment the window OPENED, never from
      // the anchor: a rule anchored at 03:00 behind a 07:00–22:00 window would
      // otherwise spend every one of its 120 grace minutes asleep and report
      // itself missed at 07:00, having never been allowed to try. An
      // unresolvable opening falls back to the anchor — the old reading, and
      // the conservative one (more likely to call a run missed, never more
      // likely to fire one at an hour nobody allowed).
      const basis = hoursOpenFrom(t.rule, due) ?? due;
      const lateBy = now - basis;
      // `ON_TIME_MS` is the floor under every configured grace, never an
      // addition to it: the tick that first sees a row due is already up to two
      // seconds past the instant, so a bare `lateBy > graceMs` read a grace of
      // 0 ("skip it") as "only on the exact millisecond" — a daily rule wearing
      // *missed* for ever while the desktop was running. See `ON_TIME_MS`.
      const graceMs = Math.max(Math.max(0, t.graceMin) * 60_000, ON_TIME_MS);
      // ── an occurrence this rung has ALREADY released ─────────────────────
      //
      // Every tick re-runs this arm from scratch, and the clock keeps moving
      // while a row is held by a rung BELOW it. So a row that passed here
      // legitimately — due, inside its grace — and was then held by `serial`,
      // `holdForHost`, `noSlot`, `picking` or a busy target spent its deadline
      // on the waits it was TOLD to perform, and this rung failed it for
      // obeying. That is not a hypothetical: `Intent.clearedOccurrence` carries
      // the real case, a user's weekly *wait until free* rule failed after a
      // 2-hour busy spell on a desktop that never stopped running.
      //
      // Once released, the grace is done doing its job — it answered "is this
      // still worth starting", and the answer was yes. What is left is the
      // backstop for work that will never get a turn at all (`HELD_MAX_MS`),
      // which is much larger than any grace and is worded as the clock fact it
      // is. The stamp is per-OCCURRENCE, so the next occurrence of a recurring
      // rule gets its grace judged from scratch like any other.
      const released = i.clearedOccurrence === due;
      const deadline = released ? Math.max(graceMs, HELD_MAX_MS) : graceMs;
      if (lateBy > deadline) {
        const missed = released ? heldOutText(t.graceMin, deadline) : missedText(due, t.graceMin);
        // Past the window. A rule with nothing left to repeat has nothing left
        // to do, so it fails and says which instant it missed — `once` by
        // definition, or a `weekly`/`window` rule marked `oneShot`. A recurring
        // rule keeps standing: the occurrence is recorded as missed and the row
        // waits for the next one. A late `go` is never returned here — the
        // whole point of a grace window is that outside it, running is the
        // wrong answer.
        if (!ruleRecurs(t.rule)) return { kind: "fail", detail: missed };
        return { ...wait("notYet", missed), missedOccurrence: due };
      }
      occurrence = due;
      cleared = due;
      // Under a minute late is on time, as far as anyone reading the row is
      // concerned; past that the row says so, because "it ran" and "it ran two
      // hours after you asked" are different facts. Same constant as the miss
      // floor above — one answer to "would anybody call this late".
      late = lateBy > ON_TIME_MS || undefined;
      break;
    }

    case "after": {
      const t = i.trigger;
      // ── a chain that bites its own tail ─────────────────────────────────
      // Checked FIRST, because every other answer below is "wait" and a cycle
      // is the one shape where waiting is wrong for ever. Two rows pointing at
      // each other settle nothing, so each reads the other as "not finished
      // yet" — a pair of rows that look exactly like work that is next in line
      // and are in fact work that will never start. The store's one
      // non-negotiable rule is that an intent waits, fails loudly, or is
      // cancelled; spinning is not on the list.
      if (chainLoops(i.id, t.id, facts.chainWaits, facts.settled)) {
        return { kind: "fail", detail: CHAIN_LOOP };
      }
      // ── a predecessor that never finishes ───────────────────────────────
      // Before the `settled` lookup, because a recurring rule is never IN
      // `settled` and never will be, so every answer below this line would be
      // "not yet" — for ever, and reassuringly. See `facts.neverSettles`.
      if (facts.neverSettles?.has(t.id)) {
        return { kind: "fail", detail: chainRecurringText(t.title) };
      }
      const done = facts.settled?.get(t.id);
      if (!done) {
        // ── a predecessor somebody filed away ─────────────────────────────
        // Archiving is not terminating: `edit({archived:true})` leaves the row
        // `queued`, so it is in `knownIntents`, out of `settled`, and not the
        // kind of thing `neverSettles` names. Every answer below would then be
        // *waits for “X” to finish* — for ever, about a row that has been taken
        // off the list. Somebody archived "run the migration" to tidy up, and
        // "review the migration" sat in Activity for ever saying it was waiting
        // for it, with nothing on either row saying what releases it.
        //
        // A WAIT and not a fail, because un-archiving genuinely fixes it —
        // which is the difference from `chainGoneText`, and why the sentence
        // names both doors out. Asked before `knownIntents` so the answer does
        // not depend on whether the host counted archived rows as known.
        if (facts.setAside?.has(t.id)) {
          return wait("notYet", chainSetAsideText(t.title));
        }
        // Not settled — or gone. `knownIntents` is the only thing that can
        // tell those apart, and when the host has not supplied it the honest
        // answer is the waiting one: failing a row because a fact was missing
        // would kill work whose predecessor is alive and running.
        if (facts.knownIntents && !facts.knownIntents.has(t.id)) {
          return { kind: "fail", detail: chainGoneText(t.title) };
        }
        return wait("notYet", chainWaitText(t.title));
      }
      // ── a predecessor somebody called off ─────────────────────────────────
      // A cancel is a person saying "not this", which is not "afterwards". The
      // row would otherwise be released by it exactly like a success, because
      // `settled` records a cancel as `{ok: false}` and an unqualified chain
      // does not read `ok` at all: "after the migration, review it and post the
      // diff" then reviewed a migration that was stopped half-way, unattended,
      // and the only person who could have said that was wrong had just
      // pressed cancel. It outranks `onlyIfOk` (which cannot save a chain that
      // did not opt in) and it is terminal, because nothing re-runs a cancelled
      // row. Absent = the old behaviour: a host that does not supply the flag
      // releases the chain as before.
      if (done.canceled) return { kind: "fail", detail: CHAIN_PREDECESSOR_CANCELED };
      // Finished, but not well, on a chain that asked. This is a FAIL and not
      // a wait: the condition it was given can never become true again — a
      // settled row does not re-run — so a row that waited here would be
      // waiting for something nobody can make happen.
      if (!done.ok && t.onlyIfOk) return { kind: "fail", detail: CHAIN_PREDECESSOR_FAILED };
      // A deadline only if one was given. Absent means the person named an
      // EVENT rather than an instant, and a desktop that slept through the
      // event has lost nothing by picking the work up now — the opposite
      // default would quietly bin a chain every time the laptop was shut.
      if (t.graceMin != null) {
        const lateBy = now - done.at;
        // The same floor the `at` arm uses, and here for the same measured
        // reason: the tick that first sees the predecessor settled is already
        // up to two seconds behind it, so `graceMin: 0` failed a chain
        // TERMINALLY 1.5 s after the row it was waiting for finished, saying
        // the desktop had not been running. See `ON_TIME_MS`.
        const graceMs = Math.max(Math.max(0, t.graceMin) * 60_000, ON_TIME_MS);
        // …and the same release rule, for the same reason. A chain released by
        // this rung and then held on `serial` or `noSlot` was failing for
        // obeying the rung below it — the shape documented on the trigger
        // itself as if it were the design. `done.at` is this arm's release
        // instant: stable for as long as the predecessor stays settled, and
        // different for a different predecessor, which is exactly what the
        // stamp has to distinguish.
        const releasedChain = i.clearedOccurrence === done.at;
        const deadline = releasedChain ? Math.max(graceMs, HELD_MAX_MS) : graceMs;
        if (lateBy > deadline) {
          return {
            kind: "fail",
            detail: releasedChain ? heldOutText(t.graceMin, deadline) : chainMissedText(t.graceMin),
          };
        }
      }
      cleared = done.at;
      // No `occurrence` and no `late`: those are the `at` trigger's
      // bookkeeping — `lastOccurrence` is what stops one wall-clock instant
      // being spent twice — and a chain has no occurrence to spend. Handing
      // one back here would write a `lastOccurrence` onto a row that has no
      // clock to compare it against.
      break;
    }
  }

  /**
   * Every wait from here down is a wait the row was TOLD to perform, and rung 3
   * has already released the occurrence it is waiting to spend. Stamping that
   * onto the verdict is what stops the next tick's rung 3 spending the deadline
   * a second time — the whole of `Intent.clearedOccurrence`'s note. Applied at
   * the returns rather than at the top so rung 3's own `fail`/`missed` answers
   * (which are about the grace, not about a hold) are untouched.
   */
  const held = <V extends IntentVerdict>(v: V): V =>
    v.kind === "wait" && cleared != null ? { ...v, clearedOccurrence: cleared } : v;

  // ── 4. serial ────────────────────────────────────────────────────────────
  // The group is the WORKTREE. Two worktrees of one repo are separate
  // checkouts that cannot write over each other, so they are not each other's
  // business — the only thing they share is the usage limit, and that is a
  // knob, not a rule.
  // The sentence NAMES what holds the repo when the caller said (`serialHolders`)
  // — "waiting for the session before it" sent a person looking for a session
  // they could not find, which was the orchestrating one, mid-turn. The named
  // session's id rides along (`holderSessionId`) so the row can OPEN it: when
  // the predecessor is parked on a question, that is the one thing to do.
  if (i.serial && facts.busyCwds.has(serialGroup(i.cwd))) {
    const holders = facts.serialHolders?.get(serialGroup(i.cwd));
    const lead = serialLead(holders);
    const v = wait("serial", holders?.length ? serialWaitText(holders) : undefined);
    return held(lead?.sessionId ? { ...v, holderSessionId: lead.sessionId } : v);
  }

  // ── 4.5 holdForHost ──────────────────────────────────────────────────────
  // Opt-in and orthogonal to `serial`: that rung is scoped to ONE repo, this
  // one is scoped to the whole host. Checked after `serial` so a row that is
  // already waiting on its own repo reports THAT reason, the more specific one.
  if (i.holdForHost && facts.hostBusy) return held(wait("hostBusy"));

  // ── 4.6 a free slot ──────────────────────────────────────────────────────
  // Every backlog item now opens its OWN session, so the bound on how many
  // agents machinery may have running at once stops being a side-door refusal
  // inside the host ("waiting for a free backlog session — …open this repo's
  // backlog session yourself") and becomes a rung, with a sentence, on the row
  // that is waiting. Same ladder, same words, one place.
  //
  // Only AUTO rows are bounded, which is the exemption shape rungs 1 and 2
  // already use: a person tapping "send" has decided to spend a slot, and a cap
  // written for unattended work was never a statement about that tap. `session`
  // targets need no slot (nothing is opened), and a `repos` sweep keeps its own
  // `FANOUT_CONCURRENCY` — one bound per kind of spawn, never two over one.
  //
  // Checked after `holdForHost` for that rung's reason in reverse: this is the
  // most general wait of the three (the whole desktop's budget of sessions), so
  // the repo-scoped and opt-in ones speak first when they are also true.
  if (i.auto && needsSlot(i) && facts.autoSlotsFree <= 0) return held(wait("noSlot"));

  // ── 5. target readiness ──────────────────────────────────────────────────
  return held(targetVerdict(i, facts, occurrence, late));
}
