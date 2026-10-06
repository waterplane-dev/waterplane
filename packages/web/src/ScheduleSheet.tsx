import { useMemo, useState } from "react";
import { CalendarClock, CircleAlert, CircleCheck, CloudOff, History, ListTodo, Loader, Pause, Pencil, Play, Plus, Power, Repeat, SkipForward, Terminal, Trash2, X } from "lucide-react";
import type { HorizonBucket, Intent, RepoTarget, ScheduleEntry, SessionInfo, WindowResets } from "@waterplane/shared";
import { HORIZON_LABEL, SPENT_ONCE_TEXT, describeRule, hoursOpenFrom, inHours, isStandingSchedule, nextFireAt, ruleRecurs, typedName } from "@waterplane/shared";
import { track } from "./usage";
import { ago } from "./format";
import { clockCuts } from "./clockCuts";
import { ClockDirectory, ClocksGone } from "./clockDirectory";
import type { RenderRetime } from "./RetimeBar";
import { scheduleItemsLabel } from "./backlogFilter";
import { fmtWhen, inWords } from "./sendIntent";
import { SheetHead } from "./Sheet";
import { ScheduleWeekBar } from "./ScheduleWeekBar";
import { Empty } from "./Empty";
import { Unavailable } from "./Unavailable";
import { SyncChip } from "./SyncMark";
import { queueSync } from "./syncState";

interface Props {
  repos: RepoTarget[];
  entries: ScheduleEntry[];
  onRemove: (id: string) => void;
  onSetEnabled: (id: string, enabled: boolean) => void;
  /** Fire one now, off-schedule. Does NOT consume the next occurrence. */
  onRunNow: (id: string) => void;
  /** Let the next occurrence go by and arm the one after it. Recurring only —
   *  a one-off has just the one run, and the verb for that is delete. */
  onSkipNext?: (id: string) => void;
  /**
   * Open the editor — which is the SEND sheet, seeded with this row (or with
   * nothing, for a new one).
   *
   * There is no editor here any more. A schedule is a send whose WHEN is a
   * wall-clock rule, and it was the only send with its own composer, its own
   * repo pickers, its own prompt box and its own "what it runs" switch — seven
   * sections of which a handed-over prompt had already answered six. The user's
   * complaint was exactly that: "I just want to define a date / time and then
   * have it scheduled — the complicated screen I get leaves me puzzled." So the
   * list stays (a schedule is a standing thing, and standing things need a
   * list) and composing one is the same two rows as composing anything else.
   */
  onEdit: (entry: ScheduleEntry | null) => void;
  /**
   * The store itself, and the live sessions — what turns "queued in myapp · item
   * 936ff54f" into somewhere you can go.
   *
   * A `backlog` schedule fires by CREATING a work item, so the thing that
   * actually runs the words is one hop away: schedule → item → the session the
   * item was typed into. Both hops existed only inside a sentence, so the row
   * reported an id nothing on the phone could act on. `ScheduleResult.childId`
   * is the first hop and `Intent.sessionId` the second; this sheet walks them.
   */
  intents?: Intent[];
  sessions?: SessionInfo[];
  /** Attach to a session that exists. */
  onOpenSession?: (sessionId: string) => void;
  /**
   * **Where this rule's work lands: that repo's backlog, and the item it wrote.**
   *
   * A schedule and a backlog are the same subject read at two moments — the
   * rule that will write rows, and the rows it wrote — and neither list named
   * the other, so a person had to hold the join in their head. This is the
   * rule→item direction.
   *
   * `ids` is present when the phone knows exactly which row the last fire
   * produced (`lastResult.childId`), and a COUNT ON A CONTROL IS A FILTER: the
   * button then says "1 item" and the tap opens that one, not the repo's
   * fifty-two. With nothing fired yet there is no cut to make and it opens the
   * repo's list, which is still the honest answer to "where does this go".
   */
  onOpenBacklog?: (repoDir: string, ids?: string[], label?: string) => void;
  /** The When editor for the ticked directory lines — every repo's at once. */
  renderRetime?: RenderRetime;
  /** false = no socket. The live-only toggles are disabled; editing still works
   *  (a save queues like any other send). */
  online?: boolean;
  /**
   * Schedules written here that the host has not acknowledged yet — the
   * `schedule.save` ops still sitting in the send queue.
   *
   * Arming one offline always worked (the save is a durable op), but the list
   * it was armed INTO is host state, so the row appeared nowhere until the link
   * came back: you scheduled a run, the sheet said nothing was scheduled, and
   * the only honest read of that screen was that it had not worked. These are
   * shown as ordinary rows, marked queued, upserting on the id — an offline
   * EDIT of an armed schedule replaces the row it edits rather than sitting
   * next to it claiming the same time.
   */
  pending?: PendingSchedule[];
  /**
   * The horizon bucket the launcher chip named, when this sheet was opened BY
   * that chip — "2 within the hour" opens the two, not all ten.
   *
   * A number on screen is a claim about a set of rows, and the only way to
   * check a claim is to see the rows. Landing on the unfiltered list made the
   * reader re-do the arithmetic the chip had already done, against times
   * written as "Do., 10. Sept., 21:52". The bucket travels rather than a row
   * list: `horizonBucket` is the same edge that produced the count, so the two
   * cannot drift, and it stays right while the sheet is open and the clock
   * moves.
   */
  focus?: HorizonBucket | null;
  /**
   * The OTHER cut: specific rule ids, opened by a link from somewhere else — a
   * backlog row saying "from the schedule “x”".
   *
   * Cut over every row this sheet holds, standing and spent alike, and not over
   * `sorted`: a one-off that has been and gone is normally history rather than
   * a row here, but a person who tapped its name has asked for that exact rule
   * and "nothing is in that cut" would be the sheet losing the row it was sent
   * to. The card says what such a row is (`SPENT_ONCE_TEXT`, the sentence every
   * surface shares) instead of wearing the timing tag, which would read as a
   * rule still waiting for a clock.
   */
  focusIds?: { ids: string[]; label: string } | null;
  /** Drop the filter and show every schedule. Always offered while one is on —
   *  a filtered list with no way out is a list of lost rows. */
  onClearFocus?: () => void;
  /**
   * Open Activity on the one-offs that have already been and gone.
   *
   * They are not rows of this list any more (`isStandingSchedule`), and a row
   * that leaves a screen without a door is a row somebody has lost: this is the
   * door. It hands over the exact ids, so Activity shows those and says so,
   * rather than dropping the reader into every piece of work this desktop has
   * ever done to find ten prompts by eye.
   */
  onOpenSpent?: (ids: string[]) => void;
  /**
   * When the host last confirmed `entries` (0 = never on this device). The list
   * is cached, so this sheet reads offline — and a cached list that cannot say
   * how old it is reads as current.
   */
  listAt?: number;
  /**
   * The last usage reading (`world.usage`), for the week bar: where the session
   * and weekly windows reset, and how much of each is used. Null until the host
   * has read `/usage` — the bar then says so and draws only clock rules.
   */
  usage?: WindowResets | null;
  onClose: () => void;
}

/**
 * Scheduled prompts — the standing ones, listed.
 *
 * Two shapes are worth having as rows rather than as sends you have to remember
 * making: "tonight at 23:00, once" and "every Thursday, two hours before my
 * weekly usage window resets". This is where they are read, armed, disarmed,
 * fired off-schedule and deleted. Writing one is `SendSheet`'s *When* — the
 * same anchor-and-lead editor, on the same prompt box every other send uses.
 *
 * The next fire is computed by the host and shown here as it sent it, so the
 * row is not an approximation of what will happen.
 */
/**
 * A save this phone made that the host has not listed back yet — the entry, plus
 * whether its send has GIVEN UP.
 *
 * `failed` is carried rather than inferred because the two states look the same
 * from here and are not the same at all: a queued save arrives when the link
 * does, a failed one never arrives without a tap. Before this they were one
 * list, so the row that will never land was the row drawing the amber "queued"
 * chip — the most reassuring mark in the sheet on its least reassuring row.
 */
export interface PendingSchedule { entry: ScheduleEntry; failed?: boolean }

/**
 * **The refusals that are about the LINK, not about the row.**
 *
 * These two still gate the RENDERING — a verb that cannot run is not drawn as a
 * control, because `opacity` is the only thing separating a disabled
 * `.approve-btn` from a live one and there is no hover on a phone to reveal its
 * `title`. What they must NOT do is go into that row's `<Unavailable>` list: with
 * a dead tunnel every card in the sheet printed the same two sentences about the
 * same one fact, so ten schedules meant twenty lines of "no connection" under a
 * banner already saying it once, and the per-row facts that actually differ (this
 * save is queued, that one gave up) were buried in the repetition.
 *
 * So they are said ONCE, at the level the reason is true at: the sheet's own
 * banner, which names every verb the dead link takes away. That is not a
 * loophole in "never grey out a button" — the ban is on rendering a control that
 * does nothing, and the control is still absent. It is where the SENTENCE goes
 * that changes, and stating a whole-sheet fact once is this repo's existing
 * pattern, not a new one. Per-row `<Unavailable>` survives for per-row facts.
 */
const OFFLINE_TOGGLE = "no connection — it is armed on the desktop and can only be changed there";
const OFFLINE_REMOVE = "no connection — it lives on the desktop and can only be deleted there";
const SHEET_WIDE_REASONS = new Set([OFFLINE_TOGGLE, OFFLINE_REMOVE]);

/** What became of the work item a schedule created, in one word. The store's
 *  own state, never a second reading of it. */
function childState(i: Intent): string {
  if (i.state === "starting" || i.state === "running") return "running";
  if (i.state === "blocked") return "waiting";
  if (i.state === "queued") return "queued";
  return i.state; // done / failed / canceled
}

export function ScheduleSheet({
  repos, entries, onRemove, onSetEnabled, onRunNow, onSkipNext, onEdit, onClose,
  intents = [], sessions = [], onOpenSession, onOpenBacklog, renderRetime,
  online = true, pending = [], listAt = 0, focus = null, focusIds = null, onClearFocus, onOpenSpent, usage = null,
}: Props) {
  const repoName = (dir: string) => repos.find((r) => r.worktreePath === dir)?.repoName ?? dir.split("/").pop() ?? dir;

  /**
   * Which card has its prompt open, at most one. The words are clamped to three
   * LINES closed (`.bl-text`, the backlog's clamp and the app's only one) and are
   * the whole prompt open — never a character slice, which is what was here and
   * what produced "already fi" as the last thing a reader saw of a schedule.
   *
   * One id and not a Set because there is nothing to compare between two cards
   * here — a schedule is read one at a time — and because a single id cannot
   * accumulate rows that have since left the list.
   */
  const [openText, setOpenText] = useState<string | null>(null);

  /**
   * ── Every clock on this desktop, cut ONCE ────────────────────────────────
   *
   * Cards and directory lines, the spent foot, the horizon filter and every
   * number on this sheet come out of one call, and the launcher chip that
   * opened it makes the SAME call over the same two lists. That is not tidying:
   * the three readings this replaces said **13 · 8 · 2** about one set of rows
   * on the day they were measured — the chip's number, the chip's own title and
   * this header, disagreeing by eleven. A count on a control is a filter, and
   * eleven of those rows were a tap that could reach nothing.
   *
   * One `Date.now()` for the whole pass, so a row cannot fall out of the set
   * between two `horizonBucket` calls in one render. It is not re-cut on a
   * clock tick: this sheet has no timer, and a row silently leaving a list
   * somebody is reading is worse than a row that is a minute stale — the bar
   * says what the filter is, and clearing it is a tap.
   */
  const now = Date.now();
  const clocks = useMemo(
    () => clockCuts({ intents, entries, pending, focus, focusIds, now }),
    [intents, entries, pending, focus, focusIds, now],
  );
  /** id → whether that queued save has given up. A Map and not a Set because
   *  the row needs the verdict, not just membership. */
  const queuedIds = useMemo(
    () => new Map(clocks.pendingCards.map((p) => [p.entry.id, !!p.failed])),
    [clocks.pendingCards],
  );
  /** Ids the HOST's own listing carries — the only thing that earns a green
   *  mark. An ack says a frame was taken; the listing says it was stored. */
  const hostIds = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);

  const sorted = clocks.cards;
  const spentRows = clocks.spentCards;
  const shown = clocks.shownCards;

  /** The two kinds, kept apart. Standing policy reads differently from a thing
   *  that happens once and is then over. */
  const repeating = useMemo(() => shown.filter((e) => ruleRecurs(e.rule)), [shown]);
  const oneOff = useMemo(() => shown.filter((e) => !ruleRecurs(e.rule)), [shown]);

  /** Lines and cards are one list as far as every count on this sheet is
   *  concerned: the head, the filter bar's `n of N`, and the empty states. Both
   *  come off the cut rather than being re-added here, so this header and the
   *  launcher chip that opened it cannot be two numbers. */
  const shownTotal = clocks.shownTotal;
  const standingTotal = clocks.standingTotal;

  // ── the list ───────────────────────────────────────────────────────
  const row = (e: ScheduleEntry) => {
    const act = e.action;
    // Not yet on the host: the time is this device's own preview of the rule,
    // and every button that acts on a stored row has nothing to act on.
    const queued = queuedIds.has(e.id);
    // Gave up vs still on its way. Both mean the host does not have it, so the
    // same verbs are refused — but only one of them resolves itself.
    const sendFailed = queuedIds.get(e.id) === true;
    /**
     * Did this reach the desktop? The one question the sheet could not answer.
     *
     * A row the host lists is a row the host STORED: the phone can be put down
     * and the rule still fires. That fact was previously conveyed by the absence
     * of an amber chip, which is to say not conveyed at all — the screenshot
     * that started this had ten rows and no way to tell "armed on the desktop"
     * from "sitting in a phone on a train".
     */
    const syncPhase = queueSync({ queued, failed: sendFailed, onHost: hostIds.has(e.id), online });
    /**
     * **A spent one-off reaches this card down exactly one path: an ids link.**
     *
     * Every row of the ordinary list comes through `sorted`, which is `all` cut
     * by `isStandingSchedule`, so this was constantly false and the three things
     * it used to feed — an "already spent" tag in the WHEN slot, a different
     * *now* tooltip, a refusal on the switch — were dead code carrying live
     * claims. It is live again for one reason and one only: `focusIds` cuts over
     * `all`, because a person who tapped "from the schedule “x”" on a backlog
     * row has asked for that rule by name and must not be handed an empty list.
     *
     * What it may say is `SPENT_ONCE_TEXT` and nothing else — the sentence every
     * surface shares. The old chip is not coming back: it said "already spent"
     * where Activity, which owns the row, buckets a one-off the desktop slept
     * through as `failed`, and two screens giving one row two verdicts is what
     * the shared sentence was written to end. *now* still WORKS on such a row
     * (the host revives and fires it), which is why nothing here refuses it.
     */
    const spent = !isStandingSchedule(e, now);
    const repeats = ruleRecurs(e.rule);
    // PAUSED is not OFF, and for a standing rule it is the state people
    // actually want: stop the next run, decide later, carry on as planned. The
    // switch has always done exactly that (`setArmed` re-arms from NOW, so a
    // resumed weekly rule keeps its own day and time) — it just called itself
    // "off", which reads like something that has been turned into scenery.
    // A paused row also has to say what it WOULD do, or "next: nothing" is the
    // only thing on the card and the cadence you set is invisible.
    const paused = repeats && !e.enabled;
    const wouldFireAt = paused ? nextFireAt(e.rule, now) : null;
    /**
     * The name, when there IS a name. `ScheduleEntry.name` is filled in by the
     * host with `action.text.split("\n")[0].slice(0, 120)` when nobody typed one
     * (`scheduleToIntent` / `intentToSchedule`), so the card's header was a
     * chopped copy of the sentence two lines below it: cut once by the slice and
     * again by CSS ellipsis, and the header was the less useful of the two
     * truncations. `typedName` is the one test for that, shared with the
     * backlog's `realLabel` and Activity's schedule row.
     *
     * When it answers null the header row is spacer + sync + timing and the prose
     * block is the card's only text. Titling the card by its RULE instead was
     * considered and rejected: the rule line is two lines down already, and after
     * this change Activity titles the same Intent by its prose — two surfaces
     * calling one row two different things is the failure this is fixing, not a
     * fix for it.
     */
    const typed = typedName(e.name, act.text);
    // What this fire made, and where it ended up. A `backlog` schedule's whole
    // effect is a work item, so the row can say what became of it instead of
    // leaving an id in a sentence — and the CLI it ran in is one field further.
    const child = e.lastResult?.childId ? intents.find((i) => i.id === e.lastResult!.childId) : undefined;
    const ruleRow = intents.find((i) => i.id === e.id);
    const rowWait = ruleRow?.state === "blocked" && ruleRow.blockReason && ruleRow.blockReason !== "notYet" ? ruleRow.blockDetail : undefined;
    const childSession = child?.sessionId && sessions.some((s) => s.id === child.sessionId && s.running !== false)
      ? child.sessionId : null;
    // What a fire MAKES, in the words the rest of the app uses for it. It read
    // `backlog · myapp (auto-fire)` — three pieces of machinery (a list, a repo,
    // a flag) where the fact is one sentence: it opens a session in that repo
    // and runs these words there. `autoFire: false` is the rare rule that only
    // WRITES the item down and waits to be fired by hand, and that is the half
    // worth naming, not the ordinary case.
    /**
     * The hour a rule may not run at, and the hour it then waits for.
     *
     * Quiet hours, a headroom guard and which METER that guard reads are all
     * clauses `describeRule` already spells on the line below — deliberately not
     * re-worded here, because a second spelling of one rule on one screen is
     * exactly what the `one-off`/`repeats` chip was and why it went.
     *
     * This is the one thing that line cannot say, because it is about the
     * OCCURRENCE rather than the rule: `nextAt` is when the rule becomes due,
     * and a rule anchored at 03:00 behind a 07:00–22:00 window is due at 03:00
     * and may not speak until 07:00. Printing "next 03:00" alone is a promise
     * the row cannot keep, so the opening is named beside it — through the same
     * `hoursOpenFrom` the ladder counts the grace from, never a clock re-derived
     * here.
     *
     * (There is no `after` arm on this card and there is not going to be one: a
     * chained prompt has no recurrence and no clock to arm, so `isBacklogRow`
     * files it as WORK and `intentToSchedule` returns null for it. It is
     * Activity's row, in Activity's words.)
     */
    const heldUntil = e.nextAt && !inHours(e.rule, e.nextAt) ? hoursOpenFrom(e.rule, e.nextAt) : null;
    // A COUNT, never the words — `BacklogItem.steps`' rule, for the same reason:
    // the card is one line wide and the chain itself is on the row, in full,
    // where the editor opens it. Without it a three-turn rule read as a one-turn
    // rule, which is precisely what it used to BE (`ScheduleAction.steps`).
    const turns = act.kind === "backlog" && act.steps && act.steps.length > 1 ? ` · ${act.steps.length} turns` : "";
    const what = act.kind === "fanout"
      ? `fan-out · ${act.dirs.length} repo${act.dirs.length === 1 ? "" : "s"}`
      : act.autoFire === false
        ? `${repoName(act.repoDir)} · added to the backlog, not run${turns}`
        : `a new session in ${repoName(act.repoDir)}${turns}`;
    return (
      <div key={e.id} className={`q-card${e.running ? " resuming" : ""}`}>
        {/* ONE VOCABULARY PER QUESTION, and this header is where it is easiest
            to break. The `SyncChip` answers WHERE this rule is stored (a phone, a
            queue, the desktop); the tag on its right answers WHEN it fires; the
            rule line below answers WHAT it is. A chip that answers a second
            question — the "already spent" tag that used to sit in the WHEN slot —
            reads as a time, which is how this card came to claim a state in two
            vocabularies at once.
            `"not armed"` is `HORIZON_LABEL`'s word and not this file's for the
            same reason the counts are: the launcher chip and this sheet's own
            filter bar both call such a row that, and "no next run" was a third
            spelling of one bucket on one screen. `paused` and `off` stay — they
            are not another name for unarmed, they are the REASON it is. */}
        <div className="q-head">
          {typed && <span className="row-title">{typed}</span>}
          <span className="spacer" />
          <SyncChip phase={syncPhase} thing="this schedule" />
          {queued
            ? null
            : e.running
            ? <span className="tag"><Loader size={12} className="spin" /> running</span>
            : e.nextAt
              ? <span className="tag limit-auto">{inWords(e.nextAt)}</span>
              // "not armed" names a state you can leave, and a spent one-off
              // cannot. It says what it IS instead; the sentence under the card
              // says what is left to do with it.
              : spent
                ? <span className="tag">been and gone</span>
                : <span className="tag">{e.enabled ? HORIZON_LABEL.unarmed : paused ? "paused" : "off"}</span>}
        </div>
        {/* WHAT it is, kind first. The `one-off` / `repeats` chip that used to
            lead this line is gone: `describeRule` now opens with the kind itself
            ("once · Wed, 9 Sept, 21:00", "every Thu · 16:00"), so the chip was the
            same fact rendered twice, in a slot the reader had already learnt to
            read as a status. The section headers keep the grouping and the count;
            they are not sticky, which is exactly why the kind has to be in this
            line and not only above it. */}
        <div className="approve-hint">
          {describeRule(e.rule)} · {what}
          {e.waitUntilFree ? <> · waits until free</> : null}
          {/* A row whose send GAVE UP may not claim a next run. `nextAt` is this
              device's own preview of the rule and reads exactly like the host's
              armed time — which on the one row that will never arm is the same
              lie `isTerminal` rows were fixed of: a countdown to a fire nobody
              will make. The rule and the target still print; only the promise
              goes. */}
          {e.nextAt && !sendFailed ? <> · next {fmtWhen(e.nextAt)}</> : null}
          {heldUntil && !sendFailed ? <> · held until {fmtWhen(heldUntil)}, when its hours open</> : null}
          {wouldFireAt ? <> · would next run {fmtWhen(wouldFireAt)} once resumed</> : null}
        </div>
        {/* The one thing a spent one-off has left to say, in the one wording
            every surface uses for it (`SPENT_ONCE_TEXT`). Drawn only because an
            ids link can land such a row here — the ordinary list has none. */}
        {spent && !queued && <div className="approve-hint">{SPENT_ONCE_TEXT}</div>}
        {/* WHY a rule is waiting, off its own row — `ScheduleEntry` carries no
            block reason, so the card read *armed* while the budget held it. The
            host's `blockDetail`, verbatim (the backlog row's sentence); never
            `notYet`, which is the time already printed above. */}
        {!queued && rowWait && <div className="approve-hint">{rowWait}</div>}
        {queued && (
          <div className="approve-hint">
            {sendFailed
              ? <>the send gave up — this rule is on this phone and nowhere else, and it will not arm itself.
                  Its words are kept; re-send it from the queue, or edit it here to replace the copy that failed.</>
              : <>waiting for the link — it is armed on the desktop as soon as the queue drains, and the time above holds
                  (the rule is a wall clock, not a countdown from when it is saved).</>}
          </div>
        )}
        {/* THE PROMPT, whole, clamped by LINES and never by characters.
            This was `act.text.split("\n")[0].slice(0, 110)`, which ended a card
            on "already fi" — a mid-word cut passing itself off as a summary, and
            the second of two different cuts of one string on one card (the header
            took 120 of it). Three lines of `.bl-text` closed is enough to tell two
            similar prompts apart; tapping gives the whole thing. Same clamp, same
            button class and same one-at-a-time behaviour as the backlog's rows,
            because this repo has one prose clamp and a second copy is how two
            screens drift.
            Not `mono`: monospace here says "this is a command", which it is not —
            it is the same kind of sentence the backlog and Activity render in the
            UI font. */}
        <button
          className={`bl-text bl-text-btn ${openText === e.id ? "open" : ""}`}
          title={openText === e.id ? "collapse" : "expand — the whole prompt this fires"}
          onClick={() => setOpenText((cur) => (cur === e.id ? null : e.id))}
        >
          {act.text}
        </button>
        {e.lastResult && (
          <div className="approve-hint">
            {e.lastResult.ok
              ? <CircleCheck size={12} style={{ verticalAlign: "-2px" }} />
              : <CircleAlert size={12} style={{ verticalAlign: "-2px" }} />}{" "}
            {ago(e.lastResult.at)} · {e.lastResult.detail}
            {/* WHICH occurrence, formatted HERE. The host writes the sentence
                and no longer writes a wall clock into it — its locale is not
                this phone's, and one card carrying "Do., 10. Sept., 21:52" and
                "9/10/2026, 9:52:00 PM" for the same instant is a card nobody
                can read as one fact. */}
            {e.lastResult.occurrence ? <> · due {fmtWhen(e.lastResult.occurrence)}</> : null}
            {e.lastResult.late ? " · ran late (the host had been asleep)" : ""}
            {child ? <> · the item is <b>{childState(child)}</b></> : null}
          </div>
        )}
        {/* Why each verb is or is not on this row.
            Editing is the one action a queued row supports, and it is the right
            one: the save is an upsert on this id, so editing it while it waits
            replaces the queued copy instead of arming two. The rest act on a row
            the host does not have yet — running it now would spawn sessions off a
            schedule nobody has stored, and deleting it would leave the save in
            the queue to re-create it.

            A verb that cannot run is NOT rendered as a dimmed button: `opacity`
            is the only thing separating a disabled `.approve-btn` from a live
            one, there is no hover on a phone to reveal its `title`, and the
            result is a control nobody can tell apart from a working one. It
            becomes a sentence instead (`.act-cant`, shared with Activity). */}
        {(() => {
          const why = {
            run: sendFailed ? "the send gave up — the desktop never got it, so there is nothing there to run"
              : queued ? "it is still in the send queue — the desktop does not have it yet" : null,
            toggle: sendFailed ? "the send gave up — the desktop never got it, so there is nothing there to switch"
              : queued ? "it is still in the send queue — the desktop does not have it yet"
              : !online ? OFFLINE_TOGGLE : null,
            remove: sendFailed ? "the send gave up — nothing was stored, so there is nothing to delete"
              : queued ? "it is still in the send queue — cancel it there instead"
              : !online ? OFFLINE_REMOVE : null,
          };
          // Only what is true of THIS row. The connection-shaped reasons are
          // `SHEET_WIDE_REASONS` and are the banner's sentence, said once for the
          // whole list instead of twice per card.
          const cants: Array<[string, string | null]> = [
            ["now", why.run],
            [repeats ? "pause/resume" : "on/off", why.toggle && SHEET_WIDE_REASONS.has(why.toggle) ? null : why.toggle],
            ["delete", why.remove && SHEET_WIDE_REASONS.has(why.remove) ? null : why.remove],
          ];
          return (<>
            <div className="approve-opts">
              {why.run ? null : (
                <button className="approve-btn" data-hint="schedule.runnow"
                  title="Run it now. This does not use up the next scheduled run."
                  onClick={() => { track("action:schedule.runnow"); onRunNow(e.id); }}><Play size={14} /> now</button>
              )}
              <button className="approve-btn" data-hint="schedule.edit"
                onClick={() => { track("action:schedule.edit"); onEdit(e); }}>
                <Pencil size={14} /> edit
              </button>
              {/* **Where this rule's work goes, in one slot with three shapes.**
                  In order of how much each knows:

                   - the SESSION its last run was actually typed into, when one
                     is still open — the most specific answer there is;
                   - else the ITEM that run wrote, as a filter: "1 item" opens
                     exactly that row in its repo's backlog, never the repo's
                     fifty-two for the reader to find it in;
                   - else the repo's BACKLOG, which is still the true answer to
                     "where does this land" for a rule that has not fired yet.

                  What used to be in this slot was *open a session* — the retired
                  concept the backlog sheet dropped for the same reason: a
                  control whose only job was to give another control a target.
                  Nothing here needs one; every scheduled run opens a session of
                  its own. A fan-out has neither a single session nor a single
                  backlog (that is the fan-out view's job), so it still gets
                  nothing. */}
              {childSession && onOpenSession ? (
                <button className="approve-btn" data-hint="schedule.session"
                  title="Open the session this item ran in"
                  onClick={() => { track("action:schedule.session"); onOpenSession(childSession); }}>
                  <Terminal size={14} /> session
                </button>
              ) : act.kind === "backlog" && onOpenBacklog ? (
                child ? (
                  <button className="approve-btn" data-hint="schedule.backlogitems"
                    title={`Show the item this rule wrote, in ${repoName(act.repoDir)}'s backlog`}
                    onClick={() => {
                      track("action:schedule.backlog");
                      onOpenBacklog(act.repoDir, [child.id], scheduleItemsLabel(typed || act.text.slice(0, 40)));
                    }}>
                    <ListTodo size={14} /> backlog · 1 item
                  </button>
                ) : (
                  <button className="approve-btn" data-hint="schedule.backlogitems"
                    title={`Show ${repoName(act.repoDir)}'s backlog — this is the list each run of this rule writes into`}
                    onClick={() => { track("action:schedule.backlog"); onOpenBacklog(act.repoDir); }}>
                    <ListTodo size={14} /> backlog
                  </button>
                )
              ) : null}
              {/* Sit out exactly ONE run. Different from pausing, and the
                  difference is who has to remember: a pause waits for you to
                  come back, a skip does not. Only where there is an armed
                  occurrence to spend, and never on a one-off — skipping the one
                  run a one-off has is deleting it. */}
              {repeats && e.nextAt && onSkipNext && !queued && online && (
                <button className="approve-btn" data-hint="schedule.skipnext"
                  title="Let this one run go by, then carry on as scheduled"
                  onClick={() => { track("action:schedule.skipnext"); onSkipNext(e.id); }}>
                  <SkipForward size={14} /> skip next
                </button>
              )}
              {why.toggle ? null : (
                <button className="approve-btn" data-hint="schedule.toggle"
                  title={repeats
                    ? e.enabled
                      ? "Pause it — nothing runs until you resume, and then it carries on at its own times"
                      : "Resume it — the next run is its own next occurrence from now, never the ones it slept through"
                    : e.enabled ? "Stop it running" : "Arm it again — the next run is computed from now, not from what was missed"}
                  onClick={() => { track("action:schedule.toggle"); onSetEnabled(e.id, !e.enabled); }}>
                  {repeats
                    ? e.enabled ? <><Pause size={14} /> pause</> : <><Play size={14} /> resume</>
                    : <><Power size={14} /> {e.enabled ? "off" : "on"}</>}
                </button>
              )}
              {why.remove ? null : (
                <button className="approve-btn" data-hint="schedule.remove"
                  onClick={() => { track("action:schedule.remove"); onRemove(e.id); }}><Trash2 size={14} /> delete</button>
              )}
            </div>
            <Unavailable cants={cants.flatMap(([label, reason]) => reason ? [{ label, reason }] : [])} />
          </>);
        })()}
      </div>
    );
  };

  return (
    <div className="sheet">
      <SheetHead title={<><CalendarClock size={16} /> Schedules</>} onClose={onClose}>
        <span className="muted">{focus || focusIds ? `${shownTotal} of ${standingTotal}` : standingTotal}</span>
      </SheetHead>

      <div className="sheet-scroll">
      {(focus || focusIds) && (
        // Arriving filtered, a short list reads as a short LIST — so it says
        // what is being hidden, counts it against the whole, and carries the
        // way out. Same bar, same words, same clear button as the launcher's.
        <div className="section filter-bar">
          <span className="filter-bar-txt">
            {focusIds
              // The link's own words, for `Backlog`'s `idsLabel` reason: only
              // the caller knows which side it was tapped from. The count is
              // still against the standing list, which is what a cleared filter
              // shows — so a spent rule reads as "1 of 9", and the sentence
              // beside it on the card says why it is not one of the nine.
              ? focusIds.label
              : focus
                ? `showing the ${HORIZON_LABEL[focus] === "not armed" ? "not armed" : `ones ${HORIZON_LABEL[focus]}`}`
                : ""}
            {" · "}{shownTotal} of {standingTotal}
            {shownTotal === 0 && (focusIds
              // An ids cut is one row from a card's own link, or a repo's whole
              // share from its chip — and "that rule" over eleven ids names a
              // row nobody tapped. The count decides which sentence, because
              // the label is the caller's words and cannot be asked.
              ? focusIds.ids.length === 1
                ? " — that rule is not on this desktop any more"
                : " — none of those are on this desktop any more"
              : " — nothing is in that window any more")}
          </span>
          {onClearFocus && (
            <button className="filter-bar-clear" title="clear the filter — show every schedule again"
              onClick={() => { track("action:schedule.focus.clear"); onClearFocus(); }}><X size={13} /> clear</button>
          )}
        </div>
      )}
      {/* The whole-sheet fact, said ONCE and in full.
          Every verb the dead link takes off the cards is named here, because
          those verbs are simply not drawn and an absence explains nothing by
          itself: with a dead tunnel a card's buttons went from six to three and
          nothing on it said which three had gone or why. Saying it per row
          instead printed the same two sentences under every card in the list
          (`SHEET_WIDE_REASONS`); saying it here says it at the level it is true
          at. Editing is named too, and as the thing that still WORKS — a save is
          a durable op, so an offline edit is queued and upserts on its id. */}
      {!online && (
        <div className="form-hint">
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} /> offline — a new or edited schedule is queued and
          saved when the link is back, so <b>edit</b> still works on every row below (the save replaces the copy it
          edits rather than arming a second one). What the cards do not show while the link is down is{" "}
          <b>pause/resume</b>, <b>on/off</b>, <b>skip next</b>, <b>delete</b> and the <b>session</b> button: the first
          four are decisions about a run that may be minutes away and only the host can make them, and the last one
          needs a desktop to open a session on.
          {entries.length > 0 && (listAt
            ? ` The armed rows are this device's copy, last confirmed ${ago(listAt)} ago.`
            : " The armed rows are this device's copy.")}
          {/* **What is NOT on this screen while the link is down, said plainly.**
              The directory below is drawn from the durable row list, which this
              phone does not cache — the cards are cached, the rows are not. A
              reader who has just learnt that their one-offs live in backlogs
              now, and who then finds no clocks listed offline, has been handed
              a screen that reads as "they are gone". They are not: the BACKLOG
              sheet keeps its own snapshot and each row is in it, clock and
              all. */}
          {" "}Items waiting on a clock are not listed below while the link is down — this device caches the rules,
          not the rows. Each of them is in its repo's <b>backlog</b>, which does keep a copy.
        </div>
      )}

      {/* Offline with nothing cached, this says only that THIS DEVICE has never
          seen the list — not that nothing is armed. */}
      {standingTotal === 0 && !online && (
        <Empty>
          <CalendarClock size={20} />
          <div>No connection, and no copy of the schedule list on this device.</div>
          <div className="muted">
            Whatever is armed on the desktop is still armed — this device has just never seen it. A schedule written
            here now is queued and saved when the link is back.
          </div>
        </Empty>
      )}

      {standingTotal === 0 && online && (
        <Empty>
          <CalendarClock size={20} />
          {/* "Nothing is scheduled" is true of the FUTURE, which is what this
              list is about — but said on a screen the reader arrived at because
              ten prompts of theirs ran here, it reads as "your schedules are
              gone". So the spent ones are named in the same breath, with the
              door to them. */}
          <div>Nothing is scheduled.</div>
          <div className="muted">
            A schedule fires a prompt on its own: the same sweep the fan-out runs, at a time you pick — once tonight,
            or every week two hours before your usage window rolls over.
            {/* NOT "already run", for the `sched-spent` foot's reason: the clock
                is all `isSpentOnce` reads, so one the desktop slept through is
                just as spent and never fired at all — Activity buckets that one
                `failed`, and this screen may not say it ran. */}
            {spentRows.length > 0 && (
              <> {spentRows.length} one-off sweep{spentRows.length === 1 ? " has" : "s have"} been and gone; {spentRows.length === 1 ? "it is" : "they are"} in Activity.</>
            )}
          </div>
        </Empty>
      )}

      {/* **The empty-cards case, answered rather than dodged.**
          This user has zero recurring rules and nine one-offs, so under
          "recurrence decides the list" every card they had becomes a backlog
          row and this sheet's card list is empty. That is the honest shape and
          it must not read as a broken screen: with no cards and any clocks at
          all, the DIRECTORY is the body and this line is its heading — it says
          the true thing about the cards ("nothing repeats"), the true thing
          about the rows (they are in their backlogs, which is where their verbs
          are), and it does not pretend a list is missing. With neither, the
          `Empty` above still stands. */}
      {sorted.length === 0 && standingTotal > 0 && (
        <div className="form-hint sched-nothing-repeats">
          <Repeat size={13} style={{ verticalAlign: "-2px" }} /> Nothing repeats — there is no standing rule on this
          desktop. {standingTotal} one-off{standingTotal === 1 ? "" : "s"} wait{standingTotal === 1 ? "s" : ""} on a
          clock in {standingTotal === 1 ? "its repo's backlog" : "their repos' backlogs"}, where every verb they have
          lives. A rule that repeats would be a card here; <b>new schedule</b> writes one.
        </div>
      )}

      {/* Two kinds of thing, and they are not read the same way. A REPEATING
          rule is standing policy — the question about it is "is it on, and when
          is the next one"; a ONE-OFF is a thing that happens and is then over,
          and its whole list is history the moment it fires. Mixed into one
          stream (they were: sorted by `nextAt`, with spent rows sinking) the
          repeating rules were the minority scattered between fired one-offs,
          and nothing on a row said which kind it was — `describeRule` said
          "once · Wed, 9 Sept, 21:00" or "Thu · 16:00", which reads as a date
          either way. It leads with the kind now ("every Thu · 16:00"), which is
          what lets the cards drop their own kind chip: these headings are not
          sticky, so a card scrolled past one has only its own lines to go on.
          Each section is only drawn when it has rows, so a list of nothing but
          one-offs is not two headings and a gap. */}
      {/* **The week, drawn.** A rule like "3h before the weekly window resets"
          names an instant nobody can see from a list; the bar puts the two
          windows' resets and every rule's next fire on one seven-day line.
          It draws the cards this sheet shows (`shown`, so a filter cuts the
          bar too) and computes nothing — the host's `nextAt`, the one usage
          reading (`scheduleWeekPlot.ts`). */}
      {standingTotal > 0 && (
        <ScheduleWeekBar entries={shown} usage={usage} now={now}
          title={(e) => typedName(e.name, e.action.text) ?? e.action.text.split("\n")[0]} />
      )}
      {repeating.length > 0 && (
        <>
          <div className="sched-head"><Repeat size={13} /> Repeating · {repeating.length}</div>
          <div className="list">{repeating.map(row)}</div>
        </>
      )}
      {oneOff.length > 0 && (
        <>
          <div className="sched-head"><CalendarClock size={13} /> One-off · {oneOff.length}</div>
          <div className="list">{oneOff.map(row)}</div>
        </>
      )}

      {/* **On a clock — the directory.** Not a third list of work: one line
          per timed item, grouped by the repo whose backlog holds it, soonest
          first, with ONE affordance each. `clockDirectory.tsx` says why that
          rule lives in a file of its own. */}
      <ClockDirectory rows={clocks.shown} pending={clocks.pending} repoName={repoName}
        online={online} onOpen={onOpenBacklog} renderRetime={renderRetime} />

      {/* The one-off SWEEPS that are OVER — named and counted, never listed here.
          A sweep is the only one-off left in this list: one aimed at a single
          place is a backlog row now, and its own foot is below this one.
          A sweep has no single backlog to be in, so Activity is where its whole
          life is, and Activity is where this goes.
          A schedule list is a list of what is going to happen; these are a list
          of what did, and Activity holds that row for its whole life with what
          it produced and where it ran. Kept as rows they outnumbered the
          standing rules, wore a switch that moves nothing, and made the
          launcher's chip say "10 not armed" about a desktop with nothing
          pending. The count is a FILTER: tapping it opens exactly these.

          What this may NOT say is that they ran. `isSpentOnce` is a reading of
          the CLOCK and nothing else — a one-off the desktop slept past its grace
          never fired, and Activity, which owns the row, buckets exactly that one
          as `failed`. So this line said "already ran" about rows the other
          surface was calling failures, and the green tick said it twice: a check
          over a missed run is the same lie in an icon. `History` is what both
          screens can stand behind, and which of the two it was is the one thing
          Activity's row is there to say. */}
      {spentRows.length > 0 && !focus && !focusIds && (
        <div className="form-hint sched-spent">
          <History size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {spentRows.length} one-off sweep{spentRows.length === 1 ? " has" : "s have"} been and gone — run or missed,{" "}
          Activity's row says which — and a one-off cannot be re-armed, so{" "}
          {spentRows.length === 1 ? "it is not a row here" : "they are not rows here"} any more.
          {onOpenSpent && (
            <> <button className="key" data-hint="schedule.spent"
              onClick={() => { track("action:schedule.spent"); onOpenSpent(spentRows.map((e) => e.id)); }}>
              see {spentRows.length === 1 ? "it" : "them"} in Activity
            </button></>
          )}
        </div>
      )}

      {/* …and the same foot for the TIMED ITEMS that are over — a separate
          line from the sweeps' above, because a spent sweep is Activity's row
          while a spent timed item is still a row in its repo's backlog, with
          `re-fire` and *drop the clock* on it. Suppressed under a filter, like
          the sweeps' foot: a foot counting rows the cut is hiding describes a
          list nobody has on screen. */}
      {!focus && !focusIds && (
        <ClocksGone goneByRepo={clocks.goneByRepo} repoName={repoName} onOpen={onOpenBacklog} />
      )}
      </div>

      <div className="sheet-actions">
        <button className="send" onClick={() => { track("action:schedule.new"); onEdit(null); }}>
          <Plus size={16} /> new schedule
        </button>
      </div>
    </div>
  );
}
