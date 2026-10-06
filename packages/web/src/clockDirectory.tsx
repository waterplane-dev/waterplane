/**
 * **The directory of clocks — every timed item on this desktop, as doors.**
 *
 * Recurrence, not trigger kind, decides which list a row lives in. A standing
 * rule is a thing to arm, pause and skip, and it is a CARD in `ScheduleSheet`.
 * A one-off aimed at one place is waiting work whose WHEN happens to be an
 * instant — spent by its one run, with nothing left to arm afterwards — so it
 * is a ROW in its repo's backlog, with every verb a piece of waiting work has:
 * drag, merge, smart pick, re-fire, *drop the clock*.
 *
 * Measured on this desktop when this was written: nine live `at` rows, every
 * one of them a one-off, zero recurring — seven of them `failed`, in no
 * backlog, and invisible to the smart pick, which only ever looks at backlog
 * rows. That is the whole reason the rows moved.
 *
 * Moving them leaves one thing behind that nowhere else in the app can do:
 * Schedules was the only host-wide view of everything with a clock on it, and a
 * row that leaves a screen without a door is a row somebody has lost. So the
 * sheet keeps a LINE per timed item — and this module exists so that "a line
 * has exactly ONE affordance" is a rule kept in a file that has no others to
 * offer. **One exception, asked for by name**: a pick list. With it open a
 * line is a TICK instead of a door, and one bar moves every ticked line — in
 * any repo — to one new instant (`RetimeBar`, the backlog's own). Nothing is
 * ticked for you, and closing the list puts the doors back. A line with verbs would be the second home the whole change exists to
 * remove, and the two would drift within a week.
 *
 * The cut lives next door in `clockCuts.ts` — pure, and pinned by
 * `clockCuts.test.mjs`; what is here is the same facts with markup around
 * them.
 */
import { useState } from "react";
import { CalendarClock, History, ListChecks, ListTodo } from "lucide-react";
import type { Intent } from "@waterplane/shared";
import { describeRule, hoursOpenFrom, inHours, typedName } from "@waterplane/shared";
import type { PendingClock } from "./clockCuts";
import { intentTitle } from "./activityRows";
import { RETIME_PICK_LABEL, goneOnClockLabel, onClockLabel } from "./backlogFilter";
import { retimeIntentEligible } from "./clockCuts";
import { PickBox, RetimeBar, RetimeLayer, toggled, type RenderRetime } from "./RetimeBar";
import { fmtWhen } from "./sendIntent";
import { SyncChip } from "./SyncMark";
import { queueSync } from "./syncState";
import { track } from "./usage";

interface DirProps {
  rows: Intent[];
  pending: PendingClock[];
  repoName: (dir: string) => string;
  online: boolean;
  /** The one affordance. Absent ⇒ the lines are drawn as facts and NOT as
   *  buttons: a control that cannot go anywhere is what `Unavailable.tsx`
   *  exists to stop. */
  onOpen?: (repoDir: string, ids: string[], label: string) => void;
  /** The When editor for the ticked lines. Absent or offline ⇒ no pick list. */
  renderRetime?: RenderRetime;
}

/**
 * One timed item, as a line.
 *
 * Everything on it is a fact the row already carries — `describeRule`'s own
 * words for the rule (never re-worded here, for the reason the card gives),
 * the host's armed instant, `hoursOpenFrom` for the opening a rule behind quiet
 * hours is actually waiting for, and one word for where it is in its life.
 * Nothing is computed about it that its own backlog row would compute
 * differently.
 *
 * The tap is an IDS cut: this row, in its repo, named. Never the repo's
 * fifty-two for the reader to find it in — the same rule as the card's
 * *backlog · 1 item*, and this line is the same door.
 */
function ClockLine({ i, repoName, onOpen, pick }: {
  i: Intent; repoName: (d: string) => string; onOpen?: DirProps["onOpen"];
  /** Pick list open: the line is a tick, not a door. `null` = this row cannot move, no box. */
  pick?: { on: boolean; toggle: () => void } | null;
}) {
  const rule = i.trigger.kind === "at" ? i.trigger.rule : null;
  const held = rule && i.nextAt && !inHours(rule, i.nextAt) ? hoursOpenFrom(rule, i.nextAt) : null;
  const repo = repoName(i.cwd);
  const body = (<>
    <span className="sched-clock-name">{intentTitle(i)}</span>
    <span className="sched-clock-when">
      {rule ? describeRule(rule) : "on a clock"}
      {i.nextAt ? <> · next {fmtWhen(i.nextAt)}</> : null}
      {held ? <> · held until {fmtWhen(held)}, when its hours open</> : null}
      {i.holdForHost ? <> · waits until free</> : null}
    </span>
    <span className="sched-clock-state">{clockState(i)}</span>
    {/* WHY it is waiting, when the host said — the one sentence the backlog
        row already wears (`blockDetail`), verbatim, never a second wording and
        never a `title`. `notYet` is the clock itself, already said above. */}
    {i.state === "blocked" && i.blockReason && i.blockReason !== "notYet" && i.blockDetail
      ? <span className="sched-clock-why">{i.blockDetail}</span>
      : null}
  </>);
  if (pick !== undefined) {
    if (!pick) return <div className="sched-clock">{body}</div>;
    return (
      <div className="sched-clock sched-clock-pick" role="button" onClick={pick.toggle}>
        <PickBox on={pick.on} onToggle={pick.toggle} />
        <div className="sched-clock sched-clock-inner">{body}</div>
      </div>
    );
  }
  if (!onOpen) return <div className="sched-clock">{body}</div>;
  return (
    <button className="sched-clock"
      title={`open it in ${repo}'s backlog — it is waiting work that happens to carry a clock, and every verb it has is on its row there`}
      onClick={() => { track("action:schedule.clockrow"); onOpen(i.cwd, [i.id], onClockLabel(repo)); }}>
      {body}<ListTodo size={13} className="sched-clock-go" />
    </button>
  );
}

/** Where a timed item is in its life, in one word. The store's own state, never
 *  a second reading of it — the same mapping the card uses for the item a rule
 *  wrote, because they are the same kind of row. */
function clockState(i: Intent): string {
  if (i.state === "starting" || i.state === "running") return "running";
  if (i.state === "blocked") return "waiting";
  return i.state;
}

/**
 * …and one this phone has written that the desktop has not listed yet.
 *
 * Drawn from the queued `ScheduleEntry` itself, because that is all there is:
 * the instant is this device's own preview of the rule, and the only state
 * worth reporting is "nowhere but here" — which is `SyncChip`'s sentence, not a
 * second wording of it.
 */
function PendingClockLine({ p, repoName, online }: { p: PendingClock; repoName: (d: string) => string; online: boolean }) {
  const e = p.entry;
  const repo = e.action.kind === "backlog" ? repoName(e.action.repoDir) : "";
  return (
    <div className="sched-clock">
      <span className="sched-clock-name">{typedName(e.name, e.action.text) ?? e.action.text}</span>
      <span className="sched-clock-when">
        {describeRule(e.rule)}
        {e.nextAt && !p.failed ? <> · next {fmtWhen(e.nextAt)}</> : null}
        {repo ? <> · {repo}</> : null}
      </span>
      <span className="sched-clock-state">
        <SyncChip phase={queueSync({ queued: true, failed: !!p.failed, onHost: false, online })} thing="this one" />
      </span>
    </div>
  );
}

/**
 * The section: a head that says what these lines are for, then one line per
 * item grouped by the repo whose backlog holds it, soonest first — so the first
 * group is the next thing that happens anywhere on this desktop.
 *
 * The head has to say it because a reader who has just been told their
 * one-offs are not cards here needs to know where they went AND that this is
 * the door rather than a second copy of them.
 */
export function ClockDirectory({ rows, pending, repoName, online, onOpen, renderRetime }: DirProps) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [choosing, setChoosing] = useState(false);
  if (!rows.length && !pending.length) return null;
  const canPick = online && !!renderRetime;
  const eligible = rows.filter(retimeIntentEligible);
  const pickedIds = eligible.filter((i) => picked.has(i.id)).map((i) => i.id);
  const open = picking && canPick;
  const close = () => { setPicking(false); setPicked(new Set()); };
  const byRepo: Array<[string, Intent[]]> = [];
  for (const i of rows) {
    const g = byRepo.find(([dir]) => dir === i.cwd);
    if (g) g[1].push(i); else byRepo.push([i.cwd, [i]]);
  }
  return (<>
    <div className="sched-head">
      <CalendarClock size={13} /> On a clock · {rows.length + pending.length}
      <span className="sched-head-note">waiting in their backlogs — the row is there, this is the door</span>
    </div>
    {canPick && !open && eligible.length > 0 && (
      <div className="annot-tools wrap bl-filters">
        <button className="key" title="tick the lines you want — in any repo — and move them all to one new time"
          onClick={() => { track("action:schedule.retime.pick"); setPicking(true); }}>
          <ListChecks size={14} /> {RETIME_PICK_LABEL}
        </button>
      </div>
    )}
    {open && (
      <RetimeBar picked={pickedIds.length} eligible={eligible.length} shown={rows.length}
        where="schedule"
        onAll={() => setPicked(new Set(eligible.map((i) => i.id)))}
        onNone={() => setPicked(new Set())}
        onDone={close}
        onChoose={() => setChoosing(true)} />
    )}
    {choosing && renderRetime && pickedIds.length > 0 && (
      <RetimeLayer>{renderRetime(pickedIds, {
        onSent: () => { setChoosing(false); close(); },
        onCancel: () => setChoosing(false),
      })}</RetimeLayer>
    )}
    {pending.length > 0 && (
      <div className="sched-clocks">
        {pending.map((p) => <PendingClockLine key={p.entry.id} p={p} repoName={repoName} online={online} />)}
      </div>
    )}
    {byRepo.map(([dir, items]) => (
      <div key={dir} className="sched-clocks">
        <div className="sched-clocks-repo">
          {repoName(dir)} · {items.length}
        </div>
        {items.map((i) => <ClockLine key={i.id} i={i} repoName={repoName} onOpen={onOpen}
          pick={!open ? undefined : retimeIntentEligible(i)
            ? { on: picked.has(i.id), toggle: () => setPicked((prev) => toggled(prev, i.id)) }
            : null} />)}
      </div>
    ))}
  </>);
}

/**
 * The foot: the timed items that are over.
 *
 * A separate line from the spent SWEEPS' foot above it, and deliberately: a
 * spent sweep's row is in Activity (it has no single backlog to be in), where a
 * spent timed item is still a row in its repo's backlog with `re-fire` and
 * *drop the clock* on it — which is the tap the seven skipped items of this
 * desktop need. One button PER REPO, because the count is the filter.
 *
 * "run or missed" and never "already ran": `isSpentOnce` reads the clock and
 * nothing else, so a one-off the desktop slept past never fired at all — the
 * row says which, and this line may not.
 */
export function ClocksGone({ goneByRepo, repoName, onOpen }: {
  goneByRepo: Array<[string, Intent[]]>;
  repoName: (dir: string) => string;
  onOpen?: DirProps["onOpen"];
}) {
  if (!goneByRepo.length || !onOpen) return null;
  return (
    <div className="form-hint sched-spent">
      <History size={13} style={{ verticalAlign: "-2px" }} />{" "}
      On a clock, and been and gone — run or missed, the row says which:
      <div className="annot-tools" style={{ marginTop: 6 }}>
        {goneByRepo.map(([dir, rows]) => (
          <button key={dir} className="key"
            title={`show the ${rows.length} timed one-off${rows.length === 1 ? "" : "s"} of ${repoName(dir)} that have been and gone — they are rows in that backlog, with re-fire and “drop the clock” on them`}
            onClick={() => { track("action:schedule.clockspent"); onOpen(dir, rows.map((i) => i.id), goneOnClockLabel(repoName(dir))); }}>
            {rows.length} in {repoName(dir)}
          </button>
        ))}
      </div>
    </div>
  );
}
