import { ChevronsUp, CloudOff, FolderTree, Hourglass, Layers, ListOrdered, Play, Power, Settings2, Star, Terminal as TerminalIcon, X } from "lucide-react";
import type { LimitResumeMode, SessionInfo } from "@waterplane/shared";
import { track } from "./usage";
import { SheetHead } from "./Sheet";
import { ago, clock as hhmm } from "./format";
import { Empty } from "./Empty";
import { Explain } from "./Explain";
import { Unavailable } from "./Unavailable";
import { RadioRows, Button, Hint, Tag } from "./kit";
import { openSettingsAt } from "./settingsFocus";

interface Props {
  /** Every session — the blocked ones are what this lists. */
  sessions: SessionInfo[];
  /** True while the socket is up. Every control here is a live socket message
   *  (deliberately not durable — see below), so offline they are not drawn and
   *  the offline line says why, rather than being tapped into a void. */
  online: boolean;
  /** When the session list last came from the host. */
  seenAt: number | null;
  /** The global auto-continue switch. */
  globalAuto: boolean;
  /** How the queue releases sessions once the limit lifts (host-persisted). */
  mode: LimitResumeMode;
  /** Set while the host is holding off because a resume came back still blocked. */
  holdUntil: number | null;
  onSetGlobal: (enabled: boolean) => void;
  onSetMode: (mode: LimitResumeMode) => void;
  onSetOverride: (id: string, override: boolean | null) => void;
  onSetFirst: (id: string, on: boolean) => void;
  /** Resume one session now, or (no id) everything queued — still one at a time. */
  onResume: (id?: string) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}

/**
 * Who resumes first, when the limit lifts.
 *
 * A plan limit is an ACCOUNT fact, so sessions do not hit it one at a time —
 * every session working at that moment blocks, and each parses the same reset
 * instant out of the same banner. The launcher showed that honestly (five rows
 * reading `limit · auto 12:02`) and there was nothing to do about it: the only
 * controls were a global on/off and a per-session toggle buried in one
 * session's toolbar, so "these five, in this order, and not that one" could not
 * be said at all.
 *
 * The host now resumes them one at a time; this is where the line is read and
 * steered. Nothing here fetches — it renders the same `SessionInfo` snapshot
 * the launcher paints from, so it looks the same offline, with the age of what
 * you are reading stated rather than implied. The controls themselves are live
 * socket messages and are not drawn with no link — the offline line says so,
 * never a dimmed button (`Unavailable.tsx`): unlike a prompt, "resume this
 * one first" delivered twenty minutes late is an instruction about a situation
 * that has since resolved itself, which is the same reason `session.kill` and
 * the backlog mutations are not durable either.
 */
const MODES: LimitResumeMode[] = ["one", "repo", "all"];
/** The three release modes as a phone reads them: what the queue does, and the
 *  one sentence of why it might be what you want. */
const MODE_ICON: Record<LimitResumeMode, JSX.Element> = {
  one: <ListOrdered size={16} />,
  repo: <FolderTree size={16} />,
  all: <Layers size={16} />,
};
/** Why you would pick each one — the sentence the cycle button had no room for.
 * closed: keyed by this sheet's own MODES list */
const MODE_TITLE: Record<LimitResumeMode, string> = {
  one: "One session resumes at a time, in the order below — the safest, and the slowest",
  repo: "One session per repo at a time: never two agents in one worktree, but different repos run in parallel",
  all: "Every blocked session resumes together, once the first one provably works again",
};
const MODE_TEXT: Record<LimitResumeMode, { label: string; hint: string; row: string }> = {
  one: {
    label: "one at a time",
    hint: "one at a time, in this order",
    row: "goes after the ones above",
  },
  repo: {
    label: "one per repo",
    hint: "one per repo at a time, in this order",
    row: "goes once this repo is free",
  },
  all: {
    label: "all at once",
    hint: "all of them, once the first resume works",
    row: "goes with the rest",
  },
};

export function LimitSheet({
  sessions, online, seenAt, globalAuto, holdUntil, mode,
  onSetGlobal, onSetMode, onSetOverride, onSetFirst, onResume, onOpen, onClose,
}: Props) {
  // Blocked sessions, in the host's own queue order — never re-sorted here. A
  // second implementation of "who goes first" would drift from the one that
  // actually decides, and the number on the row would then be decoration.
  const blocked = sessions.filter((s) => s.limit?.blocked);
  const queued = blocked.filter((s) => s.limit!.queuePos != null)
    .sort((a, b) => a.limit!.queuePos! - b.limit!.queuePos!);
  const parked = blocked.filter((s) => s.limit!.queuePos == null);
  const holding = holdUntil != null && holdUntil > Date.now();

  /** What is true about this session right now, in a sentence. */
  const state = (s: SessionInfo): string => {
    const l = s.limit!;
    if (l.spend && !l.resetAt && !l.nextAttemptAt) return "spend limit — needs you: add credit or raise the limit, then resume it";
    // The backend's own wall with no time it lifts: nothing is scheduled, its words say why.
    if (l.needsYou && !l.nextAttemptAt) return `needs you — ${l.needsYou}; nothing is retried by itself, resume it once that is sorted`;
    if (l.resuming) return "resuming now — the queue is waiting to see whether it took";
    // A manual row draws no "go first" and no "now" (never dimmed ones), so its
    // sentence carries why they are missing.
    if (!l.autoContinue) return `manual${l.attempts ? ` · ${l.attempts} attempt${l.attempts > 1 ? "s" : ""} made` : ""} — it waits for you; go first and now need it on`;
    if (l.queuePos === 1) {
      if (holding) return `next up · held off until ${hhmm(holdUntil!)}`;
      return l.nextAttemptAt ? `next up · continues at ${hhmm(l.nextAttemptAt)}` : "next up";
    }
    if (l.queuePos != null) return `#${l.queuePos} in line · ${MODE_TEXT[mode].row}`;
    if (l.attempts) return `stopped after ${l.attempts} attempt${l.attempts > 1 ? "s" : ""}`;
    return "waiting";
  };

  const row = (s: SessionInfo) => {
    const l = s.limit!;
    return (
      <div key={s.id} className={`q-card${l.resuming ? " resuming" : ""}`}>
        <div className="q-head">
          <button className="linkish" onClick={() => { track("action:limit.session"); onOpen(s.id); }}>
            <TerminalIcon size={13} style={{ verticalAlign: "-2px" }} /> {s.title || s.cwd}
          </button>
          <span className="spacer" />
          {l.queuePos != null && <Tag className="limit-auto"><Hourglass size={12} /> {l.queuePos}</Tag>}
          {s.starred && <Star size={12} className="star-on" />}
        </div>
        <div className="approve-hint">
          {state(s)}
          {l.resetAt ? ` · ${l.spend ? "spend limit resumes" : "limit resets"} ~${hhmm(l.resetAt)}` : ""}
          {l.blockedSince ? ` · blocked ${ago(l.blockedSince)}` : ""}
        </div>
        {/* Offline the row has no buttons at all and the sheet's offline line
            says why; a manual row has no "go first" or "now", and its state
            sentence says why. Never a dimmed button. */}
        {online && <div className="approve-opts">
          {l.autoContinue && <button
            className={`approve-btn${l.first ? " primary" : ""}`}
            data-hint="limit.first"
            title="Go first — resume this session before the others when the limit lifts"
            onClick={() => { track("action:limit.first"); onSetFirst(s.id, !l.first); }}
          ><ChevronsUp size={14} /> {l.first ? "first" : "go first"}</button>}
          <button
            className="approve-btn"
            data-hint="limit.auto"
            title={l.autoContinue ? "Stop this session resuming by itself" : "Let this session resume by itself again"}
            onClick={() => {
              track("action:limit.auto");
              // Explicit override rather than "inherit": the point of this sheet
              // is choosing between sessions, and inherit says nothing about
              // THIS one. Matching the global value clears it back to inherit.
              const next = !l.autoContinue;
              onSetOverride(s.id, next === globalAuto ? null : next);
            }}
          ><Power size={14} /> {l.autoContinue ? "off" : "on"}</button>
          {l.autoContinue && <button
            className="approve-btn"
            data-hint="limit.resumeone"
            title="Resume this one now, without waiting for the reset time"
            onClick={() => { track("action:limit.resumeone"); onResume(s.id); }}
          ><Play size={14} /> now</button>}
        </div>}
      </div>
    );
  };

  return (
    <div className="sheet">
      {/* The count only over a list: a "0" above a body that says "Nothing is
          blocked" was the same fact twice. */}
      <SheetHead title={<><Hourglass size={16} /> Usage limit</>} onClose={onClose}>
        {blocked.length > 0 && <span className="muted">{blocked.length}</span>}
      </SheetHead>

      {!online && (
        <Hint>
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} />{" "}
          offline — {seenAt ? <>this is the state as of {ago(seenAt)}</> : <>nothing has been synced to this device yet</>}.
          The buttons need the host, so they are back with the link rather than queueing: which session should go first
          is a decision about right now.
        </Hint>
      )}

      {holding && (
        <Hint>
          A resume just came back still blocked, so the limit has not actually reset. Nothing else will spend an
          attempt until {hhmm(holdUntil!)} — tap <b>now</b> on a session to override that.
        </Hint>
      )}

      {blocked.length === 0 && (
        <Empty>
          {/* One sentence and a closed `?`, no icon: the schedules sheet's
              empty state, in the same shape. The head already carries the
              hourglass. */}
          Nothing is blocked on a usage limit.{" "}
          <Explain of="the queue" label="what is the queue?">
            When several sessions hit the limit together, they queue up here and resume one at a time.
          </Explain>
        </Empty>
      )}

      {queued.length > 0 && (
        <div className="section section-head">
          <span>In line <span className="section-hint">· {MODE_TEXT[mode].hint}</span></span>
        </div>
      )}
      {blocked.length > 0 && <>
      {/* All three modes, drawn. This was one button cycling through them,
          showing only the mode you were already in — so "one per repo", the
          answer to "never run two agents in one worktree at once", could not be
          found by looking: nothing on the screen said it existed. A standing
          preference with three values is a choice among three, not a verb. */}
      <div className="mode-row" data-hint="limit.mode">
        {online
          ? <RadioRows
              label="how many resume at once"
              options={MODES.map((m) => ({ key: m, label: <>{MODE_ICON[m]} {MODE_TEXT[m].label}</>, title: MODE_TITLE[m] }))}
              value={mode}
              onChange={(m) => { track(`action:limit.mode.${m}`); onSetMode(m); }} />
          // Offline the mode is still worth READING — it is what will happen at
          // the reset — so it is stated, and the verb that is gone is named.
          : <Unavailable cants={[{ label: "changing how many resume at once", reason: `there is no link to the desktop · it stays ${MODE_TEXT[mode].label}` }]} />}
      </div>
      </>}
      {queued.length > 1 && mode !== "one" && (
        <Hint>
          The first session still goes alone — if it comes back still blocked, nothing else spends an attempt on the
          same wall. The rest follow once one of them provably starts working again.
        </Hint>
      )}
      <div className="list">
        {queued.map(row)}
        {parked.length > 0 && (
          <div className="section section-head">
            <span>Not resuming <span className="section-hint">· auto-continue is off for these</span></span>
            {/* Each row's own on/off is below; this is the default new
                sessions start with, which is what parked most of them. */}
            <Button onClick={() => openSettingsAt("limit-auto")}>
              <Settings2 size={14} /> default
            </Button>
          </div>
        )}
        {parked.map(row)}
      </div>

      {/* A verb that has nothing to act on is not drawn, never dimmed: with
          nothing blocked the empty sentence above is the reason, with nothing
          in line the "Not resuming" head is, and offline the offline line is. */}
      <div className="sheet-actions">
        {online && queued.length > 0 && <Button data-hint="limit.resumeall"
          title={`Stop waiting for the clock — the queue starts now, ${MODE_TEXT[mode].label}`}
          onClick={() => { track("action:limit.resumeall"); onResume(); }}
        ><Play size={16} /> resume all</Button>}
        {online && blocked.length > 0 && <Button data-hint="limit.starredonly"
          title="Only starred sessions resume by themselves; the rest wait for you"
          onClick={() => {
            track("action:limit.starredonly");
            for (const s of blocked) onSetOverride(s.id, !!s.starred);
          }}
        ><Star size={16} /> starred only</Button>}
        {online && <Button
          className={globalAuto ? "active" : ""} data-hint="limit.global"
          title="The global switch: whether a session resumes itself at all once a limit resets"
          onClick={() => { track("action:limit.global"); onSetGlobal(!globalAuto); }}
        ><Power size={16} /> auto {globalAuto ? "on" : "off"}</Button>}
        <Button onClick={onClose}><X size={16} /> close</Button>
      </div>
    </div>
  );
}
