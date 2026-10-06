/**
 * **Every clock on this desktop, cut once — for the chip, its sentence and the
 * sheet alike.**
 *
 * The pure half of `clockDirectory.tsx` and of the Schedules sheet's own
 * arithmetic — no JSX, so `node --test` runs it straight over the TypeScript
 * and `npm run test:unit` discovers it:
 *
 *     node --test packages/web/src/clockCuts.test.mjs
 *
 * Everything here is a CUT, and every cut in this app has the same rule behind
 * it: a number on a control is a claim about a set of rows, and the only way
 * anybody can check a claim is to see exactly those rows. So the edges are
 * `@waterplane/shared`'s — `isStandingSchedule` (what "still coming" means) and
 * `horizonBucket` (where `<= 1h` lives) — and never re-derived here.
 *
 * **Why the whole pool lives in one function.** There were three hand-rolled
 * readings of "this row is a standing clock": the launcher chip's
 * `scheduleHorizon` call, the sentence in that chip's own title, and this
 * sheet's list. On this user's store, on the day it was measured, they said
 * **13 · 8 · 2** about one set of rows — the chip's title contradicting the
 * chip it was written on, and the number naming eleven rows the tap could not
 * reach. Two independent causes stacked (one reading dropped
 * `lastOccurrence`, two of them counted rows that had already run or failed),
 * which is what three copies of an edge produce: not one bug, but as many as
 * there are copies. So there is one predicate (`isStandingClock`), one pool,
 * one bucketing pass over exactly that pool, and `horizon.total` is not a
 * second count that agrees — it IS `standingTotal`.
 */
import type { Intent, ScheduleEntry, HorizonBucket, ScheduleHorizon } from "@waterplane/shared";
import { horizonBucket, isStandingSchedule, isTimedWorkRow, ruleRecurs } from "@waterplane/shared";

/**
 * **A one-off aimed at ONE place is not a card — it is a backlog row.**
 *
 * `isTimedWorkRow` is the cut over the durable row. This is the same question
 * asked of a `ScheduleEntry` that has not reached the host yet, where there is
 * no `Intent` to ask: a `backlog` action with a rule that does not recur is
 * exactly what `scheduleToIntent` turns into one. Without it a one-off saved
 * from this phone would sit in the CARDS until the link came back and then jump
 * into the directory — the same row in two places, which is the shape this
 * change exists to remove.
 */
export const entryIsTimedWork = (e: ScheduleEntry): boolean => !ruleRecurs(e.rule) && e.action.kind === "backlog";

/** Settled for good: nothing is waiting on a clock any more. */
const intentOver = (i: Intent): boolean => i.state === "done" || i.state === "failed" || i.state === "canceled";

/**
 * **Is this row a clock that is still standing?** The one predicate.
 *
 * Three things have to be true, and every one of them was missing from at
 * least one of the three readings this replaces:
 *
 *  - it HAS a clock (`trigger.kind === "at"`) and has not been set aside;
 *  - it has not already settled. A `done` or `failed` row is not waiting for
 *    anything — six of them were counted as "not armed" on this desktop, a
 *    state with no way out being reported as something to fix;
 *  - its rule is not spent, read WITH `lastOccurrence`. Dropping that field is
 *    not a smaller version of the same question: `isSpentOnce`'s
 *    `window`/`oneShot` branch is *only* `lastOccurrence != null`, so without
 *    it such a row can never read as spent at all, and five more ran up the
 *    same "not armed" count.
 *
 * `isStandingSchedule` is `@waterplane/shared`'s and is never re-worded here — the
 * cards ask it of a `ScheduleEntry`, this asks it of the durable row, and two
 * spellings of "spent" is how a badge stops describing the list it opens.
 */
export function isStandingClock(i: Intent, now: number): boolean {
  if (i.archived || i.trigger.kind !== "at" || intentOver(i)) return false;
  return isStandingSchedule({ rule: i.trigger.rule, nextAt: i.nextAt, lastOccurrence: i.lastOccurrence }, now);
}

/**
 * **Which directory lines a re-time may tick** — the durable row's reading of
 * `backlogFilter.retimeEligible`, and the host's `update()` is the authority
 * behind both: a row mid-run or settled refuses a new trigger, and a FAILED one
 * is revived by one only because it is timed (every line here is).
 */
export function retimeIntentEligible(i: Intent): boolean {
  if (i.archived || i.trigger.kind !== "at") return false;
  return i.state !== "starting" && i.state !== "running" && i.state !== "done" && i.state !== "canceled";
}

/** A queued `schedule.save` this phone has written, plus whether its send gave
 *  up. The shape `ScheduleSheet` already speaks, repeated as a type rather than
 *  imported, so this module does not depend on the sheet that draws it. */
export interface PendingClock { entry: ScheduleEntry; failed?: boolean }

export interface ClockCuts {
  /** The standing CARDS: a rule that repeats, or a one-off sweep — the rows
   *  this sheet can arm, pause and skip. Queued saves win over the host's copy
   *  of the same id (an edit that has not landed is the newer of the two). */
  cards: ScheduleEntry[];
  /** Cards that have been and gone — the sheet's spent foot. */
  spentCards: ScheduleEntry[];
  /** `cards`, minus whatever cut the sheet was opened on. */
  shownCards: ScheduleEntry[];
  /** The queued saves that are CARDS, with their send verdict — the sheet draws
   *  a sync chip from it, so the verdict travels and is never inferred. */
  pendingCards: PendingClock[];
  /** Still coming: not settled, and still standing by the same reading the
   *  launcher chip counts with. */
  live: Intent[];
  /** Been and gone — run or missed, the row says which. */
  gone: Intent[];
  /** `live`, minus whatever cut the sheet was opened on. */
  shown: Intent[];
  /** Saves this phone holds that the desktop has not listed yet. */
  pending: PendingClock[];
  /** `gone`, grouped by repo — the count is the filter, and a backlog is scoped
   *  to one repo, so one number over three repos could not open the list it
   *  counted. */
  goneByRepo: Array<[string, Intent[]]>;
  /**
   * **Every standing clock on this desktop, bucketed — the launcher chip's
   * number.**
   *
   * Bucketed over exactly the pool above rather than re-cut from the raw list,
   * so `horizon.total === standingTotal` is an identity and not a coincidence
   * two functions have to keep agreeing on. `horizonBucket` is still the only
   * place the hour/day/week edges live, because the tap on "2 within the hour"
   * has to open exactly those two whichever kind they turn out to be.
   */
  horizon: ScheduleHorizon;
  /** …and WHAT that pool is made of, for the chip's own sentence. Two kinds of
   *  thing wear one clock, and calling the whole pool "rules" named nine
   *  backlog rows as rules on this user's desktop. */
  kinds: { rules: number; timed: number };
  /** `cards + live + pending` — this sheet's header, and `horizon.total`. */
  standingTotal: number;
  /** The same, under whatever cut the sheet was opened on. */
  shownTotal: number;
}

/**
 * Every clock, cut once: the cards, the directory, the foot and the number.
 *
 * Every timed row is in exactly one of `live` / `gone` by construction — `gone`
 * is "everything timed that is not live" — so no row can fall between them and
 * vanish off both the list and its foot. The same holds for the cards.
 *
 * One `now` for the whole pass, handed in by the caller: a row must not fall
 * out of the set between two `horizonBucket` calls in one render, and a
 * sentence a `node --test` has to pin cannot read the wall clock.
 *
 * `dismissedAt` is excluded from `gone` only: it is Activity's own "I have
 * dealt with this", and a foot that keeps counting a row somebody has already
 * filed is a count nobody can ever clear. A row still WAITING is never hidden
 * by it — being filed is not the same as not happening.
 */
export function clockCuts(o: {
  intents: readonly Intent[];
  /** The rule list as the host lists it (`schedule.list`). Absent on a caller
   *  that has none — the pool is then the durable rows alone. */
  entries?: readonly ScheduleEntry[];
  pending: readonly PendingClock[];
  focus: HorizonBucket | null;
  focusIds: { ids: string[] } | null;
  now: number;
}): ClockCuts {
  const { focus, focusIds, now } = o;
  const all = o.intents.filter((i) => isTimedWorkRow(i) && !i.archived);
  const live = all
    .filter((i) => isStandingClock(i, now))
    .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  const liveIds = new Set(live.map((i) => i.id));
  const gone = all.filter((i) => !liveIds.has(i.id) && !i.dismissedAt);
  const shown = focusIds
    ? all.filter((i) => focusIds.ids.includes(i.id))
    : focus
      ? live.filter((i) => horizonBucket(i.nextAt, now) === focus)
      : live;
  const goneByRepo: Array<[string, Intent[]]> = [];
  for (const i of gone) {
    const g = goneByRepo.find(([dir]) => dir === i.cwd);
    if (g) g[1].push(i); else goneByRepo.push([i.cwd, [i]]);
  }
  // A queued save disappears from here the moment the host lists the intent —
  // the line below then says everything truer than this one can (its armed
  // instant, its state, its repo). The same dedup covers both kinds, so a save
  // in flight can never be counted beside the row it is an edit of.
  const onHost = (p: PendingClock) => o.intents.some((i) => i.id === p.entry.id);
  const pending = o.pending.filter((p) => entryIsTimedWork(p.entry) && !onHost(p));

  // ── The cards ──────────────────────────────────────────────────────────
  // A queued save WINS over the host's copy of the same id: it is the newer of
  // the two by construction (an edit of it that has not landed), and showing
  // the pre-edit row while the edit sits in the queue is the same false claim
  // in a smaller way. Armed soonest first; a disabled rule sinks to the bottom
  // rather than disappearing — "why didn't it run" is answered by seeing the
  // row say it is off.
  //
  // Deliberately NOT deduped against `intents` the way the directory lines
  // above are: a card is drawn from the ENTRY either way, so while the save is
  // in the queue the honest thing is to draw the queued copy and let the sync
  // chip say it has not landed. A directory LINE has no such copy to fall back
  // on, which is why that one waits for the host's own row instead.
  const pendingCards = o.pending.filter((p) => !entryIsTimedWork(p.entry));
  const queued = new Set(pendingCards.map((p) => p.entry.id));
  const allCards = [...pendingCards.map((p) => p.entry), ...(o.entries ?? []).filter((e) => !queued.has(e.id))]
    .sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  const cards = allCards.filter((e) => isStandingSchedule(e, now));
  const spentCards = allCards.filter((e) => !isStandingSchedule(e, now));
  // An ids cut is over EVERY card, standing and spent alike, and wins over a
  // horizon bucket rather than compounding with it: the two are different taps,
  // and a link followed into a list that had a bucket on would show the reader
  // a rule they asked for minus a window they did not.
  const shownCards = focusIds
    ? allCards.filter((e) => focusIds.ids.includes(e.id))
    : focus
      ? cards.filter((e) => horizonBucket(e.nextAt, now) === focus)
      : cards;

  // ── The number ─────────────────────────────────────────────────────────
  // One pass over exactly the pool above. `horizon.total` is `standingTotal`
  // by construction, not a second count that has to agree with it — which is
  // the whole repair: three readings of this saying 13, 8 and 2 about one set
  // of rows is what three copies of the edge produce.
  const horizon: ScheduleHorizon = { soon: 0, day: 0, twoDay: 0, week: 0, later: 0, unarmed: 0, total: 0 };
  for (const at of [...cards.map((e) => e.nextAt), ...live.map((i) => i.nextAt), ...pending.map((p) => p.entry.nextAt)]) {
    horizon.total++;
    horizon[horizonBucket(at, now)]++;
  }
  const kinds = { rules: cards.length, timed: live.length + pending.length };

  return {
    cards, spentCards, shownCards, pendingCards,
    live, gone, shown, pending, goneByRepo,
    horizon, kinds,
    standingTotal: horizon.total,
    shownTotal: shownCards.length + shown.length + pending.length,
  };
}

/**
 * **Which repos a card fires in.** A `backlog` rule names one; a `fanout` sweep
 * names every repo it sweeps, and it genuinely fires in each one of them — so
 * it is counted on each, which is not one list counted twice but one rule that
 * is true of several repos. `ScheduleEntry` carries no `cwd`: the repo lives in
 * the action, and this is the only place that is read out.
 */
export const entryDirs = (e: ScheduleEntry): string[] =>
  e.action.kind === "fanout" ? e.action.dirs : [e.action.repoDir];

/** One repo's share of the standing clocks: the ids the tap opens, and the same
 *  bucketing the launcher chip's number is made of. */
export interface RepoClocks { ids: string[]; horizon: ScheduleHorizon }

/**
 * **Every standing clock, grouped by the repo it fires in — the per-repo chip's
 * number AND the cut its tap opens.**
 *
 * The host-wide chip answers *what fires on a clock on this desktop*; standing
 * beside eleven repo rows it cannot answer *what fires on a clock in THIS one*,
 * which is the question a person asking about a repo has. So the same pool
 * `clockCuts` already produced — cards, directory lines and this phone's queued
 * saves alike — is grouped here rather than re-cut: a second walk over
 * `intents` with its own copy of the standing test is exactly what said
 * **13 · 8 · 2** about one set of rows, and a per-repo copy of that edge would
 * be eleven more chances to say it.
 *
 * `repoOf` maps a directory to the name the launcher groups under (a worktree
 * and its primary checkout are one repo), and a row whose directory maps to
 * nothing is left out rather than filed under a guess.
 */
export function clocksByRepo(o: {
  cuts: ClockCuts;
  repoOf: (dir: string) => string | null;
  now: number;
}): Map<string, RepoClocks> {
  const { cuts, repoOf, now } = o;
  const m = new Map<string, RepoClocks>();
  const add = (dirs: readonly string[], id: string, at: number | null | undefined) => {
    const names = new Set<string>();
    for (const d of dirs) { const n = d ? repoOf(d) : null; if (n) names.add(n); }
    for (const name of names) {
      let r = m.get(name);
      if (!r) { r = { ids: [], horizon: { soon: 0, day: 0, twoDay: 0, week: 0, later: 0, unarmed: 0, total: 0 } }; m.set(name, r); }
      r.ids.push(id);
      r.horizon.total++;
      r.horizon[horizonBucket(at ?? null, now)]++;
    }
  };
  for (const e of cuts.cards) add(entryDirs(e), e.id, e.nextAt);
  for (const i of cuts.live) add([i.cwd], i.id, i.nextAt);
  for (const p of cuts.pending) add(entryDirs(p.entry), p.entry.id, p.entry.nextAt);
  return m;
}

/**
 * What the Schedules filter bar says when a repo's chip opened it —
 * `scheduleRuleLabel`'s reason: the words on the control and the words on the
 * list it opens are one claim, and only the caller knows which side was tapped.
 */
export function repoClocksLabel(repoName: string, n: number): string {
  return `the ${n} on a clock in ${repoName}`;
}

/**
 * The receipt for deleting a schedule — and the queue rows that named it,
 * which go with it (a queued `schedule.run` names a rule about to stop
 * existing). One wording for the two doors that delete one: the Schedules
 * card and the Activity row.
 */
export function scheduleRemovedToast(queueRows: number): string {
  return queueRows
    ? `schedule deleted — and ${queueRows === 1 ? "the queue row that named it" : `${queueRows} queue rows that named it`}`
    : "schedule deleted";
}
