/**
 * Every list and every number the sheet draws, derived in one place per
 * render: the repo's rows, the archived base, the counts and the cut (one
 * `backlogCounts` / `matchesBacklogFilter` pair over `backlogFilter.ts`'s one
 * bucketing function), the search, the groups by where a row will run, `▶
 * next`, the focus breakdown, the bulk bars' ids, and the predicates over the
 * live sessions. A count on a control is a filter, so each number here is the
 * length of the list its control opens.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { BacklogItem } from "@waterplane/shared";
import { itemHeadline, repoBranchLabel, sessionPickLabel } from "@waterplane/shared";
import {
  assessableInCut, backlogCounts, clockGroups, focusRunWords, hasBacklogFilter, hiddenByArchive, matchesBacklogFilter,
  nameableInCut, realLabel, retimeEligible, clockPicks, runAgainAimedCount, runAgainEligible, runAgainIds, runAgainState,
  type BacklogFilter, type FocusRunBreakdown,
} from "../backlogFilter";
import { clockAhead as clockAheadAt, nextFireIdsOf, runGroupKey } from "../backlogFilter/nextFire";
import { autoSlotSessions } from "../autoSessions";
import { busyInCheckout } from "../sendIntent";
import { slotChecks } from "../slotCheck";
import { isSlotAskOff, onSlotAsk } from "../slotAskStore";
import { CLOSED_GROUP } from "./backlogLabels";
import type { BacklogProps } from "./backlogTypes";

/** One group of rows, by where they will run (see `groupKeyOf`). */
export interface BLGroup { key: string; title: string; running: boolean; items: BacklogItem[]; }

export function useBacklogCuts(
  p: BacklogProps,
  now: number,
  { text, repoDir, filter, showArchived }: { text: string; repoDir: string; filter: BacklogFilter; showArchived: boolean },
  picked: ReadonlySet<string>,
) {
  // The open automatic sessions, intersected with the live list — ONE list, so
  // the count on every row's control is the list that control opens.
  const slotSessions = useMemo(() => autoSlotSessions(p.autoSlots, p.sessions), [p.autoSlots, p.sessions]);
  // Computed once per render rather than inside the button: the same sentence is
  // the disabled test AND the tooltip, and two calls could disagree if the
  // caller's answer moved between them.
  const assessWhyNot = repoDir ? (p.cutVerbs.assessBlocked?.(repoDir) ?? null) : null;
  // Running sessions in the selected repo — the routing targets. cwd matches the
  // worktree path items are keyed by.
  const repoSessions = p.sessions.filter((s) => s.running && s.cwd === repoDir);
  /**
   * **The running sessions, as one set — the single reading of "is that
   * conversation still there".**
   *
   * Four things on this sheet asked that question and three of them asked it
   * with their own `p.sessions.some(...)`: the closed-target chip, the wait
   * line under it, and — through a copy of the whole eligibility edge —
   * whether a failed row wears *run it again*. It is one fact about the host's
   * live list, so it is read once and handed to the pure predicates in
   * `backlogFilter.ts`, which is where the sentences that depend on it live.
   *
   * Not scoped to `repoDir`: an item can only be aimed at a session in its own
   * checkout, but the question here is whether the id it names is ALIVE, and
   * narrowing the set would answer "closed" for a row the repo selector has
   * simply scrolled away from.
   */
  const liveSessionIds = useMemo(
    () => new Set(p.sessions.filter((s) => s.running).map((s) => s.id)),
    [p.sessions],
  );
  /**
   * **Which rows offer *run it again*** — `dropOffered`'s one-place rule, for
   * the other verb, and now genuinely one place.
   *
   * Three things on the row are drawn from this answer: the note under the
   * chips, the button, and — for the row it says no about — the sentence saying
   * why there is no button. This is `runAgainIds`' own predicate asked of a
   * single row, imported rather than restated: the previous copy here spelled
   * `failed && !at && !archived` a second time under a comment claiming it was
   * "not a second copy", which is how the bar could say nineteen over a list
   * where twenty rows wore the verb.
   *
   * No `p.online` in it, deliberately. `intent.requeue` is durable and the host
   * refuses it on any row that is not still `failed`, so the tap is safe from a
   * dead tunnel — which is the whole reason the message was made durable.
   */
  const runAgainOffered = (it: BacklogItem): boolean => runAgainEligible(it, liveSessionIds);
  /**
   * `fire`/`re-fire` skip the whole queue (`runNow`) — including *one at a
   * time*. So when another item in the same checkout is already running, a
   * tap would put a second agent in that worktree, and it ASKS first
   * (`SKIP_QUEUE_BUSY_CONFIRM`). Only a row that opens a session of its own
   * can start a second agent; one aimed at a session types into it.
   */
  const fireIntoBusy = (it: BacklogItem): boolean => !it.targetSessionId && busyInCheckout(it.repoDir, p.intents, it.id, p.sessions);
  /** …and the row this verb has to REFUSE in words: failed, no clock, not set
   *  aside, but aimed at a session that has gone. Nothing re-aims it, so a
   *  re-queue would only turn a stopped row into one that waits for ever. */
  const runAgainHeld = (it: BacklogItem): boolean => runAgainState(it, liveSessionIds) === "held-closed";
  /**
   * An item aimed at a session that has since closed.
   *
   * This used to be `canFire`, and it GATED the fire button: an item with no
   * open session in its repo could not be run at all, because there was one
   * shared conversation per repo and somebody had to open it first. Firing now
   * OPENS a session — for a REPO row.
   *
   * A row aimed at a SESSION is a different fact, and the chip used to state
   * the opposite of it: *"it runs in a new one instead"*. The host does no such
   * thing. `sessionBlocker` holds a `{kind:"session"}` row on `sessionGone` for
   * as long as the row exists, the only re-aim anywhere is the usage-limit
   * resurrection, and a hand `fire` resolves the same dead id. So the row is
   * HELD, it says so, and it gets a group head of its own rather than sitting
   * under *Each in a new session* looking like work that is about to start.
   */
  const targetClosed = (it: BacklogItem) =>
    !!it.targetSessionId && !liveSessionIds.has(it.targetSessionId) && !it.reopensConv;
  /**
   * …and the row that is aimed at a closed session and is NOT held by it: a
   * clock row that snapshotted the conversation (`BacklogItem.reopensConv`).
   * The process is gone and the conversation is not, so when its instant comes
   * round it opens a session of its own on that conversation and the words land
   * where they were aimed. Held and reopening are opposite promises, so they
   * are two predicates and two chips rather than one sentence hedging.
   */
  const targetReopens = (it: BacklogItem) =>
    !!it.targetSessionId && !liveSessionIds.has(it.targetSessionId) && !!it.reopensConv;
  /** …and it is still LIVE: what makes the wait line underneath a place to go
   *  rather than an obituary. */
  const targetLive = (it: BacklogItem) =>
    !!it.targetSessionId && liveSessionIds.has(it.targetSessionId);
  /**
   * The session behind this sheet, if it is one an item can actually be aimed
   * at: still running, and still known to the host.
   *
   * Re-checked against the live list rather than trusted from the prop — a
   * session can exit while a sheet is open, and a button offering to queue work
   * into a dead CLI is worse than no button.
   */
  const here = p.activeSession && p.sessions.some((s) => s.running && s.id === p.activeSession!.id)
    ? p.activeSession : null;
  /** …and it is in the repo this sheet is scoped to. The sheet can be opened
   *  from a REPO header (`backlogScope`) while a session in a different repo is
   *  the one on screen, and an item can only be aimed at a session in its own
   *  checkout — so the button is absent there, and the line at the top has to
   *  say that rather than promising a control that is nowhere on the page. */
  const hereInRepo = here && here.cwd === repoDir ? here : null;
  /** Already aimed at the session on screen, by a tap that said so. Both halves
   *  matter: a target without the flag is an item waiting on the GLOBAL switch,
   *  which is a different promise. */
  const queuedHere = (it: BacklogItem) => !!here && it.targetSessionId === here.id && !!it.autoFire;

  // Distinct repoDirs across items, labeled via matching RepoTarget when available.
  const repoLabel = (dir: string) => {
    const r = p.repos.find((r) => r.worktreePath === dir);
    return r ? repoBranchLabel(r) : dir.split(/[/\\]/).filter(Boolean).pop() || dir;
  };
  // Scope to the selected repo only — there is no combined "all repos" view.
  //
  // An IDS cut is the exception to the archived hide, and it has to be: every
  // original of a merge is archived, so "merged from 3" opening the default
  // base would show nothing at all — a count that describes an empty list is
  // the exact failure `backlogFilter.ts` exists to not have. The predicate
  // deliberately does not know about the view toggle (that would be two rules
  // in one function), so the choice of base is made here, once.
  //
  // The archived cut is `hiddenByArchive`, never a bare `!it.archived`: the
  // host archives a merged row that is still RUNNING when you put its originals
  // back, and a row that leaves the list mid-run is the one row on this sheet
  // that stops saying what happened to it.
  const inRepo = p.items.filter((it) => it.repoDir === repoDir);
  const base = filter.ids ? inRepo : (showArchived ? inRepo : inRepo.filter((it) => !hiddenByArchive(it)));
  // Status + age. Counted over `base` (never over the search results), so a chip
  // reading 4 opens four rows whether or not something is typed in the box.
  const counts = backlogCounts(base, filter, now);
  /** **The slot check's verb — one per slot with two or more waiting rows.**
   *  Off `inRepo`, never the cut on screen: N is exactly the ids the run reads
   *  (`slotChecks`), the same rows the host will find in that slot. */
  const slotCheckList = useMemo(() => slotChecks(inRepo, repoDir), [inRepo, repoDir]);
  /** Whether the ask after a timed send is off in THIS repo — the way back is drawn only then. */
  const slotAskOff = useSyncExternalStore(onSlotAsk, () => isSlotAskOff(repoDir));
  const filtering = hasBacklogFilter(filter);
  const cut = filtering ? base.filter((it) => matchesBacklogFilter(it, filter, now)) : base;
  // The draft field doubles as a search over THIS repo's items; Add turns the
  // same text into a new item for this repo.
  const q = text.trim().toLowerCase();
  // The title is part of what a search is over, because it is part of what is
  // on screen: a row titled *"flaky upload test"* over prose that never says
  // "flaky" was unfindable by the one word a person would type to find it.
  // `itemHeadline` and not `it.headline`, so the string searched is the string
  // shown — a typed label beats a derived title in both.
  const visible = q
    ? cut.filter((it) => `${itemHeadline(it) ?? ""} ${it.label ?? ""} ${it.text}`.toLowerCase().includes(q))
    : cut;
  const archivedCount = inRepo.filter((it) => it.archived).length;
  /** Every row this repo has, by id — what an ids chip needs to NAME the row on
   *  the other side of a merge. A row the host has since evicted is simply
   *  absent, and the chip then says the honest thing instead of a blank pair of
   *  quotes. */
  const byId = new Map(p.items.map((it) => [it.id, it]));
  /** What to call a row in one line: the label a person typed, else the first
   *  words of its own text. Never `label` on its own — `add()` fills that with a
   *  truncation, which `realLabel` is the rule for. */
  const nameOf = (it: BacklogItem) => realLabel(it) ?? (it.text.length > 40 ? `${it.text.slice(0, 40)}…` : it.text);
  /**
   * The rows a naming pass has in hand this second, as a set.
   *
   * Read once per render rather than `p.naming?.includes(...)` per row, and
   * scoped to nothing: the host sends the ids it is working on, which are this
   * desktop's, and a pass in another repo is still a pass — the bulk verb is
   * about THIS repo's rows, which is what `namingHere` answers.
   */
  const namingIds = useMemo(() => new Set(p.naming ?? []), [p.naming]);

  // ── Group this repo's items by WHERE THEY WILL RUN ─────────────────────
  // Each running session in the repo is its own queue (things a person aimed
  // there by hand, with *queue here*); everything else opens a session of its
  // own when it fires. The default group used to be called "Repo backlog
  // session", which named a shared conversation that no longer exists — and
  // which, while it did, nothing in this UI ever showed.
  // A row whose target has closed is its OWN group. It used to fall through to
  // `""` and sit under *Each in a new session*, which is a promise the host
  // never keeps for a session-target row: nothing re-aims it, so it waits
  // exactly where it is until a person does. It also fed `nextFireIds`, so the
  // default group's `▶ next` could point at a row that is never going to run.
  const repoSessionIds = new Set(repoSessions.map((s) => s.id));
  const groupKeyOf = (it: BacklogItem) => runGroupKey(it, repoSessionIds);
  const groups: BLGroup[] = [];
  const defaultItems = visible.filter((it) => groupKeyOf(it) === "");
  // A group is drawn only with rows in it: an empty head plus "Nothing aimed
  // at this session" per open session pushed the first row off the screen,
  // and routing is the row's own wait verb, never the group. `running`
  // is true because there is nothing left for it to wait on — a fresh item
  // needs no session to be open, it opens one.
  if (defaultItems.length) groups.push({ key: "", title: "Each in a new session", running: true, items: defaultItems });
  const closedItems = visible.filter((it) => groupKeyOf(it) === CLOSED_GROUP);
  if (closedItems.length) {
    groups.push({ key: CLOSED_GROUP, title: "Aimed at a session that closed", running: false, items: closedItems });
  }
  for (const s of repoSessions) {
    const items = visible.filter((it) => groupKeyOf(it) === s.id);
    if (!items.length) continue;
    // The desktop's own name for the conversation rides along
    // (`sessionPickLabel`): three sessions open in this repo headed three
    // groups all called `In <repo>`, and which item was waiting on which of them
    // was unanswerable from the sheet that routes them.
    groups.push({ key: s.id, title: `In ${sessionPickLabel(s)}`, running: true, items });
  }
  // Display order across all groups — the flat sequence drag-and-drop reorders.
  const displayOrder = groups.flatMap((g) => g.items);
  /** The pick list's three numbers, off the rows ON SCREEN: what could be
   *  ticked, what is, and therefore what the button sends. */
  const retimeable = displayOrder.filter(retimeEligible);
  const retimeIds = retimeable.filter((it) => picked.has(it.id)).map((it) => it.id);
  /**
   * **The rows waiting on each clock, in run order** — read off `base` and not
   * off the cut on screen.
   *
   * A row's seat in its clock's queue is a fact about the repo's run order, and
   * a filter must not be able to change it: "3rd of 7" counted over a filtered
   * list would say 2nd of 3 the moment somebody tapped *failed*, about a row
   * that had not moved. `base` is this repo's rows in the order the host runs
   * them, which is exactly the list the seat is about.
   */
  const clockCuts = useMemo(() => clockGroups(base), [base]);
  /** One pick per clock with two or more movable rows ON SCREEN — the
   *  "move all 20 waiting for the reset" tap (`clockPicks`). */
  const retimeClocks = clockPicks(clockCuts, retimeable);
  // In auto mode, each group's first queued item is what auto-fire picks next —
  // except the closed-target group, which is not a queue at all: nothing in it
  // fires until a person re-aims or un-queues it, so `▶ next` there would be
  // the same false promise the chip used to make.
  //
  // A row with a CLOCK is skipped too, and for the same kind of reason: it is
  // not next, its clock is. Auto-fire walks the queue in order and takes the
  // first row whose rungs all pass, and a timed row's first rung is its own
  // instant — so `▶ next` on one would promise a start at the top of the list
  // that the host will not make until, in the user's case, next Saturday. A row
  // whose instant has already come (`nextAt <= now`) is genuinely next and
  // keeps the mark.
  // A `manual` row (an agent's add) is never next either: nothing but its own
  // `fire` starts it, so it is held like a row whose clock is still ahead.
  // ONE predicate (`nextFireIdsOf`, `backlogFilter/nextFire.ts`), shared with
  // the Automation sheet's "N rows will start when free".
  const clockAhead = (it: BacklogItem) => clockAheadAt(it, now);
  const nextFireIds = nextFireIdsOf(displayOrder, repoSessionIds, p.auto, now);
  /**
   * **What the ids cut on screen is actually going to do** — the same facts
   * `nextFireIds` is derived from, counted once, for the one sentence that used
   * to be handed `cut.length` and a boolean.
   *
   * That is the bug this replaces: an ids base is `inRepo` and holds ARCHIVED
   * rows on purpose, so `merged from 3` (three archived originals, which never
   * starting is the whole point of) was told "3 rows" and answered *"these 3
   * start one at a time in this repo, each in a session of its own, in the
   * order you see"*. Every clause of that is decided here instead, off the same
   * predicates the `▶ next` mark uses — `groupKeyOf` for where a row runs and
   * `clockAhead` for whether it is next at all — so the sentence and the mark
   * cannot come to disagree about one row.
   *
   * Archived is `other` and not `held`: the host's `waiting()` skips an
   * archived row outright, so it is not waiting on anything, it is set aside.
   *
   * **There is no `blocked` here to test for.** `BacklogStatus` is
   * `queued | running | done | failed` and `intentToBacklogItem` flattens a
   * blocked intent to `queued` — the block is a SENTENCE on the row (`waiting`)
   * and not a state, because such a row is going to start once the rung clears.
   * So a held row is one whose target session CLOSED (nothing re-aims it) or
   * whose clock is still ahead (`▶ next` skips it for the same reason: it is not
   * next, its clock is).
   */
  const focusBreakdown: FocusRunBreakdown = { fresh: 0, aimed: 0, held: 0, other: 0 };
  for (const it of cut) {
    const gk = groupKeyOf(it);
    if (it.archived) { focusBreakdown.other++; continue; }
    if (it.status === "queued" && !clockAhead(it)) {
      if (gk === "") focusBreakdown.fresh++;
      else if (gk === CLOSED_GROUP) focusBreakdown.held++;
      else focusBreakdown.aimed++;
      continue;
    }
    if (it.status === "queued" && (clockAhead(it) || gk === CLOSED_GROUP)) focusBreakdown.held++;
    else focusBreakdown.other++;
  }
  /** The sentence itself, computed once: it is drawn below AND it decides
   *  whether the head's auto-off banner is drawn at all, and two calls that
   *  could drift would be two answers to "does this screen say auto is off". */
  const focusWords = filter.ids ? focusRunWords(focusBreakdown, p.auto) : null;
  /**
   * **The cut's clocks, as one tap.** Seven failed one-offs is seven taps of a
   * verb that says the same thing every time, and the cut on screen is already
   * exactly the set — the `failed` chip put it there.
   *
   * A COUNT ON A CONTROL IS A FILTER, so this number is the timed rows in the
   * CUT and the tap acts on exactly those; where the cut also holds rows with
   * no clock, `dropClocksNote` says how many were left alone rather than
   * letting "these 5" float over a list of seven. Drawn only on the `failed`
   * cut: that is the state the verb rescues, and a bulk mutation offered over
   * an unfiltered list is a bulk mutation nobody asked for.
   */
  const bulkClockIds = filter.status === "failed"
    ? cut.filter((it) => !!it.at).map((it) => it.id)
    : [];
  /**
   * **…and the OTHER half of the same cut: the failures with no clock.**
   *
   * The two verbs partition the `failed` list and never overlap — a row with an
   * instant is stuck because of the instant and wears *drop the clock*; a row
   * without one is stuck because it failed and wears *run it again*. The
   * predicate is `runAgainIds`, in `backlogFilter.ts` beside the sentence the
   * note says, so the number on the button and the rows it acts on cannot come
   * from two different readings of "eligible".
   *
   * A row aimed at a session that has CLOSED is out of it, on that same
   * predicate: nothing re-aims such a row, so putting it back would turn a
   * stopped row into one that waits for ever — and the bar would be counting it
   * as work it had rescued. The row says why itself (`runAgainClosedNote`).
   *
   * Drawn on the `failed` cut alone for `bulkClockIds`' reason, and — unlike
   * every other bulk bar here — NOT gated on the link: `intent.requeue` is
   * durable and the host refuses it on any row that is not still failed, so
   * this is the one bulk mutation that is safe to queue from a dead tunnel.
   */
  const bulkRunAgainIds = filter.status === "failed" ? runAgainIds(cut, liveSessionIds) : [];
  /** …and how many of those name a live session. The note above the button says
   *  where the words will land, and over a mixed cut that is two clauses, not
   *  one — the same partition, counted rather than guessed. */
  const bulkRunAgainAimed = filter.status === "failed" ? runAgainAimedCount(cut, liveSessionIds) : 0;
  /**
   * **The finished, cleared out in one tap.** Same rule as `bulkClockIds`, one
   * state along: drawn on the `done` cut alone, because over an unfiltered list
   * of sixty-two rows "archive these 5" is a number nobody can check against
   * what they can see. The `done N` chip is the one tap that gets here, and it
   * is the same tap that puts the five on screen.
   *
   * `hiddenByArchive` is deliberately NOT the test — that predicate answers
   * "does the archived hide keep this out of view", and with *show archived* on
   * it answers `false` for a row that IS archived. What this needs is the field
   * itself: archiving an already-archived row is a no-op the host would accept
   * silently, and the count on the button would then be describing work that
   * does not happen.
   */
  const bulkDoneIds = filter.status === "done"
    ? cut.filter((it) => !it.archived).map((it) => it.id)
    : [];
  /**
   * **What an assessment of the cut on screen would actually judge.**
   *
   * `assess.run` carries a scope now, so this button follows the list like
   * every other count here. The number is the rows a run can form a VERDICT
   * about — the finished and running ones go in as context either way and
   * `cleanAssessment` refuses a verdict naming one — which is why this is not
   * simply `cut`: a cut of five done rows has nothing to assess, and the button
   * is absent with a sentence rather than offering to spend an agent on it.
   */
  const assessIds = assessableInCut(cut);
  /**
   * **The rows in the cut that still have no title or no kind.**
   *
   * `assessIds`' rule, one verb along: a count on a control is a filter, so the
   * number on *name these N* is the rows the pass will touch in the list ON
   * SCREEN, and `nameNote` says what the rest are. Unlike the three bulk bars
   * above it this is drawn without a status filter — a backlog that has never
   * been named is every row of it, and the tap that fixes that must not require
   * guessing which chip to press first.
   */
  const nameIds = nameableInCut(cut);
  /** Is a pass holding any row of THIS repo? The verb is then absent and
   *  `NAME_RUNNING_NOTE` says so — never a dimmed button. Asked over the repo's
   *  rows rather than the cut, because a pass running on rows the current
   *  filter hides is still a pass this repo has in flight. */
  const namingHere = inRepo.some((it) => namingIds.has(it.id));
  return {
    slotSessions,
    assessWhyNot,
    repoSessions,
    liveSessionIds,
    runAgainOffered,
    fireIntoBusy,
    runAgainHeld,
    targetClosed,
    targetReopens,
    targetLive,
    here,
    hereInRepo,
    queuedHere,
    repoLabel,
    inRepo,
    base,
    counts,
    filtering,
    cut,
    q,
    visible,
    archivedCount,
    byId,
    nameOf,
    namingIds,
    groupKeyOf,
    groups,
    displayOrder,
    retimeable,
    retimeIds,
    clockCuts,
    retimeClocks,
    nextFireIds,
    clockAhead,
    focusBreakdown,
    focusWords,
    bulkClockIds,
    bulkRunAgainIds,
    bulkRunAgainAimed,
    bulkDoneIds,
    assessIds,
    nameIds,
    namingHere,
    slotCheckList,
    slotAskOff,
  };
}
