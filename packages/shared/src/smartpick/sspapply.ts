/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/shared-architecture.md. */
import { type SmartPickCandidate, type SmartPickMerge, type SmartPickMergePlan, type SmartPickOrder, type SmartPickPlan, type SmartPickProposal } from "./ssptypes.js";
import { SMARTPICK_MAX_NOTES } from "./sspconst.js";
import { mergeKey, smartpickName } from "./sspclean.js";

// ── Turning a proposal into a plan ───────────────────────────────────────────

/**
 * The proposal, plus the candidates, in — the mutations the host performs, out.
 *
 * **The rule the whole function exists for: a slot a person set by hand keeps
 * its occupant.** The sort works on SLOT VALUES, not on positions: the
 * candidates' existing `order` values are collected, sorted, and re-assigned, so
 * rows in the repo that are not candidates keep their relative places and
 * nothing is renumbered 0..n. Then the slots are walked in ascending order —
 * a slot whose current occupant is `handOrdered` keeps it, and every other slot
 * takes the next entity from the machine's sequence, which is the sanitised
 * order with `pick` moved to the front.
 *
 * So if you dragged Y to the top and the model picked X, Y still runs next and X
 * is the first machine slot after it. That combination is a NOTE, because the
 * alternative — the pass quietly overruling the one explicit act in the sheet —
 * is the thing this rule exists to prevent, and a person who cannot see it
 * happen will read the strip as the pass not working.
 *
 * A merged row inherits `handOrdered` from any member, so a merge never leaves a
 * hand-placed job free to be moved again. **A PINNED group's slot is the
 * earliest member's**, which is the one place a merge can move a hand-placed
 * job: when the person dragged a later member, folding it into a row that sits
 * at the earliest member's slot moves that work earlier. Unavoidable — the row
 * they placed no longer exists on its own — and bounded, because the merged row
 * is hand-ordered from then on and nothing automatic touches it again.
 *
 * An UNPINNED group has no slot of its own to keep: it is one entity in the
 * machine's sequence like any other, and it takes the next free slot that
 * sequence reaches. Said explicitly because this header, `SmartPickMergePlan.
 * order` and the plan all used to describe the pinned case as though it were
 * the rule, and a merged group that lands LATER than its earliest member (every
 * member unpinned, the pass having sorted the group down) is the ordinary case,
 * not a bug.
 *
 * Nothing here mutates anything, and nothing here is asked to. It returns a
 * plan.
 */
export function applySmartPick(
  proposal: SmartPickProposal,
  cands: readonly SmartPickCandidate[],
): SmartPickPlan {
  const notes: string[] = [...proposal.notes];
  const note = (s: string): void => { if (notes.length < SMARTPICK_MAX_NOTES) notes.push(s); };

  const byId = new Map<string, SmartPickCandidate>();
  for (const c of cands) if (c && typeof c.id === "string" && c.id && !byId.has(c.id)) byId.set(c.id, c);

  const groupOf = new Map<string, SmartPickMerge>();
  proposal.merges.forEach((g, k) => groupOf.set(mergeKey(k), g));

  /** Every entity's members, in candidate form. A plain id is a group of one. */
  const membersOf = (key: string): SmartPickCandidate[] => {
    const g = groupOf.get(key);
    if (g) return g.ids.map((id) => byId.get(id)).filter((c): c is SmartPickCandidate => !!c);
    const c = byId.get(key);
    return c ? [c] : [];
  };

  const entities = proposal.order.filter((k) => membersOf(k).length > 0);

  // ── The slots: the candidates' own values, re-assigned ───────────────────
  const slots = cands.map((c) => c.order).sort((a, b) => a - b);

  // A hand-placed entity keeps its own slot; for a merged one that is its
  // earliest member's, which is also where the merged row is posted.
  //
  // **A CLOCK pins the GROUP's slots, not each row inside them.** A clock says
  // when work may run at all, so no timed row may be moved past an item with a
  // different clock or with none — that part is pinned exactly as a drag is,
  // and for the same reason. But a person who queues seven items on one instant
  // has said nothing whatever about which of the seven goes first, and the
  // whole of this feature is deciding that question: measured on this desktop,
  // twelve live one-offs, all armed for the same reset, seven of them in one
  // repo, running in the order they happened to be typed. So the slots a clock
  // group occupies stay that group's, and the members are re-seated in them in
  // the pass's order. A `handOrdered` member keeps its exact seat — a drag is
  // still the stronger statement of the two INSIDE the group, as it is outside.
  //
  // `pinnedBy` is only for the WORDING — a note that called a clock a drag
  // would send somebody looking for a row they never dragged — and a row that
  // is both reads as the clock, which is the stronger statement.
  const clockOf = new Map<string, string>();
  for (const key of entities) {
    const members = membersOf(key);
    const keys = new Set(members.map((c) => c.atKey ?? ""));
    // One clock, agreed by every member. A merge that disagrees is refused
    // upstream; met here anyway it is pinned whole rather than re-seated, which
    // is the old behaviour and the safe half of it.
    if (keys.size === 1 && members[0].atKey) clockOf.set(key, members[0].atKey);
    else if (members.some((c) => c.atKey)) clockOf.set(key, `mixed:${key}`);
  }
  const pinned = new Map<string, number>();
  const pinnedBy = new Map<string, "hand" | "clock">();
  /** Clock group → the slots it owns, and which of its entities may be re-seated. */
  const clockGroups = new Map<string, { slots: number[]; handSeats: number[]; movable: string[] }>();
  for (const key of entities) {
    const members = membersOf(key);
    const ck = clockOf.get(key);
    const hand = members.some((c) => c.handOrdered);
    if (!ck && !hand) continue;
    const slot = Math.min(...members.map((c) => c.order));
    if (!ck) { pinned.set(key, slot); pinnedBy.set(key, "hand"); continue; }
    let g = clockGroups.get(ck);
    if (!g) { g = { slots: [], handSeats: [], movable: [] }; clockGroups.set(ck, g); }
    g.slots.push(slot);
    // A hand-placed row inside a clock group keeps its seat outright; the rest
    // are the ones this pass may sequence among themselves.
    if (hand) { pinned.set(key, slot); pinnedBy.set(key, "clock"); g.handSeats.push(slot); }
    else g.movable.push(key);
  }
  // Seat the movable members of each group in the group's own remaining slots,
  // in the pass's order. Nothing leaves the group: the slot multiset is the
  // group's own, so a timed row can only ever change places with a row on the
  // identical clock.
  let reseated = 0;
  for (const g of clockGroups.values()) {
    const seats = g.slots.slice().sort((a, b) => a - b);
    for (const taken of g.handSeats) {
      const at = seats.indexOf(taken);
      if (at >= 0) seats.splice(at, 1);
    }
    g.movable.forEach((key, i) => {
      if (i >= seats.length) return;
      pinned.set(key, seats[i]);
      pinnedBy.set(key, "clock");
      if (Math.min(...membersOf(key).map((c) => c.order)) !== seats[i]) reseated++;
    });
  }

  // Take each pinned value out of the slot multiset — one occurrence each, so
  // two rows that happen to share an order value do not eat one slot twice.
  const free = [...slots];
  for (const v of pinned.values()) {
    const at = free.indexOf(v);
    if (at >= 0) free.splice(at, 1);
  }
  if (reseated) {
    // Said out loud for the same reason every other correction here is: the
    // rows kept their instant and only their turn changed, and a person reading
    // a re-ordered list without this sentence cannot tell which of the two
    // happened.
    note(`${reseated} item${reseated === 1 ? "" : "s"} waiting on the same clock changed places among themselves — the instant they run at is untouched, and none of them moved past an item on a different clock.`);
  }

  // ── The machine's sequence: the sanitised order, pick first ──────────────
  const machine = entities.filter((k) => !pinned.has(k));
  const pick = proposal.pick && entities.includes(proposal.pick) ? proposal.pick : null;
  const nameOf = (key: string): string => {
    const m = membersOf(key)[0];
    return m ? smartpickName(m) : key;
  };
  if (pick && pinned.has(pick)) {
    // The pick is itself a row nothing here may move: one the person placed, or
    // one waiting on its own clock. Either way it already runs where it runs,
    // and there is nothing for the pass to do about it. `cleanSmartPick`
    // corrects a timed pick away before this — the branch is here because this
    // function is also handed proposals that never went through it.
    note(pinnedBy.get(pick) === "clock"
      ? `picked “${nameOf(pick)}”, which runs on its own clock — the clock stands, so the pick changes nothing.`
      : `picked “${nameOf(pick)}”, which you had already placed by hand — it runs where you put it.`);
  } else if (pick) {
    const at = machine.indexOf(pick);
    if (at > 0) machine.unshift(...machine.splice(at, 1));
    // A pinned row sitting in an earlier slot than any the machine may fill is
    // the one case where the pick does NOT run next. Said out loud, because a
    // person who cannot see that happen reads the strip as the pass not
    // working — and said in the words of whichever thing pinned it.
    const ahead = [...pinned.entries()].filter(([, v]) => v < (free[0] ?? Infinity)).sort((a, b) => a[1] - b[1])[0];
    if (ahead) {
      note(pinnedBy.get(ahead[0]) === "clock"
        ? `picked “${nameOf(pick)}”; “${nameOf(ahead[0])}” is ahead of it on a clock of its own, so “${nameOf(pick)}” runs after it.`
        : `picked “${nameOf(pick)}”; you had placed “${nameOf(ahead[0])}” first, so “${nameOf(pick)}” runs after it.`);
    }
  }
  const sortableClock = [...clockGroups.values()].some((g) => g.movable.length > 1);
  if (entities.length && !machine.length && !sortableClock) {
    // Three ways for a repo to have nothing the pass may place, and they are
    // not the same sentence: one is a person's doing, one is their clocks, and
    // the third is both. A repo told it had "placed everything by hand" when it
    // had dragged nothing is a repo whose owner goes looking for the drag.
    const kinds = new Set([...pinnedBy.values()]);
    note(kinds.size > 1
      ? `every waiting item here is either placed by hand or on a clock of its own, so there was nothing to sort or pick — only a merge can change this list.`
      : kinds.has("clock")
        ? `every waiting item here runs on a clock of its own, so there was nothing to sort or pick — only a merge can change this list.`
        : `every waiting item here is placed by hand, so there was nothing to sort or pick — only a merge can change this list.`);
  }

  // ── Assign ───────────────────────────────────────────────────────────────
  const finalOrder = new Map<string, number>(pinned);
  machine.forEach((key, i) => {
    if (i < free.length) finalOrder.set(key, free[i]);
  });

  const orders: SmartPickOrder[] = [];
  const merges: SmartPickMergePlan[] = [];
  for (const key of entities) {
    const at = finalOrder.get(key);
    if (at == null) continue;
    const g = groupOf.get(key);
    if (g) {
      const members = membersOf(key);
      const resumes = new Set(members.map((c) => !!c.resume));
      // The clock the members agreed on, recomputed here rather than trusted:
      // `cleanSmartPick` has already refused a group that disagreed, and this
      // says the same thing a second time against a proposal that may not have
      // come through it. A disagreement leaves the field ABSENT — and the host
      // refuses to write a merge whose real rows carry a clock the plan does
      // not, so an absent key can never quietly un-schedule somebody's work.
      const clocks = new Set(members.map((c) => c.atKey ?? ""));
      // Same posture as the clock, one line further: recomputed rather than
      // trusted, and ABSENT on a disagreement — which the host then refuses to
      // write, so an absent hold can never quietly un-hold somebody's work.
      const holds = new Set(members.map((c) => !!c.holdForHost));
      const waivers = new Set(members.map((c) => !!c.pastBudget));
      merges.push({
        key,
        ids: [...g.ids],
        text: g.text,
        why: g.why,
        order: at,
        ...(resumes.size === 1 && members[0].resume ? { resume: true } : {}),
        ...(members.some((c) => c.handOrdered) ? { handOrdered: true } : {}),
        ...(clocks.size === 1 && members[0].atKey ? { atKey: members[0].atKey } : {}),
        ...(holds.size === 1 && members[0].holdForHost ? { holdForHost: true } : {}),
        ...(waivers.size === 1 && members[0].pastBudget ? { pastBudget: true } : {}),
      });
      continue;
    }
    const c = byId.get(key);
    // A row already in the right place is not a mutation. `orders.length` is
    // then the honest "sorted N" the strip shows — a count that included rows
    // nothing happened to would be a number describing a different event.
    if (c && c.order !== at) orders.push({ id: key, order: at });
  }

  return { orders, merges, pick: proposal.pick, notes };
}