/**
 * ALL the sheet's state, effects and handlers, in the original declaration order.
 * No hook may move into a region component: a child's effects run before its parent's.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { assessCounts, assessNameCount, type AssessItem, type AssessVerdict } from "@waterplane/shared";
import { assessApplyBlocker, assessApplyLabel, assessApplySummary, assessBulkLines, assessGroups, assessGuide, assessMergeLines, assessPickedCount, assessRunBlocker, assessWatch, assessReadyCut, type AssessBulkWords, type AssessGroup, type AssessMergeCard } from "../assessRows";
import { dropPicks, loadPicks, savePicks } from "../assessPicks";
import { askConfirm } from "../Confirm";
import { track } from "../usage";
import { useNow } from "../useNow";
import type { ResourceState } from "../useRemoteResource";
import type { AssessSheetProps } from "./asxTypes";

export function useAssessSheet(p: AssessSheetProps) {
  const run = p.run;
  const proposal = run?.proposal ?? null;
  /**
   * The words, from the run itself.
   *
   * An id the input does not carry still renders — as a row that SAYS its words
   * are not on this phone, never as a bare id and never hidden — because a
   * verdict about words we cannot show is exactly the thing a person needs
   * told, and the host applies by id and still has them.
   */
  const items: readonly AssessItem[] = useMemo(() => run?.input?.items ?? [], [run]);

  const runId = run?.runId;

  /**
   * The approvals, and the explicit refusals.
   *
   * Kept apart on purpose. Not-accepted and REJECTED look the same to
   * `applyAssessment` — neither does anything — but they are different to the
   * person: one is a row not read yet, the other is a decision already taken.
   * Only the first set ever reaches `onApply`; the second exists so a list of
   * sixty can be worked through without losing your place in it.
   *
   * **Seeded from `assessPicks.ts`, not from empty.** `App` returns early once
   * per overlay, so this sheet UNMOUNTS whenever anything is opened from it —
   * the plan, an item where it lives, and now a picture — and every tick taken
   * on the way down a list of sixty went with it. The store is in memory, per
   * tab, keyed by run: the ticks outlive the component and nothing else.
   */
  const [pickedRows, setPickedRows] = useState<ReadonlySet<string>>(() => new Set(loadPicks(runId ?? "")?.rows ?? []));
  const [pickedMerges, setPickedMerges] = useState<ReadonlySet<string>>(() => new Set(loadPicks(runId ?? "")?.merges ?? []));
  const [pickedNews, setPickedNews] = useState<ReadonlySet<number>>(() => new Set(loadPicks(runId ?? "")?.news ?? []));
  const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set(loadPicks(runId ?? "")?.rejected ?? []));
  /** Strips the user has toggled away from their default. Not remembered: it is
   *  where you are looking, not anything you decided. */
  const [flipped, setFlipped] = useState<ReadonlySet<AssessVerdict>>(() => new Set<AssessVerdict>());

  /**
   * A new run is a new proposal: keeping ticks across it would apply one run's
   * approvals to another run's verdicts, which is `settle.ts`'s `spendTurn`
   * problem — evidence that belongs to somebody else.
   *
   * Guarded on the id it has already seen, because this effect also fires on
   * MOUNT and would otherwise wipe the picks the initialisers just read back —
   * which is the whole feature. The retired run's picks are dropped as it goes,
   * so a tab that watched six runs is not holding six sets of dead ticks.
   */
  const seeded = useRef(runId);
  useEffect(() => {
    if (seeded.current === runId) return;
    const gone = seeded.current;
    seeded.current = runId;
    if (gone) dropPicks(gone);
    setPickedRows(new Set<string>());
    setPickedMerges(new Set<string>());
    setPickedNews(new Set<number>());
    setRejected(new Set<string>());
    setFlipped(new Set<AssessVerdict>());
  }, [runId]);

  const groups = useMemo(
    () => (proposal ? assessGroups(proposal, items) : []),
    [proposal, items],
  );
  const counts = useMemo(() => (proposal ? assessCounts(proposal) : null), [proposal]);
  const itemsById = useMemo(() => {
    const m = new Map<string, AssessItem>();
    for (const it of items) if (it?.id) m.set(it.id, it);
    return m;
  }, [items]);

  /**
   * **A clock, because this screen is watched while nothing arrives.**
   *
   * A run takes up to twenty minutes and the host pushes a reading every second
   * or two; between two of those the elapsed time still has to move, or a
   * person looking at a frozen "4m" has no way to tell a slow run from a dead
   * socket. It ticks every second only while a run is going — a settled sheet
   * is a document and re-rendering it once a second is spending a phone's
   * battery to change nothing.
   */
  const now = useNow(run?.status === "running" ? 1000 : 60_000);
  const watch = assessWatch(run, now);
  /** The steps a settled run took, kept: "what did it actually look at" is the
   *  first question a surprising proposal raises. */
  const [logOpen, setLogOpen] = useState(false);
  const pastSteps = run && run.status !== "running" ? run.progress : undefined;

  const picked = assessPickedCount({ rows: pickedRows, merges: pickedMerges, news: pickedNews });
  /**
   * **How this screen works, said before anybody taps.**
   *
   * Reported, by somebody holding the sheet for the first time: they could not
   * tell what `accept` would do — *"Run someone for implementation?"* — and so
   * *"just clicked accept for all"*, which is a person approving eighty-four
   * retirements to find out what the button meant. Every other sentence here
   * answers a row; this one answers the screen.
   *
   * **Shut.** It used to open whenever nothing was ticked, which sounds like
   * "open for the person who has not decided yet" and is in fact "open for
   * everybody, always": nothing is ticked when the sheet mounts, so the state
   * every single person lands in was four paragraphs standing between them and
   * the rows. What answers them at a glance — a proposal, and nothing here
   * builds, runs or sends anything — is `guide.lead`, which is not behind this
   * toggle at all; what is behind it is the detail of each verb, which is worth
   * a tap and is not worth the screen.
   *
   * Never persisted, for the reason it never was: this screen is used rarely
   * enough that a remembered dismissal would mean the next person to meet it is
   * the next person not to be told.
   */
  const [guideOpen, setGuideOpen] = useState(false);
  const applyBlocked = assessApplyBlocker({ run, picked, online: p.online, busy: p.busy });
  const runBlocked = assessRunBlocker({ run, online: p.online, busy: p.busy, budgetNote: p.budgetNote });
  /** How many rows the NEXT run would be scoped to; 0 is "the whole repo". */
  const scopeN = p.scope?.length ?? 0;
  /**
   * **How many items this apply would give a position to**, which is what makes
   * the ordering question worth asking — or not worth drawing at all.
   *
   * Ticked `wanted` rows that carry a rank, plus every approved merge and new
   * item, because a posted row takes its place in the same ordering. With none
   * of them the apply writes no order and the question would be chrome about
   * something that cannot happen.
   */
  const rankedN = useMemo(() => {
    if (!proposal) return 0;
    const rows = proposal.rows.filter((r) => r.verdict === "wanted" && r.rank != null && pickedRows.has(r.id)).length;
    return rows + pickedMerges.size + pickedNews.size;
  }, [proposal, pickedRows, pickedMerges, pickedNews]);
  /**
   * **The answer, asked once per apply and never remembered.**
   *
   * Not persisted and not a setting, for the reason every filter in this app is
   * cleared with its overlay: it is a decision about THIS ordering, made by
   * somebody who has just read it. A remembered answer would apply an old
   * judgement to a proposal they have not seen yet — and the expensive
   * direction (silently freezing a repo the smart pick is grooming) is exactly
   * the one a stale default would pick.
   *
   * It starts on `true`: the person is about to approve this order row by row,
   * so "it stays" is the reading of the tap they are making. The alternative is
   * one tap away and says what it does.
   *
   * It rides with the ticks across a side trip for the same reason they do —
   * this is a decision about THIS proposal, and re-opening the sheet after
   * looking at the plan is not a new proposal.
   */
  const [pinRanks, setPinRanks] = useState(() => loadPicks(runId ?? "")?.pinRanks ?? true);
  /**
   * **How many things this run has something to CALL** — the number the naming
   * question is asked about, and the one that decides whether it is asked.
   *
   * `@waterplane/shared`'s, never re-counted here: the host words the same question
   * on its own side, and a second arithmetic is how a screen comes to ask about
   * fourteen items and apply nine.
   */
  const nameCount = useMemo(() => (proposal ? assessNameCount(proposal) : 0), [proposal]);
  /**
   * **Do the run's titles go on the rows?** `pinRanks`' shape and every one of
   * its reasons, about the other thing this apply would write.
   *
   * It starts on `write`: a title is the cheapest thing on this screen to be
   * wrong about — one tap on the row edits or clears it, and a typed one is
   * never touched at all — while an un-named backlog is the state somebody
   * opened this sheet to get out of. The alternative is one tap away and says
   * what it does.
   */
  const [writeNames, setWriteNames] = useState(() => loadPicks(runId ?? "")?.writeNames ?? true);

  /**
   * Every decision on this screen, written back as it is made.
   *
   * One effect over all five rather than a write inside each toggle: the
   * toggles are functional updaters — the value they produce does not exist
   * until React has applied them — so saving from inside one would persist the
   * set as it was BEFORE the tap, which is the one state nobody chose.
   */
  useEffect(() => {
    if (!runId) return;
    savePicks(runId, {
      rows: [...pickedRows], merges: [...pickedMerges], news: [...pickedNews],
      rejected: [...rejected], pinRanks, writeNames,
    });
  }, [runId, pickedRows, pickedMerges, pickedNews, rejected, pinRanks, writeNames]);

  const toggleRow = (id: string) => {
    setPickedRows((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
    setRejected((s) => { const n = new Set(s); n.delete(`row:${id}`); return n; });
  };
  const toggleMerge = (gid: string) => {
    setPickedMerges((s) => { const n = new Set(s); if (!n.delete(gid)) n.add(gid); return n; });
    setRejected((s) => { const n = new Set(s); n.delete(`merge:${gid}`); return n; });
  };
  const toggleNew = (i: number) => {
    setPickedNews((s) => { const n = new Set(s); if (!n.delete(i)) n.add(i); return n; });
    setRejected((s) => { const n = new Set(s); n.delete(`new:${i}`); return n; });
  };
  const toggleReject = (key: string, un: () => void) => {
    setRejected((s) => {
      const n = new Set(s);
      if (!n.delete(key)) { n.add(key); un(); }
      return n;
    });
  };

  /**
   * The one bulk button a strip has, whatever it currently says.
   *
   * `assessBulkWords` decides whether there is a button at all and what it is
   * called — `null` for the strips where a bulk tap could mean nothing (merged,
   * unclear, a strip of pad notes), which is drawn as NO BUTTON rather than as a
   * dead one. Two things can happen behind it:
   *
   * - **accept all N.** The 84-row triage's rule, because it is the same danger:
   *   where `confirm` is set, the confirmation NAMES the repo and shows three
   *   REAL prompts before anything is ticked. Only the strips that take words
   *   away are behind it — a confirm on a harmless button (setting the order of
   *   the `wanted` set) is what teaches people to tap through the ones that do.
   * - **un-tick N.** The way back out of the tap above, and it takes nothing
   *   away that the same button cannot put back, so it asks nothing. It clears
   *   EVERY row on the strip, not only the acceptable ones, because "un-tick 12"
   *   that leaves two ticked is a count that lied.
   */
  const bulkGroup = (g: AssessGroup, bulk: AssessBulkWords) => {
    const rows = g.rows.filter((r) => !r.acceptBlocked);
    if (!rows.length) return;
    // Everything acceptable already ticked ⇒ the button is the un-tick, which is
    // the same condition `assessBulkWords` worded it from.
    if (rows.every((r) => pickedRows.has(r.id))) {
      track(`action:assess.untick.${g.verdict}`);
      setPickedRows((s) => { const n = new Set(s); for (const r of g.rows) n.delete(r.id); return n; });
      return;
    }
    track(`action:assess.bulk.${g.verdict}`);
    const tick = () => {
      setPickedRows((s) => { const n = new Set(s); for (const r of rows) n.add(r.id); return n; });
      setRejected((s) => { const n = new Set(s); for (const r of rows) n.delete(`row:${r.id}`); return n; });
    };
    // Held in a local because the narrowing does not survive the closure below —
    // and `ask` is present exactly when `confirm` is, so this is one condition
    // written twice rather than two conditions.
    const ask = bulk.ask;
    if (!bulk.confirm || !ask) { tick(); return; }
    void (async () => {
      // **The dialog's words are the BUTTON's words** — `assessBulkWords` builds
      // both off one verb. It used to ask "Accept N “done” in myapp?" under a
      // button reading `retire all N`, which put the word this whole screen was
      // rebuilt to stop using back in the last sentence before the tap.
      const ok = await askConfirm({
        title: ask.title,
        lines: assessBulkLines(rows, { repoName: p.repoName, verdict: g.verdict }),
        confirmLabel: ask.confirmLabel,
      });
      if (ok) tick();
    })();
  };

  const acceptMerge = (card: AssessMergeCard) => {
    track("action:assess.merge");
    if (pickedMerges.has(card.gid)) { toggleMerge(card.gid); return; }
    void (async () => {
      const ok = await askConfirm({
        title: `Replace ${card.originals.length || card.ids.length} items with one prompt?`,
        lines: assessMergeLines(card, { repoName: p.repoName }),
        confirmLabel: "Approve the merge",
      });
      if (ok) toggleMerge(card.gid);
    })();
  };

  const apply = () => {
    track("action:assess.apply");
    // `pinRanks` only when this apply actually writes an order — otherwise the
    // flag would be an answer to a question nobody was asked.
    p.onApply({
      rows: [...pickedRows], merges: [...pickedMerges], news: [...pickedNews],
      pinRanks: rankedN > 0 ? pinRanks : undefined,
      // `pinRanks`' rule: an answer only where the question was asked. With
      // nothing named, the flag would be an answer nobody was offered — and
      // absent is what every apply sent before the question existed.
      writeNames: nameCount > 0 ? writeNames : undefined,
    });
    // The ticks have become facts about the backlog. Keeping them would offer
    // the same decision a second time on the next open of this run.
    if (runId) dropPicks(runId);
  };

  const res = p.res ?? { state: (p.online ? (run ? "fresh" : "loading") : "offline") as ResourceState };
  const nothing = !proposal || !(proposal.rows.length + proposal.merges.length + proposal.news.length);
  const finishedAt = run?.finishedAt ?? run?.startedAt;
  const planPath = run?.planPath;
  /**
   * The apply button's own sentence, built from the decision and nothing else.
   *
   * Two calls rather than a label assembled here, for `clihealth.ts`'s reason:
   * the summary is the arithmetic (how many are retired, kept, posted) and the
   * label is the wording, both pinned by `node --test`, so the button and any
   * receipt that follows it cannot word one apply two ways.
   */
  const applySummary = proposal
    ? assessApplySummary(proposal, { rows: [...pickedRows], merges: [...pickedMerges], news: [...pickedNews] }, items)
    : null;
  /**
   * **BOTH answers ride on the label**, because the questions can be scrolled
   * past and the footer cannot.
   *
   * The switch decides whether the label SAYS the naming half, never what the
   * summary counted — see `AssessApplySummary.name`. `rankedN` does the same
   * job for the other question: it is what decides the question is asked, so it
   * is what decides the answer is restated. With the ranking half missing a
   * person could Apply having read the footer in full and never met the
   * decision at all.
   */
  const applyLabel = applySummary
    ? assessApplyLabel(applySummary, p.repoName, { writeNames: nameCount > 0 && writeNames, ranked: rankedN, pinRanks })
    : "";
  /**
   * **What the apply left waiting, and therefore what the route opens.**
   *
   * `null` until this run has actually been applied: before that the rows are a
   * proposal, and a control offering to show "what is waiting" would be
   * counting the backlog as it already was. `run.applied` is the host's own
   * record of the tap, so the route appears exactly when there is something to
   * have groomed — and it survives a reload, which the ticks deliberately do
   * not (`assessPicks.ts`). Also `null` with no caller to route to.
   */
  const ready = useMemo(
    () => (run?.applied && p.onOpenBacklog ? assessReadyCut(run, p.backlog ?? []) : null),
    [run, p.backlog, p.onOpenBacklog],
  );
  /** The scope the run button is about, as words — used twice: on the button,
   *  and as the label of the sentence that replaces it when it cannot run. */
  const runLabel = scopeN
    ? `${run ? "run again on" : "assess"} ${scopeN === 1 ? "this one" : `these ${scopeN}`}`
    : run ? "run again" : "assess";
  /** What the screen itself is for, from `assessRows.ts`. The count it leads
   *  with is the run's own `assessableCount`, falling back to the rows actually
   *  on screen — a guide that says "0 items" over a list of sixty is worse than
   *  one that says nothing. */
  const guide = assessGuide({
    repoName: p.repoName,
    judged: run?.assessableCount ?? proposal?.rows.length ?? 0,
    planPath: planPath || undefined,
    // One extra line, and only when this run named anything — the switch is at
    // the end of the scroll, and a decision first met at the bottom of a long
    // list is a decision taken without reading.
    named: nameCount,
  });

  return { p, run, proposal, items, runId, pickedRows, setPickedRows, pickedMerges, setPickedMerges, pickedNews, setPickedNews, rejected, setRejected, flipped, setFlipped, seeded, groups, counts, itemsById, now, watch, logOpen, setLogOpen, pastSteps, picked, guideOpen, setGuideOpen, applyBlocked, runBlocked, scopeN, rankedN, pinRanks, setPinRanks, nameCount, writeNames, setWriteNames, toggleRow, toggleMerge, toggleNew, toggleReject, bulkGroup, acceptMerge, apply, res, nothing, finishedAt, planPath, applySummary, applyLabel, ready, runLabel, guide };
}

/** What every region component reads. */
export type AssessModel = ReturnType<typeof useAssessSheet>;
