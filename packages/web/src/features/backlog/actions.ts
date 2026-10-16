/**
 * Every writer of the backlog feature's stores, and every frame it sends that
 * is more than one line in a sheet's prop list.
 */
import type { AssessChoices, AssessRun, AssessScope, HostMessage, Intent, RepoTarget } from "@waterplane/shared";
import { RUN_AGAIN_LABEL, RUN_AGAIN_TOAST, runAgainToast } from "../../backlogFilter";
import { assessFiledSplit, assessFiledWords } from "../../assessRows";
import { saveSnap } from "../../localState";
import { LS } from "../../storage";
import { core, mapWith, mapWithout, type CoreApi } from "../../sdk";
import { onSlotAskList } from "../../slotAskStore";
import { slotCheckStart, slotCheckStartToast, type SlotCheck } from "../../slotCheck";
import { assessRunToast, runAgainQueuedToast } from "./logic";
import { assessBusy, assessRepo, assessRuns, assessScope, assessSlot, backlog, backlogFocus, backlogScope } from "./store";

// ── The host's pushes ────────────────────────────────────────────────

export function onBacklogList(msg: Extract<HostMessage, { t: "backlog.list" }>): void {
  const at = Date.now();
  backlog.set({
    items: msg.items,
    auto: msg.auto,
    waiting: msg.waiting ?? {},
    // Absent (or empty) is "nothing is being named", which is also what a
    // host predating the feature sends. Not snapshotted — see the store.
    naming: msg.naming ?? [],
    // Facts about this second, like `waiting`: never snapshotted.
    autoSlots: msg.autoSlots ?? null,
    snapAt: at,
  });
  // Snapshot so the sheet still renders (read-only) offline. `at` rides along
  // so an offline sheet can say how old its copy is.
  saveSnap(LS.snapBacklog, {
    items: msg.items, auto: msg.auto, idleMs: msg.idleMs, at,
  });
  // The slot check's ask waits for exactly this: the list holding a row a
  // timed send just made, on the clock that send set (`slotAskStore.ts`).
  onSlotAskList(msg.items);
}

/**
 * One repo's newest run, pushed on every state change — and on every live
 * progress reading, about every 1.5 s. **A chatty push nothing on screen reads
 * keeps `prev`**: the only surface that reads `progress` is the assess sheet,
 * so while it is not on top a progress frame for the same running run is
 * dropped. Never swallowed: a status TRANSITION, a different `runId`, a `null`
 * run (discarded), a repo this map has never heard of, or anything at all while
 * the sheet IS open. Stale is not reachable: `openAssessFor` re-asks on open.
 */
export function onAssessState(repoDir: string, run: AssessRun | null): void {
  const overlay = core().nav.overlay;
  assessRuns.set((prev) => {
    const cur = prev.get(repoDir);
    if (run && cur && overlay !== "assess"
      && cur.runId === run.runId
      && cur.status === "running" && run.status === "running") return prev;
    return run ? mapWith(prev, repoDir, run) : mapWithout(prev, repoDir);
  });
}

/** On (re)connect: which repos have an assessment, and in what state. Asked
 *  rather than pushed on hello — a proposal carries every judged item in full,
 *  and a device that never opens the sheet should not be sent one. */
export function askAssessStates(): void {
  // eslint-disable-next-line local/no-silent-send -- welcome-only: runs from the welcome handler, nobody tapped anything
  core().conn.send({ t: "assess.state" });
}

/** One writer, so the busy map cannot say two things (see the store). */
function noteAssessOp(ackId: string, noteIds: string[]): void {
  assessBusy.set(mapWith(assessBusy.get(), ackId, noteIds));
}

/**
 * **The receipt for a live assess op — and the pad notes an apply owes, cleared
 * HERE and never on the tap.** App's `op.ack` calls this with every ack; an ack
 * that is not ours is ignored.
 *
 * The host posted the rows carrying the notes' own words and never touches the
 * pad. So the moment it is true that the words exist somewhere else is the
 * moment the desktop says it took the apply — and only the notes the ack NAMES
 * (`ticked ∩ msg.filed`): the host's loop carries on past a refused row and
 * still answers `ok`, and an ack with no `filed` (an older desktop) clears
 * NOTHING. `!ok` moves nothing. If the socket dies between the apply and this
 * receipt, the row exists AND the note stays: two visible copies, never a loss.
 *
 * `removePadNotes` is App's (`outbox.ts`, the one pad delete, which writes a
 * tombstone so the delete travels) — passed in because a feature cannot reach it.
 */
export function onAssessAck(ackId: string, ok: boolean, filed: string[] | undefined,
  removePadNotes: (ids: readonly string[]) => void): void {
  const notes = assessBusy.get().get(ackId);
  if (notes === undefined) return;
  assessBusy.set(mapWithout(assessBusy.get(), ackId));
  if (!ok || !notes.length) return;
  const split = assessFiledSplit(notes, filed);
  if (split.clear.length) removePadNotes(split.clear);
  const said = assessFiledWords(split);
  if (said) core().say.toast(said);
}

// ── Doors ────────────────────────────────────────────────────────────

/**
 * The backlog sheet, scoped to a repo named on the LAUNCHER. Behind "⋯" rather
 * than on the header strip, deliberately: a run reads a whole repo, and one tap
 * deeper answers reachability without making it a thing you can fat-finger.
 */
export function openBacklogFor(repo: RepoTarget): void {
  backlogScope.set(repo.worktreePath);
  backlogFocus.set(null);
  core().nav.open("backlog");
}

/** The backlog on a repo (the session's, the compose badge's) without touching
 *  any cut — or on the sheet's own preference when `cwd` is null. */
export function openBacklogIn(cwd: string | null | undefined): void {
  if (cwd) backlogScope.set(cwd);
  core().nav.open("backlog");
}

/**
 * **Open the backlog on an explicit cut, from anywhere.** A count on a control
 * is a filter across a sheet boundary too: a schedule card's "1 item" and a
 * *Backlog groomed* notification both land on exactly those rows. A FRESH
 * object every call, because `Backlog` re-applies on identity — tapping the
 * same link twice after clearing the filter must filter again. App binds
 * `nav.openBacklogCut` to this.
 */
export function openBacklogCut(cwd: string, ids?: string[], label?: string): void {
  backlogScope.set(cwd);
  backlogFocus.set(ids?.length ? { ids, label: label ?? "made from these" } : null);
  core().nav.open("backlog");
}

/** The sheet stopped being on top: the cut was the tap, not a setting. */
export function clearBacklogFocus(): void {
  backlogFocus.set(null);
}

/**
 * The assessment sheet, and — only when there is nothing to read — the run that
 * fills it. A repo with a run (including one working right now, exactly when
 * you want to look) opens the sheet and spends nothing; the sheet's own
 * *run again* is the way to spend a second run, with the proposal on screen.
 */
export function openAssessFor(repo: RepoTarget, ids?: string[]): void {
  const c = core();
  const dir = repo.worktreePath;
  assessRepo.set(repo);
  assessScope.set(ids?.length ? ids : null);
  assessSlot.set(null);
  // Ask for this repo specifically: the connect-time sweep only carries repos
  // that already had a run, and this may be the first.
  c.conn.liveAsk({ t: "assess.state", repoDir: dir });
  c.nav.open("assess");
  if (assessRuns.get().get(dir)) return;
  runAssessment(dir, ids);
}

/**
 * Start one. `assess.run` is durable on the wire (a retry that arrived twice
 * would pay twice for an agent reading a whole repo) but is sent LIVE rather
 * than queued: a tap with no link is refused with a sentence instead of being
 * replayed into a repo whose state has moved on by the time it flushes.
 */
export function runAssessment(repoDir: string, ids?: string[], scope?: AssessScope | null): void {
  const c = core();
  c.say.track("action:assess.run");
  const ackId = c.queue.mintAckId();
  // `ids` is the CUT the caller asked about; omitted entirely when there is
  // none, so an unfiltered run is byte-identical to what this always sent.
  const scoped = ids?.length ? ids : undefined;
  // A slot check names its slot as well as its ids (`AssessScope`); the host
  // re-derives the slot from its own rows and refuses a stale one in words.
  const slot = scoped && scope ? { scope } : {};
  if (!c.conn.liveSend({ t: "assess.run", repoDir, ids: scoped, ...slot, ackId, firstSentAt: Date.now() }, assessRunToast(scoped),
    "no connection — the assessment runs on the desktop")) return;
  // A run owes the pad nothing: it only ever reads.
  noteAssessOp(ackId, []);
}

/**
 * Apply the ticked decisions. Durable on the wire, live on this side: applying
 * starts work against a proposal that has to still be the current one.
 *
 * The pad notes this apply is about to file are remembered against the RECEIPT
 * (`onAssessAck`): an OFFER is a pad note copied verbatim into `proposal.news`
 * carrying its id in `fromNote`, and `choices.news` indexes that array (offers
 * APPENDED, so the indices keep their meaning) — the ids cleared are exactly
 * the ids posted.
 */
export function applyAssessment(run: AssessRun, choices: AssessChoices): void {
  const c = core();
  c.say.track("action:assess.apply");
  const ackId = c.queue.mintAckId();
  const ticked = choices.news ?? [];
  const noteIds = (run.proposal?.news ?? [])
    .filter((n, i) => ticked.includes(i) && n.fromNote)
    .map((n) => n.fromNote as string);
  if (!c.conn.liveSend({ t: "assess.apply", runId: run.runId, choices, ackId, firstSentAt: Date.now() }, "applying your decisions…",
    "no connection — applying starts work on the desktop and can't be queued from here")) return;
  noteAssessOp(ackId, noteIds);
}

/**
 * **The slot check** — the assessment, scoped to one slot: exactly `c.ids`,
 * named `c.scope`. From the backlog's *check these N* and the ask after a
 * timed send. Never replaces a proposal somebody has not decided, never starts
 * a second run beside a running one (`slotCheckStart`): those open the sheet,
 * and its run button is the slot check.
 */
export function openSlotCheck(c: SlotCheck): void {
  const k = core();
  const repo = k.world.repos.find((r) => r.worktreePath === c.repoDir) ?? k.world.repoForCwd(c.repoDir);
  if (!repo) { k.say.toast("that repo is not on this desktop's list any more"); return; }
  const dir = repo.worktreePath;
  assessRepo.set(repo);
  assessScope.set([...c.ids]);
  assessSlot.set(c.scope);
  k.conn.liveAsk({ t: "assess.state", repoDir: dir });
  k.nav.open("assess");
  const start = slotCheckStart(assessRuns.get().get(dir), c);
  if (start === "run") { runAssessment(dir, c.ids, c.scope); return; }
  const said = slotCheckStartToast(start, c.ids.length);
  if (said) k.say.toast(said);
}

/** The assessment sheet's own close — the one place its scope is cleared. */
export function closeAssess(): void {
  assessRepo.set(null);
  assessScope.set(null);
  assessSlot.set(null);
  core().nav.close("assess");
}

// ── The two DURABLE backlog verbs ────────────────────────────────────

/**
 * **Put a failed row back in the queue** — `queueOp`, not `liveSend`: the host
 * refuses anything that is not still `failed`, AT THE `failedAt` THE TAP SAW, so
 * a late delivery either finds the row as it was left or is refused (and that
 * refusal is toasted by App's `op.ack`). The lane is the row's own.
 */
export function runAgain(id: string, failedAt: number | undefined): void {
  const c = core();
  const i = c.world.intents.find((x) => x.id === id);
  const offline = requeue(c, id, failedAt, i);
  c.say.toast(offline ? "queued — it goes back in the queue when the link is back" : RUN_AGAIN_TOAST);
}

/** The same op over a cut, and **one receipt for one tap**. Each row names its
 *  own failure — the instants the sheet DREW, never a fresh lookup. */
export function runAgainMany(rows: readonly { id: string; failedAt?: number }[]): void {
  const c = core();
  let offline = false;
  for (const { id, failedAt } of rows) {
    const i = c.world.intents.find((x) => x.id === id);
    offline = requeue(c, id, failedAt, i) || offline;
  }
  c.say.toast(offline ? runAgainQueuedToast(rows.length) : runAgainToast(rows.length));
}

function requeue(c: CoreApi, id: string, failedAt: number | undefined, i: Intent | undefined): boolean {
  return c.queue.queueOp({ t: "intent.requeue", id, failedAt }, `intent:${id}`, i?.label || i?.title || RUN_AGAIN_LABEL, { cwd: i?.cwd });
}
