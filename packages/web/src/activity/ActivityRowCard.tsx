import { useMemo, useState } from "react";
import {
  CalendarClock, CheckCheck, ChevronDown, ChevronUp, CircleHelp, Inbox, SendHorizontal, Square, SquareCheck, Terminal,
} from "lucide-react";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import { AttachStrip } from "../AttachStrip";
import { checkLook } from "../backlog/backlogLabels";
import { refsIn } from "../fileRefs";
import { RepoPicker } from "../RepoPicker";
import type { ActivityAction, ActivityActionId, ActivityRow } from "../activityRows";
import { ago } from "../format";
import { useInView } from "../useInView";
import type { OutboxEntry } from "../outbox";
import { SessionName } from "../SessionName";
import { NetStalled } from "../NetStalled";
import { CantInline, Unavailable } from "../Unavailable";
import { track } from "../usage";
import { fromScheduleWords } from "../backlogFilter";
import { ACTION_ICON, DELIVERY_TEXT, ICON, KIND_ICON, STATE_ICON, inWords } from "./activityLabels";
import { bytes } from "./activityPullRow";
import type { ReviewMarks } from "./activitySheetTypes";
import { Button } from "../kit/Button";
import { RowTitle, RowSub } from "../kit/Row";
import { Hint } from "../kit/Hint";

/**
 * A control that can actually be pressed.
 *
 * There is no disabled branch here, and that is the point: on a phone a greyed
 * button is a guess. It keeps its border, its icon and its label, it is the
 * same shape as the live one beside it, the only difference is opacity — and
 * the reason it cannot be pressed lives in a `title` attribute that a touch
 * screen has no way to show. Reported as: *"Are these buttons clickable or not.
 * It looks not clickable but I think I can."*
 *
 * So an action this row cannot perform is not rendered as a control at all
 * (`Unavailable` below). The rule `activityRows.ts` carries — a disabled action
 * always carries a reason — is unchanged and is now the ONLY thing shown: the
 * reason, as text, on a line that is visibly not a button.
 */
function ActionButton({ a, onPress }: { a: ActivityAction; onPress: () => void }) {
  const Icon = ACTION_ICON[a.id];
  // `primary` decides ORDER (it leads the strip), never paint: the solid accent fill is a
  // sheet's one primary verb, and a list of rows each with its own read as twenty of them.
  // No verb here asks first: *run it now* into a busy checkout was the last
  // one, and it is the manual override — one tap, its consequence in `a.note`.
  return (
    <Button className={a.danger ? "danger" : undefined} title={a.label} data-hint={`activity.${a.id}`} onClick={onPress}>
      <Icon size={ICON} /> {a.label}
    </Button>
  );
}

export function Row({ row, now, sessions, repos, pick, outbox, online, review, repoIdForCwd, onAction, onRetarget, onOpenSession }: {
  row: ActivityRow;
  /** This row's check verdict, when it has one. See the sheet's `reviews`. */
  review?: ReviewMarks;
  now: number;
  sessions: readonly SessionInfo[];
  repos: readonly RepoTarget[];
  /** Selection mode, when it is on. Absent = the ordinary one-row-at-a-time
   *  screen, which is what this sheet is when there are five rows on it. */
  pick?: { checked: boolean; onToggle: () => void };
  /** The live send queue — what `AttachStrip` reads to decide `sending`. */
  outbox: readonly OutboxEntry[];
  online: boolean;
  repoIdForCwd: (cwd: string) => string | null;
  onAction: (id: ActivityActionId, row: ActivityRow) => void;
  onRetarget: (row: ActivityRow, to: { sessionId: string; cwd: string; mode?: "input" | "backlog" }) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  /** The re-aim panel, open on this row. At most one row shows it, because
   *  opening it closes the "more" strip it was reached from. */
  const [aiming, setAiming] = useState(false);
  /** The check's full reasoning, on this row. Shut by default: the verdict is
   *  one line and the detail is an agent's whole argument, which is worth a tap
   *  and is not worth eighty rows of it. */
  const [checkOpen, setCheckOpen] = useState(false);
  /**
   * The implementation check, when this row is a piece of work the desktop
   * holds. Read off the subject rather than re-derived: `activityRows.ts` owns
   * every DECISION on this screen, and the verdict itself is neither this
   * file's nor the selector's — it is the host's, stored beside the item, and
   * both screens render it with `Backlog.tsx`'s own `CHECK_LABEL`.
   */
  //
  // It arrives as a small keyed map on the sheet's props rather than on the
  // row, and deliberately not through `activityRows.ts`: a check verdict is not
  // lifecycle (`review.ts` keeps it in its own sidecar for exactly that
  // reason), so it is a thing the VIEW renders beside a row and not a thing the
  // selector decides anything from.
  const check = review ?? null;
  const checkDetail = check?.checkStatus && check.checkStatus !== "checking" ? check.checkDetail : undefined;
  /**
   * Does this row name a file at all?
   *
   * The same regex `AttachStrip` runs (`refsIn`), asked here so a row that names
   * nothing mounts no strip — 160 rows each with a component and an effect that
   * exists only to return null is a cost paid on every re-render of a list that
   * ticks every ten seconds. Memoized on the string, which is stable across the
   * clock's re-derivation of the rows.
   */
  const hasFiles = useMemo(() => !!row.attachText && refsIn(row.attachText).length > 0, [row.attachText]);
  // …and only ask the desktop about the ones a thumb can actually reach. See
  // `useInView`: a strip is one repo listing, and this list is ~160 rows deep.
  const [seen, boxRef] = useInView(hasFiles);
  const KindIcon = KIND_ICON[row.kind];
  const StateIcon = STATE_ICON[row.state];
  // Two lists, not one list with a flag. Only the first becomes buttons; the
  // second becomes sentences (`Unavailable`), because a control a person cannot
  // tell apart from a live one at a glance is worse than no control.
  const live = row.actions.filter((a) => !a.disabledReason);
  const blocked = row.actions.filter((a) => a.disabledReason);
  // Nothing pressable is marked primary: lead with the first thing that CAN be
  // pressed. Nothing pressable at all ⇒ no button on the row, and the reasons
  // stand on their own.
  const primary = live.find((a) => a.primary) ?? live[0] ?? null;
  // `alwaysShown` actions (discard, open the session) stay on the face of the
  // row beside primary — the way OUT of a stuck row is not a detail to fold
  // into "more" alongside its minor verbs.
  const shown = live.filter((a) => a !== primary && a.alwaysShown);
  const rest = live.filter((a) => a !== primary && !a.alwaysShown);
  const spinning = row.state === "running" || row.state === "starting";

  const press = (a: ActivityAction) => {
    track(`action:activity.${a.id}`);
    // The one action answered here rather than by the caller: it needs a
    // destination, and the destination is a question this row can ask better
    // than App can (it knows the repo the words were written for).
    if (a.id === "retarget") { setAiming((v) => !v); setOpen(false); return; }
    onAction(a.id, row);
  };

  return (
    <div ref={boxRef} className={`act-row act-${row.bucket}${aiming ? " act-aiming" : ""}${pick ? " act-picking" : ""}${row.dismissedAt != null ? " act-filed" : ""}`}>
      {pick ? (
        <button className={`act-pick${pick.checked ? " on" : ""}`} aria-label={pick.checked ? "deselect" : "select"}
          title={pick.checked ? "deselect this row" : "select this row"} onClick={pick.onToggle}>
          {pick.checked ? <SquareCheck size={18} /> : <Square size={18} />}
        </button>
      ) : null}
      <div className="act-rowmain">
      <button className="act-body" onClick={() => setFull((v) => !v)}
        title={row.clipped || row.fullText ? "tap for the whole thing" : row.title}>
        <span className="act-head">
          <KindIcon size={12} />
          <span className="act-where">{row.where}</span>
          <span className="act-when">{ago(row.at)}</span>
        </span>
        <span className={`act-text${full ? " act-text-full" : ""}`}>
          {full && row.fullText ? row.fullText : row.title}
        </span>
        <span className="act-verdict">
          <StateIcon size={12} className={spinning ? "spin" : undefined} />
          {row.verdict}
        </span>
        {/* The delivery axis, kept apart from the lifecycle on purpose: what a
            row IS doing and what became of what it sent are two questions, and
            merging them is how "unconfirmed" became a terminal state. */}
        {row.delivery ? <span className="act-delivery"><CircleHelp size={11} /> {DELIVERY_TEXT[row.delivery]}</span> : null}
        {/* Cached rows always say how old they are — one sheet forgetting the
            age label is not a crash, it is a screen quietly claiming to be
            current. */}
        {row.asOf != null
          ? <span className="act-stale">last known {ago(row.asOf)} — the desktop is not reachable</span>
          : null}
        {/* A filed row says so on its face. Dismissing is not deleting, and a
            row that looked identical either way would make the difference a
            claim in a tooltip rather than something you can see. */}
        {row.dismissedAt != null
          ? <span className="act-filed-note"><Inbox size={11} /> filed {ago(row.dismissedAt)} — the words are still here</span>
          : null}
        {row.dueAt != null && row.dueAt > now
          ? <span className="act-due"><CalendarClock size={11} /> {inWords(row.dueAt, now)} · {new Date(row.dueAt).toLocaleString()}</span>
          : null}
        {row.progress && row.progress.total > 0 ? (
          <span className="act-prog">
            <span className="act-bar"><i style={{ width: `${Math.min(100, Math.round((row.progress.done / row.progress.total) * 100))}%` }} /></span>
            <span className="act-prog-n">
              {row.progress.label === "bytes"
                ? `${bytes(row.progress.done)} of ${bytes(row.progress.total)}`
                : `${row.progress.done} of ${row.progress.total} ${row.progress.label ?? ""}`}
            </span>
          </span>
        ) : null}
        {row.lastRun ? (
          <span className={`act-last${row.lastRun.ok ? "" : " act-last-bad"}`}>
            last run {ago(row.lastRun.at)}{row.lastRun.late ? " (late)" : ""}{row.lastRun.detail ? ` — ${row.lastRun.detail}` : ""}
          </span>
        ) : null}
        {row.attempts > 1 ? <span className="act-tries">{row.attempts} attempts</span> : null}
      </button>

      {/* A run a rule fired says which and opens it (`fromScheduleWords`, the backlog chip's
          sentence); outside `act-body` for the AttachStrip's reason below. */}
      {row.fromSchedule ? (
        <button className="linkish act-from-sched" title={`open the schedule “${row.fromSchedule.name}” — the rule that ran this`} onClick={() => onAction("openSchedule", row)}>
          <CalendarClock size={11} /> {fromScheduleWords(row.fromSchedule.name)}
        </button>
      ) : null}

      {/* Stalled on the API (R-connection-024), outside `act-body`: it holds buttons. */}
      <NetStalled state={row.state} sessionId={row.sessionId} sessions={sessions} />

      {/* The files this row names, as the files they are — and each of them
          opens full-screen on a tap.

          The complaint: *"I need to be able to see the images here and be able
          to enlarge them"*, over rows reading `file · 1000074690-mtmw2965bdb334.jpg`.
          A minted inbox name is unreadable BY CONSTRUCTION — built not to
          collide, not to be recognised — so a list of them cannot be triaged by
          reading it, which is the one thing this screen is for. This is the
          same `AttachStrip` the queue sheet and the pad draw, in the same
          `compact` mode, with the same `requestAttachOpen` tap: App is the
          single listener, so enlarging needed no wiring here and there is no
          second viewer.

          OUTSIDE the `act-body` button, not inside it: the strip's thumbnails
          are buttons, and a button inside a button is markup no browser agrees
          about. It sits directly under the words, where the pictures belong. */}
      {hasFiles && seen ? (
        <AttachStrip compact text={row.attachText!} repoId={row.cwd ? repoIdForCwd(row.cwd) : null}
          outbox={outbox as OutboxEntry[]} online={online} />
      ) : null}

      {/* What the desktop found when it went and looked. Outside the `act-body`
          button because the detail is a disclosure and a button cannot hold
          one — and the answer to "was this already implemented?" is the one
          thing on a month-old failed row worth reading before its words go out
          a second time. */}
      {check?.checkStatus ? (
        <div className="act-check">
          <button
            className={`bl-check bl-check-${check.checkStatus}`}
            disabled={!checkDetail}
            title={checkDetail ? "tap for the whole check" : check.checkNote || ""}
            onClick={() => setCheckOpen((v) => !v)}
          >
            {/* The verdict's own icon, from the same table as its words — the
                glyphs that used to be glued to the front of the label were two
                emoji and four typographic stand-ins doing an icon's job. */}
            {(() => { const I = checkLook(check.checkStatus).Icon; return <I size={11} style={{ verticalAlign: "-1px" }} />; })()}{" "}
            {checkLook(check.checkStatus).label}{check.checkNote ? ` · ${check.checkNote}` : ""}
            {checkDetail ? (checkOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : null}
          </button>
          {checkDetail && checkOpen ? (
            <div className="bl-check-detail">
              <pre>{checkDetail}</pre>
              {check.checkedAt ? <span className="bl-check-when">checked {new Date(check.checkedAt).toLocaleString()}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {row.targets.length ? (
        <div className="act-targets">
          {row.targets.map((t) => (
            <div key={t.label} className={`act-target act-t-${t.state}`}>
              <span className="act-target-name">{t.label}</span>
              <span className="act-target-state">{t.detail ?? t.state}</span>
              {/* Same rule as the action strip: no session ⇒ no button, and the
                  fact stated instead. A greyed terminal icon on a phone is a
                  guess about whether the tap will do anything. */}
              {t.sessionId
                ? <Button title="open this repo's session"
                    onClick={() => onOpenSession(t.sessionId!)}><Terminal size={14} /></Button>
                : <CantInline>no session</CantInline>}
            </div>
          ))}
        </div>
      ) : null}

      <div className="act-acts">
        {/* The verbs wrap among themselves; "more" is not one of them. In the same wrapping
            line, a long verb ("check whether it is already done") left it alone on a row of
            its own at 390 px, so it sits outside the group, at the end of the first line. */}
        <span className="act-acts-verbs">
          {primary ? <ActionButton a={primary} onPress={() => press(primary)} /> : null}
          {shown.map((a) => <ActionButton key={a.id} a={a} onPress={() => press(a)} />)}
        </span>
        {/* "more" covers the rest of the live controls AND the reasons — a row
            whose only news is what it cannot do keeps that behind one tap like
            everything else, unless there is nothing else at all. */}
        {rest.length || (blocked.length && primary) ? (
          <Button className="act-more" title={open ? "fewer options" : "more options"}
            onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp size={ICON} /> : <ChevronDown size={ICON} />} more
          </Button>
        ) : null}
      </div>
      {open && rest.length ? (
        <div className="act-acts act-acts-more">
          {rest.map((a) => <ActionButton key={a.id} a={a} onPress={() => press(a)} />)}
        </div>
      ) : null}
      {/* What the drawn verbs do, as text — `skipQueueNote` on *run it now*. */}
      {[primary, ...shown, ...(open ? rest : [])].filter((a): a is ActivityAction => !!a?.note).map((a) => (
        <Hint key={`note-${a.id}`}>{a.note}</Hint>
      ))}
      {/* Shown unasked when there is no button on the row: otherwise the row
          ends after its verdict and the person is left to wonder whether the
          controls failed to render. */}
      {blocked.length > 0 && (open || !primary)
        ? <Unavailable cants={blocked.map((a) => ({ label: a.label, reason: a.disabledReason! }))} />
        : null}

      {aiming ? (
        <div className="act-aim">
          <Hint>Keep the words, change where they go.</Hint>
          {sessions.filter((s) => s.running && s.id !== row.sessionId).map((s) => (
            <button key={s.id} className="row"
              onClick={() => { setAiming(false); onRetarget(row, { sessionId: s.id, cwd: s.cwd, mode: "input" }); }}>
              <RowTitle><SendHorizontal size={12} /> {s.title}</RowTitle>
              <SessionName s={s} />
              <RowSub>{s.turnActive ? "working" : "idle"}</RowSub>
            </button>
          ))}
          {/* The shared picker (`RepoPicker.tsx`) — one place asks "which repo?".
              `home` is the repo these words were WRITTEN for, which every picker
              in this app was still asking a row that had already answered. It is
              sorted first and labelled, never preselected: a row may legitimately
              be re-aimed, and a picker that acts on its own is worse than one
              that guesses. */}
          <RepoPicker repos={repos as RepoTarget[]} listClass="" home={row.cwd} subLead="backlog item"
            icon={<CheckCheck size={12} />}
            onPick={(r) => { setAiming(false); onRetarget(row, { sessionId: r.worktreePath, cwd: r.worktreePath, mode: "backlog" }); }} />
        </div>
      ) : null}
      </div>
    </div>
  );
}
