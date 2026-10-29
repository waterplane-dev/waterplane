/**
 * The GROUPS a backlog row with a clock belongs to: its clock's words, its seat in that
 * clock's queue, and the directory's labels.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, BacklogStatus } from "@waterplane/shared";
import { clockKey, describeRule } from "@waterplane/shared";
import { inWords } from "../sendIntent.ts";

/**
 * ── A backlog row that carries a CLOCK ───────────────────────────────────────
 *
 * **Recurrence, not trigger kind, decides which list a row lives in.** A
 * standing rule is a thing to arm, pause and skip, and it lives in Schedules. A
 * one-off aimed at one place is waiting work whose WHEN happens to be an
 * instant — it is spent by its one run, there is nothing left to arm afterwards,
 * and it belongs in the repo's backlog with every other piece of waiting work.
 * `isTimedWorkRow` in `@waterplane/shared` is that cut; `BacklogItem.at` is what it
 * puts on the wire.
 *
 * Measured, on this desktop: nine live `at` rows, every one of them a one-off,
 * zero recurring — seven of them `failed`, in no backlog, where nobody grooming
 * the list ever saw them. That is the whole reason
 * these sentences exist.
 *
 * They are HERE, beside the filter rules, for `ageBucket`'s reason: the chip on
 * the row, the title on the verb and the label on the cut the Schedules
 * directory opens are claims about one row, and a second copy of any of them is
 * how a tap starts describing something else. Pinned by
 * `backlogFilter.test.mjs` — in this repo the strings ARE the deliverable.
 */
export type BacklogClock = NonNullable<BacklogItem["at"]>;

/**
 * The row's clock, in the rule's own words.
 *
 * `describeRule` is `@waterplane/shared`'s and is never re-worded here — the Send
 * sheet, the schedule card and this chip all say one rule one way, and
 * SendSheet's own note ("never re-word a rule `describeRule` already spells")
 * is the same rule stated one file over.
 *
 * Two clauses are added on top of it, and only two, because only two are facts
 * about the OCCURRENCE rather than about the rule:
 *
 *  - `· next in 2h` when an instant is armed. Relative, not a wall clock: this
 *    is read inside a list of waiting work where every other time on the row
 *    ("added 3d ago", "took 4m") is relative too. Only on a row still
 *    `queued`: the host leaves `nextAt` on a row after it fires (it is the
 *    instant it fired AT), so a `done` row read "next due now" a fortnight
 *    after it ran — a clock contradicting the verdict beside it.
 *  - `· waiting for a usage reading` when the rule is anchored to a usage
 *    WINDOW and nothing is armed yet. That is the ordinary first state of such
 *    a rule and it is not "not armed" in the sense of switched off — the host
 *    arms it on its first scrape. Said only on a row that is still queued: on a
 *    row that has been and gone it would describe a future that is not coming.
 *
 * Anything else prints the rule alone. A `once` whose instant has passed says
 * so through `describeRule` and through the row's own `failed` verdict; a
 * second sentence inventing a reason would be this file guessing.
 */
export function clockWords(at: BacklogClock, now: number, status: BacklogStatus): string {
  const rule = describeRule(at.rule);
  if (at.nextAt != null && status === "queued") return `${rule} · next ${inWords(at.nextAt, now)}`;
  if (at.rule.kind === "window" && status === "queued") return `${rule} · waiting for a usage reading`;
  return rule;
}

/**
 * ── Rows waiting on ONE clock, as a group ────────────────────────────────────
 *
 * Several items armed for the same instant are a QUEUE, and until this the
 * phone said nothing about it: twelve live one-offs on this desktop were all
 * armed for the same weekly reset, seven of them in one repo, and the only
 * answer to "which of these goes first" was to know that the host sorts on
 * `order ?? createdAt` and to compare creation times nobody is shown.
 *
 * So the group is a first-class thing here: `itemClockKey` says which rows are
 * on one clock, `clockGroups` puts them in run order, and the two sentences say
 * what the group is and where a row sits in it. The list's own order is the run
 * order, so the group is read off the list as it is given rather than sorted
 * again — a second sort here would be a second answer to "what runs first",
 * which is the whole complaint.
 *
 * **`clockKey` is `@waterplane/shared`'s**, the same function the host's merge rule
 * decides "the identical clock" with. A second spelling of it here would let
 * this sheet group two rows the pass would never sequence together, or split
 * two it would.
 */
export const itemClockKey = (it: BacklogItem): string | null =>
  it.at ? clockKey(it.at.rule, it.at.graceMin, it.holdForHost) : null;

export interface ClockGroup {
  key: string;
  /** The armed instant these share, or `null` when nothing is armed yet (a
   *  `window` rule with no usage reading). Never guessed. */
  at: number | null;
  /** Whether the whole group also waits for the desktop to be quiet. */
  hold: boolean;
  /** In RUN ORDER, which is the order the list was given in. */
  items: BacklogItem[];
}

/** Every clock group in `items`, in the order each first appears. */
export function clockGroups(items: readonly BacklogItem[]): ClockGroup[] {
  const out: ClockGroup[] = [];
  const byKey = new Map<string, ClockGroup>();
  for (const it of items) {
    const key = it.calledOff ? null : itemClockKey(it); // a call-off never runs: no seat
    if (!key) continue;
    let g = byKey.get(key);
    if (!g) {
      g = { key, at: it.at?.nextAt ?? null, hold: !!it.holdForHost, items: [] };
      byKey.set(key, g);
      out.push(g);
    }
    g.items.push(it);
  }
  return out;
}

/** Where one row sits in its own clock group — `null` for a row with no clock,
 *  and for the only row on its clock, which is not a queue. */
export function clockSeat(groups: readonly ClockGroup[], id: string): { idx: number; of: number } | null {
  for (const g of groups) {
    const idx = g.items.findIndex((it) => it.id === id);
    if (idx < 0) continue;
    return g.items.length > 1 ? { idx, of: g.items.length } : null;
  }
  return null;
}

const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
const ordinal = (n: number): string => ORDINALS[n - 1] ?? `${n}th`;

/**
 * Where this row is in the queue its clock makes — said on the ROW, because it
 * is the fact the list's order encodes and a phone reader cannot count down a
 * list of sixty to find.
 */
export function clockSeatWords(seat: { idx: number; of: number }): string {
  return `${ordinal(seat.idx + 1)} of ${seat.of} on this clock`;
}

/**
 * …and what the group is, once, above its rows.
 *
 * The instant, the count and the rule in `describeRule`'s own words — and the
 * host-wide hold when the group carries one, because that is the wait a reader
 * cannot infer from the rows in front of them. What it deliberately does NOT
 * say is "one at a time": `serial` is on every repo-target row, but a timed row
 * may be aimed at a named session, and a group holding one of those would be a
 * promise this sheet cannot keep. The ORDER is what the head claims, and the
 * rows under it are in it.
 */
export function clockGroupWords(g: ClockGroup, now: number): string {
  const n = g.items.length;
  const when = g.at != null
    ? `${inWords(g.at, now)} · ${new Date(g.at).toLocaleString()}`
    : "waiting for a usage reading";
  const rule = describeRule(g.items[0].at!.rule);
  return `${n} item${n === 1 ? "" : "s"} on one clock — ${rule} · ${when}${g.hold ? " · held until the desktop is free" : ""}`;
}

/** The order-within-the-group verbs, worded for a row that has a clock: what
 *  moves, and what deliberately does not. */
export const CLOCK_MOVE_NOTE =
  "moves it among the items waiting on this same clock — the instant does not change, "
  + "and it never crosses an item on a different clock";

/**
 * What the *on a clock* chip counts, and therefore what its tap opens.
 *
 * A count on a control is a filter: this is the ids the number is made of, so
 * the two cannot be two walks of the list.
 */
export const onClockIds = (items: readonly BacklogItem[]): string[] =>
  items.filter((it) => !!it.at).map((it) => it.id);

/**
 * **The Schedules sheet's directory of clocks, in the words of the tap.**
 *
 * A timed one-off is a backlog row, so Schedules does not hold it — but the
 * sheet is still the one host-wide view of everything with a clock on it, and a
 * row that leaves a screen without a door is a row somebody has lost. So the
 * sheet keeps a read-only line per timed item, and a line has exactly ONE
 * affordance: open it where it lives. A line that offered verbs would be the
 * second home this whole change exists to remove.
 *
 * These two are the `idsLabel` the Backlog's filter bar then says, for
 * `scheduleItemsLabel`'s reason: the words on the control and the words on the
 * list it opens are one claim.
 */
export function onClockLabel(repoName: string): string {
  return `on a clock in ${repoName}`;
}
export function goneOnClockLabel(repoName: string): string {
  return `been and gone on a clock in ${repoName}`;
}
