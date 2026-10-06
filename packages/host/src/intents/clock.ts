/**
 * The clock of the intent store (I2 of the split in
 * docs/notes/host-architecture.md): when an `at` row is next armed — a new
 * row's basis (`newBasis`/`armNew`), the grace clamp (`armFrom`, over the
 * grace floor `graceFloor`, which `hours` widens) — and the two verbs that move
 * a rule's clock by hand, `skipNext` and `setArmed`.
 *
 * Stateless: every function that needs the store takes `core` first. There is
 * still exactly one local-clock implementation — `inHours`/`hoursOpenFrom` in
 * `@waterplane/shared` — and nothing here derives a local time of its own.
 */
import { hoursOpenFrom, inHours, nextFireAt, ruleRecurs, type Intent, type ScheduleRule } from "@waterplane/shared";
import type { IntentCore } from "./contract.js";

// ── The clock ─────────────────────────────────────────────────────────────

/**
 * The next occurrence after `basis`, clamped to the grace window.
 *
 * The clamp is `cleanEntry`'s and it is what makes a missed fire behave: an
 * occurrence that passed while the host was down is still AHEAD of the floor,
 * so it comes back as due and runs late; one that passed a week ago is behind
 * it and is never considered at all. Without it a host that was off for a
 * month would march through a month of occurrences one tick at a time.
 */
/**
 * Arming a row that has never run — and the one place the two kinds of rule
 * genuinely differ.
 *
 * A ONE-OFF names an INSTANT. When that instant is already behind us at the
 * moment the row lands, the grace window is exactly the thing that says what
 * to do: run it late, and say so. Arming from `createdAt` instead put the
 * basis AHEAD of the floor, so `nextFireAt` answered null and the row failed
 * on arrival with "post it again" — for a schedule the user wrote at 20:58 for
 * 21:00 whose phone only got the link back at 21:05, which is the case the
 * send queue exists for and the case a wall-clock rule is supposed to survive.
 *
 * A RECURRING rule is the opposite: it arms from now. Arming a standing rule
 * from the floor would fire it within the second, after the time it names, on
 * the day it was written — the first occurrence it ever meets is the next one.
 */
export function armNew(core: IntentCore, row: Intent, now: number): number | null | undefined {
  if (row.trigger.kind !== "at") return null;
  return armFrom(core, row, newBasis(row), now);
}

/**
 * The basis a row that has never spent an occurrence arms from — `armNew`'s
 * rule, shared with every other site that arms such a row.
 *
 * A ONE-OFF (`!ruleRecurs`: a `once`, or a `weekly`/`window` rule with
 * `oneShot`) names ONE instant, whatever its anchor, and the grace is the
 * person's own answer to "how late is still worth starting". So `0` hands the
 * decision to `armFrom`'s grace floor: an instant between the floor and now
 * runs at once, `late`; one before the floor is never returned, and the rule
 * finds its next occurrence instead. Arming from `createdAt` put the basis
 * past an instant already behind us — a row saved at 18:50 for *an hour
 * before the 19:00 reset* armed for NEXT week's reset, a silent skip of
 * exactly the run it was written for. *Thursday 18:00, once* saved on
 * Thursday at 19:00 with a 120-minute grace therefore runs now, late, like
 * `once`; saved past the grace it arms next Thursday (decided 2026-09-24 —
 * it used to arm from now like every weekly rule, which skipped a run the
 * person's own grace said was still wanted). A RECURRING rule arms from now.
 */
export function newBasis(row: Intent): number {
  if (row.trigger.kind !== "at") return row.createdAt - 1;
  return ruleRecurs(row.trigger.rule) ? row.createdAt - 1 : 0;
}

export function armFrom(core: IntentCore, row: Intent, basis: number, now: number): number | null | undefined {
  if (row.trigger.kind !== "at") return null;
  const floor = graceFloor(row.trigger.rule, Math.max(0, row.trigger.graceMin), now);
  // The usage dep is asked ONLY for the rule kind that needs it. Not an
  // optimisation: `migrateLegacy()` arms every imported schedule during the
  // module body, before `usage` is constructed further down `main.ts`, so an
  // unconditional call reached a `const` in its temporal dead zone and threw
  // — taking the whole legacy import with it. A clock rule has never needed
  // to know anything about usage, and now it does not ask.
  const at = nextFireAt(
    row.trigger.rule,
    Math.max(basis, floor),
    row.trigger.rule.kind === "window" ? core.deps.usageWindows?.() : undefined,
  );
  // `null` from a `window` rule means the reset has not been READ, which is
  // "not computed yet" and not "switched off" — and those are two different
  // sentences on the phone, one of which offers a tap that cannot work.
  if (at == null && row.trigger.rule.kind === "window") return undefined;
  return at;
}

/**
 * How far back the search for an occurrence may start — the grace window, as
 * a floor.
 *
 * Without `hours` it is what it always was: `now` minus the grace, so a fire
 * missed while the host was asleep is still AHEAD of the floor and comes back
 * as due, and one missed a week ago is behind it and never considered.
 *
 * With `hours` the floor has to move, because the grace is counted from the
 * moment the run window OPENED and not from the anchor (`hoursOpenFrom`, and
 * `intentVerdict`'s `at` arm, which does the exact arithmetic). A rule
 * anchored at 03:00 behind a 07:00–22:00 window is due at 03:00 and may not
 * run until 07:00: at 07:05, with two hours of grace, the plain floor is
 * 05:05 and the 03:00 occurrence is already behind it, so `nextFireAt` never
 * returns it and the row is not merely late — it is never offered at all, and
 * it would be so every single day. The window's own opening is the extra
 * slack and it is at most a day wide, so a day is what the floor gives back.
 *
 * Widened, never narrowed, and the widening only makes an occurrence
 * VISIBLE. Whether it may actually run is `intentVerdict`'s to say — it asks
 * `inHours` and `hoursOpenFrom` about that same occurrence, and answers `wait`
 * or a recorded miss. Which is also why this does not re-derive a local time:
 * there is exactly one implementation of "what time is it in this rule's
 * zone" (`schedule.ts`'s `zoneMinuteOfDay`, behind those two exports), and a
 * second one here would disagree with the verdict across a DST edge — the
 * drift the zone is stored to prevent.
 */
export function graceFloor(rule: ScheduleRule, graceMin: number, now: number): number {
  const plain = now - graceMin * 60_000 - 1;
  if (!rule.hours) return plain;
  // Open at the floor ⇒ nothing older can still be live: an occurrence before
  // the floor was inside an earlier opening, so its grace has long run out.
  // This is the ordinary case for a daytime rule at a daytime moment, and it
  // keeps the widening off the path that does not need it.
  if (inHours(rule, plain)) return plain;
  // Shut at the floor. Every occurrence from the last close up to the floor
  // shares ONE next opening, so they are all live or all dead together, and
  // `hoursOpenFrom` answers which — an opening still ahead of `now` means the
  // window has not even opened yet, which is the 03:00-anchor-at-05:05 case
  // this whole clause exists for.
  const open = hoursOpenFrom(rule, plain);
  if (open == null || now - open > graceMin * 60_000) return plain;
  // One turn of the clock is the widest a shut stretch can be, and this only
  // makes the occurrence VISIBLE — `intentVerdict` does the exact arithmetic
  // on the candidate itself and answers `go`, `wait`, or a recorded miss.
  return plain - 24 * 60 * 60_000;
}

/**
 * Let the next occurrence pass, and arm the one after it.
 *
 * The occurrence is SPENT (`lastOccurrence`) rather than merely stepped over,
 * which is what stops the tick reading it as due again a second later — the
 * same field, and the same reason, as a fire that actually ran. Recurring
 * only: skipping the single occurrence a `once` has is deleting it, and the
 * row would come back `spent` claiming it had run.
 */
export function skipNext(core: IntentCore, id: string): { ok: boolean; reason?: string; nextAt?: number | null } {
  const row = core.get(id);
  if (!row || row.trigger.kind !== "at") return { ok: false, reason: "that schedule is gone" };
  if (!ruleRecurs(row.trigger.rule)) return { ok: false, reason: "a one-off has only the one run — delete it instead" };
  if (row.nextAt == null) return { ok: false, reason: "nothing is armed to skip — it is paused" };
  const now = Date.now();
  const skipped = row.nextAt;
  row.lastOccurrence = skipped;
  row.clearedOccurrence = undefined;
  row.nextAt = armFrom(core, row, skipped, now);
  row.state = "queued";
  row.blockReason = undefined;
  row.blockDetail = undefined;
  // The instant travels as `occurrence`, never inside the sentence: this
  // string is written here and rendered on a phone, and a date formatted in
  // the desktop's locale lands on the card beside the phone's own rendering
  // of the SAME instant ("… the 9/17/2026, 4:00:00 PM run … · due Do., 17.
  // Sept., 16:00"). Same rule as `notYetText`/`missedText`.
  row.result = { at: now, ok: true, detail: "skipped that run — the one after it is armed", occurrence: skipped };
  core.persist();
  core.deps.onChange(row);
  return { ok: true, nextAt: row.nextAt };
}

/** Arm (or disarm) a recurring rule — the schedule sheet's pause switch.
 *  Re-arming searches from NOW, never from the last occurrence: turning a
 *  rule back on must not fire everything it slept through. */
export function setArmed(core: IntentCore, id: string, armed: boolean): boolean {
  const row = core.get(id);
  if (!row || row.trigger.kind !== "at") return false;
  const next = armed ? nextFireAt(row.trigger.rule, Date.now(), core.deps.usageWindows?.()) : null;
  if (row.nextAt === next) return false;
  row.nextAt = next;
  if (!armed) { row.blockReason = undefined; row.blockDetail = undefined; row.state = "queued"; }
  core.persist();
  core.deps.onChange(row);
  return true;
}
