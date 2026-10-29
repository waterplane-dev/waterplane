/**
 * The backlog sheet's types: what `BacklogSheet` hands it (`BacklogProps`),
 * and the one model every region of the sheet reads (`BacklogModel`) — the
 * hooks' results spread together, built once per render by `Backlog.tsx`.
 * Shape: docs/notes/backlog-architecture.md.
 */
import type { AutoSlotFacts, BacklogItem, Intent, ItemCategory, RepoTarget, SessionBudget, SessionInfo } from "@waterplane/shared";
import type { BackendList } from "../backendCaps";
import type { CloseChoice } from "../autoSessions";
import type { RenderRetime } from "../RetimeBar";
import type { SlotCheck } from "../slotCheck";
import type { useBacklogCuts } from "./useBacklogCuts";
import type { useBacklogDraft } from "./useBacklogDraft";
import type { useBacklogDrag } from "./useBacklogDrag";
import type { useBacklogEdit } from "./useBacklogEdit";
import type { useBacklogFilters } from "./useBacklogFilters";
import type { useBacklogSort } from "./useBacklogSort";
import type { useBacklogUi } from "./useBacklogUi";

export interface BacklogProps {
  items: BacklogItem[];
  /** What this host described (null: it never said) — names a row's backend for the budget field's units. */
  backends?: BackendList;
  auto: boolean;
  repos: RepoTarget[];
  /**
   * The rows a naming pass is working on RIGHT NOW, by id — the host's own
   * list, straight off `backlog.list`.
   *
   * Transient exactly like `waiting`, and read for the same reason: while a
   * pass holds any row of this repo the bulk verb is ABSENT with a sentence
   * (`NAME_RUNNING_NOTE`), never a dimmed copy of itself, and each row it holds
   * says so on its own account. Absent ⇒ nothing is being named, which is also
   * what a host predating the feature sends.
   */
  naming?: string[];
  /**
   * The session on screen behind this sheet — the "here" in *queue here*.
   *
   * Null when there is none, when it is a session that does not exist yet (a
   * queued `session.create` has no id a host-side item can be aimed at), or when
   * it is not running. The button is then not rendered at all and the sheet says
   * why ONCE, at the top: a per-row sentence repeated down twenty rows is noise,
   * and the reason is the same reason every time.
   */
  activeSession?: { id: string; cwd: string; title: string } | null;
  /** Live sessions in view — what an item's own wait verb can be handed to. */
  sessions: SessionInfo[];
  /**
   * The person's global *close automatic sessions when done* (synced, off by
   * default) — what a row with no answer of its own follows, and what its
   * *as set globally* chip says it currently means.
   */
  closeWhenDoneGlobal: boolean;
  /**
   * The automatic-session cap as the host's facts — live only (`waiting`'s
   * reason). What a row held on a slot offers to make room from.
   */
  autoSlots?: AutoSlotFacts | null;
  /** The WHOLE intent store — what "another agent is working in this
   *  checkout" is asked over (`busyInCheckout`), the same list Activity asks
   *  it over. `items` is only the backlog's slice and misses a build or a
   *  launch running there. */
  intents: readonly Intent[];
  /** Repo to scope to on open (e.g. the session you came from). */
  defaultRepoDir?: string;
  /**
   * False while the socket is disconnected. `items` and `auto` are then
   * the last-synced snapshot (see App.tsx's `LS.snapBacklog`), not live —
   * so EVERY mutation control is disabled: fire/re-fire, edit, done, check,
   * validate, continue, next-step, swap/drag, archive and remove all reach the
   * host as bare `send()`s that the ws layer drops when it can't connect, and
   * they all act on state the snapshot may be minutes stale about ("done" on an
   * item the agent has since failed, an edit to text it has already run).
   * Adding is the one exemption, and it is not here any more: *+ send…* opens
   * the send sheet, whose post goes through the durable queue (outbox.ts) with
   * an ackId and applies exactly once when the link is back.
   */
  online: boolean;
  /**
   * Why each QUEUED item isn't running yet, keyed by item id — host-computed
   * (`BacklogManager.waiting()`), so it is the same ladder that decides, not a
   * second reading of it.
   *
   * Rendered only while `online`: every reason is a fact about a session RIGHT
   * NOW ("the session is working"), and the offline snapshot deliberately
   * doesn't carry it — a stale one would describe a session that has since
   * ended. Absent id ⇒ nothing to say (the item isn't queued, or is archived).
   */
  waiting?: Record<string, string>;
  /**
   * When the backlog snapshot under this sheet last came from the host.
   *
   * Read only while offline, and only by the last-look strip: the strip is the
   * one window onto an automatic spender, and "it merged two items" with no age
   * on it is a claim about right now made from a copy that may be a day old.
   * `null` ⇒ nothing to say, and the strip says nothing rather than guessing.
   */
  snapAt?: number | null;
  /**
   * **The cut this sheet was OPENED on** — an ids filter chosen somewhere else.
   *
   * Three doors need it and all three are the same rule: a schedule card saying
   * "the item it wrote" must open exactly that item, a *Backlog groomed*
   * notification must land on the rows it is about, and a count on any control
   * anywhere must open the list it counted. Without it those taps landed on the
   * whole repo for the reader to find the row by eye — which is the same
   * failure the `merged from N` chip exists to not have, made across sheets
   * instead of within one.
   *
   * Seeded into the filter on mount and whenever the tap changes, never merged
   * with whatever cut was left on screen: it is what the tap asked for. `label`
   * is what the filter bar then SAYS, for `idsLabel`'s reason — only the caller
   * knows which side it came from.
   */
  focusIds?: { ids: string[]; label: string } | null;
  /** Per-row verbs (`BacklogRowVerbs`). */
  verbs: BacklogRowVerbs;
  /** Whole-repo and whole-cut verbs (`BacklogCutVerbs`). */
  cutVerbs: BacklogCutVerbs;
  /** Doors out of the sheet (`BacklogNav`). */
  nav: BacklogNav;
}

/**
 * What a tap on ONE row asks for. Every one is live-only (`liveSend` + `BL_OFFLINE`)
 * except `onRunAgain`, which is durable — see each verb.
 */
export interface BacklogRowVerbs {
  onRemove: (id: string) => void;
  onFire: (id: string) => void;
  onDone: (id: string) => void;
  /**
   * `headline` and `category` ride here with the words and the label, and they
   * are the person TAKING A MACHINE'S NAME OVER: the host stamps `hand` on
   * whatever arrives, and a `hand` field is never written again by an
   * assessment or a naming pass. `""` clears the value AND its author, which is
   * "nobody has said" rather than "a person said nothing" — so a later pass may
   * name the row again. The client never sends an author: who wrote a name is
   * the host's claim to make, exactly as `handOrdered` is.
   */
  onUpdate: (id: string, patch: { text?: string; label?: string; repoDir?: string; targetSessionId?: string; headline?: string; category?: ItemCategory | "" }) => void;
  /**
   * **"When that session is free."** Aim an existing item at the session the
   * user is actually looking at, with the per-item auto-fire flag set, appended
   * to the bottom of that repo's queue — so tapping three items in a row runs
   * them in that order as the session goes idle between them.
   *
   * The verb used to be called *queue here*, which was a fourth name for the
   * decision the composer calls *When free*. Same post, same holder, same wait:
   * one name now, and the button says which session it means.
   *
   * `sessionId: ""` takes it back off: the target clears and the item goes back
   * to opening a session of its own. The reverse of a tap has to be a tap, or a
   * queue built by mistake can only be unpicked by editing rows.
   *
   * The same decision the compose bar's *when it's free* makes for words being
   * typed NOW, on words already written down — one holder, the desktop, in both
   * cases.
   */
  onQueueHere: (id: string, sessionId: string) => void;
  onSwap: (id: string, otherId: string) => void;
  onArchive: (id: string, archived: boolean) => void;
  onCheck: (id: string) => void;
  /** Deep validation: did the expected outcome happen + propose next steps. */
  onValidate: (id: string) => void;
  /** Fire a chosen validation next-step (by index) back into the item's CLI. */
  onNextStep: (id: string, step: number) => void;
  /** Open/resume a coding session seeded with the item's task + check/validate verdict. */
  onContinue: (id: string) => void;
  /** One row's own answer: `inherit` clears it (`backlog.update` with `null`).
   *  Allowed in any state — a running item's session is exactly the one a
   *  person may decide to keep. Live-only, like every mutation here. */
  onSetCloseWhenDone: (id: string, choice: CloseChoice) => void;
  /** "Flag for follow up when done" on this row — `backlog.update`, live-only. */
  onSetFlagWhenDone: (id: string, on: boolean) => void;
  /** Set, change or clear (`null`) the budget of a still-queued row's session — `backlog.update`, live-only. */
  onSetBudget: (id: string, b: SessionBudget | null) => void;
  /** Open an item's referenced image in the annotator (view + mark); marked result swaps the path. */
  onEditImage: (it: BacklogItem, relPath: string) => void;
  /**
   * **Take the clock off a timed row and leave the words.**
   *
   * A one-off with an instant is a backlog row like any other — the instant is
   * the only difference — and when that instant has gone by, the row is stuck
   * saying it missed something for ever: a one-off cannot be re-armed, and
   * `re-fire` runs it right now in a session of its own rather than putting it
   * back in the queue. This is the verb that puts it back in the queue: the
   * trigger becomes `idle`, the row becomes ordinary waiting work, and `auto`
   * and `serial` take it from there.
   *
   * It is the answer to the complaint this whole change comes from — seven
   * skipped scheduled items the user wanted run as ordinary queued work.
   *
   * A plain `liveSend`, never durable, for the reason every mutation on this
   * sheet is: a decision about a clock, replayed an hour late, is a decision
   * about a situation that has moved on. **Do not assert the resulting state on
   * this side** — the host kicks synchronously, so the row may be `blocked`
   * behind the ladder or already firing by the time the ack lands.
   *
   * `holdForHost` deliberately SURVIVES it: *wait until the desktop is free* is
   * something a person asked for about these words, not a property of the
   * clock, and the chip stays on the row saying so.
   */
  onDropClock: (id: string, status: "queued" | "failed") => void;
  /** Undo a budget waiver (`intent.waive`, `on: false`): the row waits for
   *  the usage budget again. Live-only, like every mutation on this sheet. */
  onHoldForBudget: (id: string) => void;
  /**
   * **Put a FAILED row back in the queue** — `onDropClock`'s sibling, for the
   * row that is stuck for the other reason.
   *
   * A failed row is terminal: the ladder never looks at it again and `auto` skips
   * it.
   * The only verbs this sheet had for one were `re-fire` — which starts an
   * agent THIS SECOND, past every rung — and the archive. Measured on the
   * desktop this was written on: 0 queued against 19 failed, so the list the
   * repo's agent is fed from was empty while nineteen live pieces of work sat
   * one state away from it.
   *
   * `intent.requeue`, and **durable**, which is the one mutation on this sheet
   * that is. Every other one is live-only because a decision replayed an hour
   * late is a decision about a situation that has moved on — and this one is
   * not, because the HOST refuses anything that is not currently `failed`. A
   * delivery an hour after the tap is therefore either still exactly what the
   * person meant or not applied at all, which is what makes the button worth
   * drawing with the tunnel down instead of greyed out with the reason in a
   * `title` nobody on a phone can read.
   *
   * **Do not assert the resulting state here**: the row goes back BEHIND the
   * ladder, so by the time the receipt is read it may be waiting on auto, on
   * the repo, or on the desktop. The honest receipt is about the QUEUE.
   *
   * `failedAt` is WHICH failure the tap was taken against — the row's
   * `finishedAt`, which is `Intent.settledAt` as this sheet was drawn with it.
   * "The row is still `failed`" is not what makes a late delivery safe, and
   * believing it was is the hole this closes: `failed` is a STATE, so a row
   * revived elsewhere, run, and failed a second time is still `failed` when an
   * hour-old frame lands. The host compares the two instants and refuses a
   * mismatch, which turns "it is probably still what they meant" into a fact.
   * Absent only where the row never carried one.
   */
  onRunAgain: (id: string, failedAt?: number) => void;
  /**
   * Change a timed row's clock — which is the SEND sheet, seeded with the row.
   *
   * Never an inline field here. The clock is a whole `ScheduleRule` (an anchor,
   * a lead, a grace, quiet hours, a headroom guard and whichever clause is
   * added next), and the one surface that composes one is `SendSheet`'s *When*.
   * A second editor on this row would be the fifth spelling of a decision this
   * app has spent three passes collapsing into one.
   */
  onEditWhen: (id: string) => void;
}

/**
 * What a tap asks of the WHOLE repo or of the cut on screen: the switches, the
 * bulk bars (one tap, one receipt), the reorder, the assessment.
 */
export interface BacklogCutVerbs {
  /**
   * **Ask for titles and kinds on a cut of rows.**
   *
   * A hand-written row has neither and nothing derives them, because nothing
   * here applies itself — so this is the tap that asks, and the count on it is
   * the cut on screen (`nameableInCut`). Durable through the outbox `op` lane:
   * a naming pass never overwrites a `hand` field and writing the same title
   * twice is the same row, so a frame delivered late is either still what was
   * meant or a no-op.
   */
  onName: (repoDir: string, ids: string[]) => void;
  /** Apply a new top-to-bottom order for a repo's items (drag-and-drop). */
  onReorder: (ids: string[]) => void;
  onSetAuto: (enabled: boolean) => void;
  /**
   * **Archive a whole cut, with one receipt.** `onDropClocks`' twin, and the
   * same wire fact behind it: there is no batch `backlog.archive`, so the app
   * still sends one frame per row and what is BATCHED is the sentence — the
   * only place the count survives. Archiving twenty rows one at a time filled
   * the notification feed with one decision and never said "20".
   */
  onArchiveMany: (ids: string[]) => void;
  /**
   * "Of everything still open here, what is actually still worth doing?"
   *
   * The entry point lives on THIS bar rather than on a launcher row, and
   * deliberately: it is the screen you are already on when the question occurs
   * to you, and a button that prominent gets pressed by accident — the run reads
   * a whole repo, which is real money. Optional, so a caller that cannot start
   * one simply does not draw it.
   */
  /**
   * The ids are the CUT the caller is asking about — absent is the whole repo,
   * which is what this was before `assess.run` could carry a scope and what it
   * still means with no filter on. See `assessScopeLabel`: the number on the
   * button is the ASSESSABLE rows in the cut, because those are the only ones a
   * run can return a verdict about.
   */
  onAssess?: (repoDir: string, ids?: string[]) => void;
  /** The slot check: exactly `c.ids`, named as one slot (`slotCheck.ts`). */
  onSlotCheck?: (c: SlotCheck) => void;
  /** Why it cannot be pressed for this repo, in the caller's words (offline, a
   *  run already in flight, the budget gate) — `null` when it can. A reason
   *  rather than a boolean: a greyed-out button that says nothing is the thing
   *  this app keeps finding it has shipped. */
  assessBlocked?: (repoDir: string) => string | null;
  /**
   * **The same verb over the whole cut — ONE tap, ONE receipt.**
   *
   * The bar used to call `onDropClock` once per id, and each of those is a
   * `liveSend` with its own toast: *drop the clocks on these 7* put seven
   * identical sentences on screen and seven rows in the toast log, which is the
   * notification feed reporting one decision seven times and never reporting
   * the only number that matters — how many rows it touched.
   *
   * The WIRE is unchanged (`intent.update` is per id; there is no batch frame),
   * so this is a callback and not a message: the app sends N frames and says
   * one thing about them. The count in the receipt is the count on the button,
   * which is the count of rows in the cut on screen.
   */
  onDropClocks: (ids: string[]) => void;
  /**
   * **The same verb over the whole cut — ONE tap, ONE receipt**, exactly
   * `onDropClocks`' rule and its reason.
   *
   * The wire has no batch `intent.requeue`, so the app sends one frame per row
   * and what is BATCHED is the sentence: nineteen identical toasts for one tap
   * is the notification feed reporting one decision nineteen times and the only
   * number that matters — how many rows it touched — never once.
   *
   * Rows, not ids: each frame carries its OWN `failedAt` for `onRunAgain`'s
   * reason, and a list of ids would have made the app look every one of them up
   * again in a different list — the state as the SENDER has it rather than as
   * the person reading the sheet was shown it, which is the exact substitution
   * the guard exists to refuse.
   */
  onRunAgainMany: (rows: { id: string; failedAt?: number }[]) => void;
}

/**
 * Doors out of the sheet, and what it needs to draw from elsewhere: the send
 * sheet, a session, a schedule, the re-time editor, an image's URL.
 */
export interface BacklogNav {
  /**
   * Write a new item — by opening the ONE send surface, seeded to this repo and
   * *when it's free*, never by a second prompt textarea.
   *
   * This sheet used to carry its own: a `PromptComposer`, a repo select, a
   * target-session select, a dictate button and three attach buttons — a fifth
   * place in the app to write a prompt, with its own subset of the four
   * questions and its own answers to the ones it did not ask. `words` is the
   * rescue path for a draft that field left behind.
   */
  onOpenSend: (repoDir: string, words?: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** The ONE session close (`nav.closeSession`) — a person's tap, never a new path. */
  onCloseSession: (s: SessionInfo) => void;
  /** Build a viewable URL for an image path referenced by an item (null if repo unknown). */
  imageSrc: (repoDir: string, relPath: string) => string | null;
  onClose: () => void;
  /**
   * **The schedule that wrote a row, where the phone can know it.**
   *
   * A schedule's entire job is to create backlog items, and a backlog item very
   * often came from one — yet neither list named the other, so the connection
   * lived only in a person's head. This is the link in the item→rule direction.
   *
   * A FUNCTION rather than a map because the honest answer is narrow: the only
   * parentage on the wire today is `ScheduleEntry.lastResult.childId`, i.e. the
   * LAST item each rule produced. Older items are not linked and must say
   * nothing rather than guess — matching on the label would "work", since a
   * scheduled child inherits the rule's name, and would be wrong the first time
   * somebody typed that name themselves. See `docs/notes/web.md` for the host
   * field that would widen it.
   */
  scheduleFor?: (it: BacklogItem) => { id: string; name: string } | null;
  /** Open the Schedules sheet on one rule — the other half of the seam. */
  onOpenSchedule?: (id: string, name: string) => void;
  /** The When editor for the ticked rows (`RetimeBar.RenderRetime`) — the Send
   *  sheet in re-time mode, drawn over this list by App. */
  renderRetime: RenderRetime;
}

/**
 * Everything a region of the sheet draws from: the props, the clock, and each
 * state cluster's result. Built once per render by `Backlog.tsx` and handed
 * down whole; a region destructures the names it reads, so its JSX reads
 * exactly as it did when it was inline.
 */
export type BacklogModel = { p: BacklogProps; now: number }
  & ReturnType<typeof useBacklogDraft>
  & ReturnType<typeof useBacklogFilters>
  & ReturnType<typeof useBacklogSort>
  & ReturnType<typeof useBacklogUi>
  & ReturnType<typeof useBacklogEdit>
  & ReturnType<typeof useBacklogCuts>
  & ReturnType<typeof useBacklogDrag>;
