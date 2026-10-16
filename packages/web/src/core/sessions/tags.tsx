/**
 * The chips a session wears — on a launcher row and in the session header
 * alike. One copy, so a session named on both screens wears the same badges.
 *
 * Plain functions over a `SessionInfo`, not components: both screens call them
 * inline in a row of other chips, and each returns `null` when there is
 * nothing to say (a chip with nothing in it is not drawn — never a greyed one).
 */
import type { ReactNode } from "react";
import { Bot, Hourglass, SquareTerminal, Star, Wallet } from "lucide-react";
import { fmtTok, liveAgentText, shellsChipText, shellsSummary, type SessionInfo } from "@waterplane/shared";
import type { BackendList } from "../../backendCaps";
import { budgetTagFacts } from "../../features/sessionBudget";
import { STATUS_LABEL, contextPill, sessionCostPill, sessionStatus, statusPill, type SessionFilter } from "../../sessionFacts";

/**
 * What makes a status badge a FILTER control: the launcher's status filter,
 * handed in by the one list that has one. Omitted ⇒ a plain readout (the
 * session header, the hidden rows).
 */
export interface TagFilter {
  /** Is the list currently cut to this status (unscoped — a row badge says
   *  nothing about a group)? */
  isOn(status: SessionFilter): boolean;
  /** Tap: cut to it, or clear when it is the cut already on. */
  toggle(status: SessionFilter): void;
}

/**
 * Working/idle/waiting/exited badge for a session row.
 *
 * With a `filter` it is a FILTER control (live-session rows): tapping the
 * badge shows only the sessions in that state, tapping the active one clears.
 * It is a span with `role="button"` rather than a real <button> because the
 * row IS a button (opening the session) and a nested one is invalid markup —
 * hence the explicit stopPropagation on both the click and the pointerdown
 * that arms the row drag.
 */
export function statusTags(s: SessionInfo, filter?: TagFilter, fresh?: boolean, backends: BackendList = null): ReactNode {
  const st = sessionStatus(s, backends);
  const tag = (cls0: string, title0: string, body0: ReactNode) => {
    // `fresh`: something new since you last looked — a star ON the status
    // pill rather than a separate "new" chip beside it.
    const cls = fresh ? `${cls0} tag-fresh` : cls0;
    const title = fresh ? `something new since you last looked${title0 ? " · " : ""}${title0}` : title0;
    const body = fresh ? <><Star size={11} fill="currentColor" /> {body0}</> : body0;
    if (!filter) return <span className={`tag ${cls}`} title={title}>{body}</span>;
    const on = filter.isOn(st);
    return (
      <span className={`tag ${cls} tag-filter${on ? " on" : ""}`} role="button" tabIndex={0}
        title={`${title}${title ? " · " : ""}${on ? "showing only these — tap to clear the filter" : `tap to show only the ${STATUS_LABEL[st]} sessions`}`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); filter.toggle(st); } }}
        onClick={(e) => { e.stopPropagation(); filter.toggle(st); }}>
        {body}
      </span>
    );
  };
  // The WORDS are `sessionFacts.ts`'s (`statusPill`), so a session named in
  // the search sheet wears the same badge as the launcher row; what is added
  // here is the filter control, which only the launcher's list has.
  const p = statusPill(s, backends);
  return tag(p.cls, p.title, p.body);
}

// Per-session auto-continue: will THIS session resume itself after a
// usage-limit reset?
//
// Drawn ONLY where this session DISAGREES with the global setting. It used
// to be drawn on every running session, which with the global default on
// meant a lit hourglass on every row in the list — furniture, and worse than
// furniture beside `coding`: a clock glyph on a working session reads as a
// STATE ("this one is waiting on a reset"), which is the opposite of what it
// said. The limit STATE is `statusTags`' job and always was (`limit · auto
// 12:02`), which is why this stands down while `lim.blocked`; the global
// setting is a Settings row, and a row may not repeat it on every session.
// What is left is the exception — the one session somebody set apart — and
// that is what a per-row chip is for.
//
// Both cases are therefore an override by construction (the effective value
// can only differ from the global through one), so the "*" that marked one
// is gone: it marked every chip that is left.
//
// `limitAuto` is the global switch (`useLimitAuto()`, features/limits), read
// by the caller because this is a function and not a component.
export function limitTag(s: SessionInfo, limitAuto: boolean): ReactNode {
  const lim = s.limit;
  if (!lim || lim.blocked || !s.running) return null;
  if (lim.autoContinue === limitAuto) return null;
  if (lim.autoContinue)
    return <span className="tag limit-on" title={`set for this session: auto-continue after a usage-limit reset is ON here — the global setting is off`}><Hourglass size={12} /> auto</span>;
  return <span className="tag limit-off" title={`set for this session: auto-continue after a usage-limit reset is OFF here — the global setting is on, so a hit limit waits for you in this session only`}><Hourglass size={12} /> no auto</span>;
}

// Context-window badge: percent of the window still free (parsed from the TUI).
// Absent until the CLI has printed a figure. Warm colours as it runs low.
export function contextTag(s: SessionInfo): ReactNode {
  const p = contextPill(s);
  return p && <span className={`tag ${p.cls}`} title={p.title}>{p.body}</span>;
}

/**
 * "A turn here costs 4.8× a fresh one."
 *
 * A READOUT, never a control and never a gate: it does not disable anything,
 * it does not intercept a send, and it is absent entirely until the session is
 * actually expensive (`sessionCostPill`). The whole picture is one tap away on
 * the context readout, which is the only thing on this row that can show it.
 */
export function costTag(s: SessionInfo): ReactNode {
  const p = sessionCostPill(s);
  return p && <span className={`tag ${p.cls}`} title={p.title}>{p.body}</span>;
}

/**
 * "agent re-reads 720k" — a subagent under this session is RUNNING on a huge
 * window right now (`ContextSpark.liveAgentTok` ≥ `AGENT_LARGE_TOK`).
 *
 * The same readout rules as `costTag`: absent until there is something to say,
 * `--warn` never `--dead`, and it refuses nothing. The fact is in the chip's
 * own words, not only its `title` (invisible on a phone); the full sentence is
 * on the context sheet this chip sits beside, and in the one toast. Recency is
 * re-asked on the PHONE's clock at render: the spark is rebuilt only when a log
 * moves, so an agent that finished would otherwise stay "running" for ever.
 */
export function liveAgentTag(s: SessionInfo): ReactNode {
  const sp = s.contextSpark;
  const text = s.running ? liveAgentText(sp?.liveAgentTok, sp?.liveAgentAt, Date.now()) : null;
  if (!text || sp?.liveAgentTok == null) return null;
  return <span className="tag cost-heavy" title={`${text}\n\nTap the context readout for the whole picture. Nothing here stops it.`}>
    <Bot size={12} /> {sp.liveAgentType ? `${sp.liveAgentType} ` : "agent "}re-reads {fmtTok(sp.liveAgentTok)}
  </span>;
}

/**
 * The shells chip — a DOOR into the shells sheet, not a filter.
 *
 * `statusPill`'s own "shells" wording (folded into the coding/done badge)
 * already says a session HAS background shells; this is the separate control
 * that opens what each of them IS. Absent (not drawn) when `shellList` has
 * never arrived or arrived empty — capability by presence, same rule
 * `sessionCan` uses: a session on an older host, or one the reader has not
 * been read for yet, offers no door to a sheet with nothing in it.
 */
export function shellsTag(s: SessionInfo, onOpen: () => void): ReactNode {
  const list = s.shellList;
  if (!list?.length) return null;
  const sum = shellsSummary(list, Date.now());
  const cls = sum.working > 0 ? "coding" : "idle";
  return (
    <span className={`tag ${cls} tag-filter`} role="button" tabIndex={0}
      title="tap to see what each background shell is doing"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onOpen(); } }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      <SquareTerminal size={12} /> {shellsChipText(sum)}
    </span>
  );
}

/**
 * How many turns a conversation has run — the number the outline control
 * carries, wherever that control is drawn.
 *
 * One reader for the launcher row, the toolbar and the pinned header item, so
 * three drawings of one control cannot carry three numbers.
 *
 * `contextSpark.turns` is COUNTED off the conversation log's user records by
 * the reader's own turn rule (host `opensTurn`) — deliberately not the length
 * of the series beside it, which has one reading per REQUEST and made this
 * button say 24 over a conversation whose outline listed 4.
 *
 * A FLOOR, and the title says so: a `/btw` typed here writes no log entry and
 * the outline still lists it. ABSENT, never 0, until the log has a turn in it
 * — a zero would be a claim about a conversation nothing has been read from.
 */
export const turnTally = (s: SessionInfo | null | undefined) => s?.contextSpark?.turns || null;
/** The tally as the tail of a title, worded once. */
export const tallyTitle = (n: number | null) => (n == null ? "" : ` · ${n} turn${n === 1 ? "" : "s"} logged so far`);

/**
 * The session's own budget — `$0.31 / $0.50`, a hit, or `budget ? — <why>`.
 *
 * A DOOR into the budget sheet, not a filter and not a gate: the chip words
 * are `features/sessionBudget/logic.ts`'s `budgetTagFacts` (the sentences are
 * shared's), the held-sends clause is in the chip's own text, and an unknown
 * verdict says why in text and holds nothing. Absent without a budget. A span
 * with `role="button"` and the stopPropagation pair, for `shellsTag`'s reason:
 * the launcher row IS a button and the pointerdown arms its drag.
 */
export function budgetTag(s: SessionInfo, onOpen: () => void): ReactNode {
  const f = budgetTagFacts(s, Date.now());
  if (!f) return null;
  return (
    <span className={`tag ${f.cls} tag-filter`} role="button" tabIndex={0} title={f.title}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onOpen(); } }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      <Wallet size={12} /> {f.text}
    </span>
  );
}
