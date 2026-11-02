import type { ReactNode } from "react";
import { ChevronsUp, CloudOff, FolderTree, Hourglass, KeyRound, Layers, ListOrdered, LogIn, OctagonPause, Play, PlugZap, Power, Settings2, Star, Terminal as TerminalIcon, WifiOff, X } from "lucide-react";
import { NET_RETRY_NOW_NOTE, SIGNED_IN_AGAIN_DETAIL, SIGNIN_UNSURE_DETAIL, blockOf, netRetryLine, type BlockKind, type LimitResumeMode, type SessionInfo } from "@waterplane/shared";
import { track } from "../../usage";
import { SheetHead } from "../../Sheet";
import { ago, clock as hhmm } from "../../format";
import { Empty } from "../../Empty";
import { Explain } from "../../Explain";
import { Unavailable } from "../../Unavailable";
import { RadioRows, Button, FilterBar, Hint, Tag } from "../../kit";
import { useNow } from "../../useNow";
import { openSettingsAt } from "../../settingsFocus";
import { BLOCK_GROUP_HEAD, BLOCK_WORD, blockedGroups } from "../../attention";
import { continueAllLabel, continueAskNote, continueProgressNote, continueUnsureNote, signInHeadline, signInPlan, signInSplit } from "./logic";

interface Props {
  /** EXACTLY the sessions to list — `attentionCut`'s `blocked` bucket, the call the
   *  launcher's "N blocked" chip counts with. The sheet groups them; it never
   *  decides who is in. */
  sessions: SessionInfo[];
  /** "2 of 5 blocked — …" when the list hides some (`cutWords`), null when it
   *  hides nothing; `onToggleAll` widens to all N or narrows back. */
  cut: { words: string | null; showingAll: boolean; total: number; onToggleAll: () => void };
  /** True while the socket is up. Every control here except the two sign-in
   *  ones is a live socket message (deliberately not durable — see below), so
   *  offline they are not drawn and the offline line says why. */
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
  /** Hand a sign-in link to the phone's browser (the session `BlockBar`'s *open*). */
  onOpenLink: (url: string) => void;
  /** Send `/login` into this session — the queue's durable path, as `BlockBar` does. */
  onSendLogin: (s: SessionInfo) => void;
  /** `session.netRetryNow` — the host types `continue` its own way (`BlockBar`'s *retry now*). */
  onNetRetryNow: (id: string) => void;
  /** `session.netRetryCancel` — stop the retry, or hide a gave-up line (`BlockBar`'s cancel / dismiss). */
  onNetRetryCancel: (s: SessionInfo) => void;
  /**
   * The person's *continue* after a sign-in (`signin.continue`, durable — the
   * caller queues it). Present: the sign-in card turns into *Signed in again* /
   * *continue all N* once the host CONFIRMS the sign-in (`SessionInfo.signInWait
   * .signedInAt`), and each such row gets its own *continue*. The sheet owns the
   * split (`signInSplit`), so N and the ids sent are one array; the host types
   * nothing until this is called. Absent, the card offers only the sign-in itself.
   */
  afterSignIn?: { onContinue: (ids: string[]) => void } | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}

/**
 * Why sessions are stuck on something OUTSIDE them, grouped by reason, and what
 * you can do about each — the sheet behind the launcher's "N blocked" chip.
 *
 * Four walls, in this order: **Sign-in** (an account fact: one sign-in clears
 * every session behind it, so the account card comes first), **Network** (the
 * host retrying a turn the CLI gave up on), **Spend** and **Usage limit** (the
 * resume queue: who goes first when the wall lifts). Nothing here fetches — it
 * renders the same `SessionInfo` snapshot the launcher paints from, so it looks
 * the same offline, with the age of what you are reading stated.
 *
 * The queue controls are live socket messages and are not drawn with no link —
 * the offline line says so, never a dimmed button (`Unavailable.tsx`): "resume
 * this one first" delivered twenty minutes late is an instruction about a
 * situation that has since resolved itself. The sign-in verbs are the
 * exception: opening a link needs no desktop, and `/login` rides the send queue
 * like any typed command.
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
const GROUP_ICON: Record<BlockKind, JSX.Element> = {
  auth: <LogIn size={14} />,
  net: <WifiOff size={14} />,
  spend: <Hourglass size={14} />,
  limit: <Hourglass size={14} />,
};

export function BlockedSheet(p: Props) {
  const { sessions, cut, online, seenAt, globalAuto, holdUntil, mode, onSetGlobal, onSetMode, onSetOverride, onSetFirst, onResume, onOpen, onClose } = p;
  const now = useNow(1000);
  // Group by the ONE derivation (`listedBlockOf`, the bucket's own); a session
  // lands in exactly one group, so the rows add up to the chip's number.
  const byKind = blockedGroups(sessions);
  const auth = byKind.get("auth")!;
  // The sign-in card's split: who is still signed out, who can be continued
  // now, who was already tapped. One array feeds the count, the cut and the rows.
  const split = signInSplit(auth);
  const net = byKind.get("net")!;
  // The resume queue's rows, in the host's own queue order — never re-sorted
  // here. A second implementation of "who goes first" would drift from the one
  // that actually decides, and the number on the row would then be decoration.
  const inQueueOrder = (list: SessionInfo[]) => [
    ...list.filter((s) => s.limit?.queuePos != null).sort((a, b) => a.limit!.queuePos! - b.limit!.queuePos!),
    ...list.filter((s) => s.limit?.queuePos == null),
  ];
  const spend = inQueueOrder(byKind.get("spend")!);
  const limit = byKind.get("limit")!;
  const queued = inQueueOrder(limit.filter((s) => s.limit?.queuePos != null));
  const parked = limit.filter((s) => s.limit?.queuePos == null);
  const walls = [...spend, ...limit];
  const anyQueued = walls.some((s) => s.limit?.queuePos != null);
  const holding = holdUntil != null && holdUntil > now;

  /** What is true about this limit/spend session right now, in a sentence. */
  const state = (s: SessionInfo): string => {
    const l = s.limit!;
    if (l.spend && !l.resetAt && !l.nextAttemptAt) return "needs you: add credit or raise the limit, then resume it";
    // The backend's own wall with no time it lifts: nothing is scheduled, its words say why.
    if (l.needsYou && !l.nextAttemptAt) return `needs you — ${l.needsYou}; nothing is retried by itself, resume it once that is sorted`;
    if (l.resuming) return "resuming now — the queue is waiting to see whether it took";
    // Held on a person's words at the desk (`limit.held`): the time it carries is
    // only the host's next look, so the sentence is the reason, never a countdown.
    if (l.held) return `held — ${l.held}`;
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

  /** The row's head: its title opens the session (as every launcher row does). */
  const head = (s: SessionInfo, ev: string, extra?: ReactNode) => (
    <div className="q-head">
      <button className="linkish" onClick={() => { track(`action:${ev}`); onOpen(s.id); }}>
        <TerminalIcon size={13} style={{ verticalAlign: "-2px" }} /> {s.title || s.cwd}
      </button>
      <span className="spacer" />
      {extra}
      {s.starred && <Star size={12} className="star-on" />}
    </div>
  );

  const wallRow = (s: SessionInfo) => {
    const l = s.limit!;
    return (
      <div key={s.id} className={`q-card${l.resuming ? " resuming" : ""}`}>
        {head(s, "limit.session", l.queuePos != null && <Tag className="limit-auto"><Hourglass size={12} /> {l.queuePos}</Tag>)}
        <div className="approve-hint">
          {state(s)}
          {l.resetAt ? ` · ${l.spend ? "spend limit resumes" : "limit resets"} ~${hhmm(l.resetAt)}` : ""}
          {l.blockedSince ? ` · blocked ${ago(l.blockedSince)}` : ""}
          {!s.running ? " · reopens with its conversation" : ""}
        </div>
        {/* Offline the row has no buttons at all and the sheet's offline line
            says why; a manual row has no "go first" or "now", and its state
            sentence says why. Never a dimmed button. */}
        {online && <div className="approve-opts">
          {l.autoContinue && <button
            className={`approve-btn${l.first ? " primary" : ""}`}
            data-hint="limit.first"
            title="Go first — resume this session before the others when the wall lifts"
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

  const netRow = (s: SessionInfo) => {
    const n = s.netRetry!;
    const gaveUp = n.state === "gaveup";
    const line = netRetryLine(n, now);
    return (
      <div key={s.id} className="q-card">
        {head(s, "blocked.net.session")}
        <div className="approve-hint">
          {line ?? BLOCK_WORD.net}{n.dismissed ? " · its line is hidden in the session; the stall stands" : ""}
        </div>
        {n.error && <div className="approve-hint">{n.error}</div>}
        {online && <div className="approve-opts">
          {gaveUp && <button className="approve-btn" title={NET_RETRY_NOW_NOTE}
            onClick={() => { track("action:blocked.net.now"); p.onNetRetryNow(s.id); }}>
            <PlugZap size={14} /> retry now
          </button>}
          {!(gaveUp && n.dismissed) && <button className="approve-btn"
            title={gaveUp ? "hide the session's retry line — work waiting on it stays stalled, with its note on its own row" : "stop the desktop retrying this turn — it types nothing"}
            onClick={() => { track("action:blocked.net.cancel"); p.onNetRetryCancel(s); }}>
            <X size={14} /> {gaveUp ? "dismiss" : "cancel"}
          </button>}
        </div>}
      </div>
    );
  };

  const authRow = (s: SessionInfo) => {
    const unsure = split.unsure.includes(s);
    const ready = split.ready.includes(s) || unsure;
    const flight = split.inFlight.includes(s);
    return (
      <div key={s.id} className="q-card">
        {head(s, "blocked.auth.session")}
        <div className="approve-hint">
          {unsure ? SIGNIN_UNSURE_DETAIL
            : ready ? SIGNED_IN_AGAIN_DETAIL
            : flight ? blockOf(s)?.detail
            : s.login
            ? <>sign-in link shown {ago(s.login.at)}{s.login.awaitingCode ? " · waiting for the code — paste it in this session" : ""}</>
            : s.cliSetup ? "in the CLI's own first-launch setup — open it to finish there"
            : s.signInWait ? "signed out — its turn stopped; sign in above, then continue it"
            : "its last turn stopped: not signed in"}
        </div>
        {/* Offline too: the tap is durable and the host types only into a session still waiting. */}
        {ready && p.afterSignIn && <div className="approve-opts">
          <button className="approve-btn"
            title="Type continue into this session — the desktop does it once the sign-in holds; nothing is typed before this tap"
            onClick={() => { track("action:blocked.auth.continue"); p.afterSignIn!.onContinue([s.id]); }}>
            <Play size={14} /> continue
          </button>
        </div>}
      </div>
    );
  };

  // "Cannot tell" sessions keep the sign-in controls: the person may still need them.
  const sign = signInPlan([...split.out, ...split.unsure]);
  const offer = split.ready.length ? split.ready : split.unsure;
  const groupHead = (k: BlockKind, n: number, hint?: ReactNode, right?: ReactNode) => (
    <div className="section section-head">
      <span>{GROUP_ICON[k]} {BLOCK_GROUP_HEAD[k]} · {n}{hint && <span className="section-hint"> · {hint}</span>}</span>
      {right}
    </div>
  );

  return (
    <div className="sheet">
      {/* The count only over a list: a "0" above a body that says "Nothing is
          blocked" was the same fact twice. */}
      <SheetHead title={<><OctagonPause size={16} /> Blocked</>} onClose={onClose}>
        {sessions.length > 0 && <span className="muted">{sessions.length}</span>}
      </SheetHead>

      {/* What this list is NOT showing, above it (a count is a filter). */}
      {cut.words && !cut.showingAll && (
        <FilterBar section onClear={cut.onToggleAll} clearLabel="show all" clearTitle="list every blocked session, hidden and unfocused repos included">
          {cut.words}
        </FilterBar>
      )}
      {cut.showingAll && (
        <FilterBar section onClear={cut.onToggleAll} clearLabel="only these in view" clearTitle="back to the sessions the launcher's chip counted">
          all {cut.total} blocked, hidden and unfocused repos included
        </FilterBar>
      )}

      {!online && (
        <Hint>
          <CloudOff size={13} style={{ verticalAlign: "-2px" }} />{" "}
          offline — {seenAt ? <>this is the state as of {ago(seenAt)}</> : <>nothing has been synced to this device yet</>}.
          The retry and queue buttons need the host, so they are back with the link rather than queueing: which
          session should go first is a decision about right now. Signing in still works from here, and continue after a sign-in is kept and sent when the link is back.
        </Hint>
      )}

      {sessions.length === 0 && (
        <Empty>
          {/* One sentence and a closed `?`, no icon: the schedules sheet's
              empty state, in the same shape. The head already carries the icon. */}
          {cut.words ? "Nothing in view is blocked." : "Nothing is blocked."}{" "}
          <Explain of="the blocked list" label="what lands here?">
            A session signed out, out of credit, at a usage limit, or with the desktop retrying a network error.
            When several hit the same wall, they queue up here and resume one at a time.
          </Explain>
        </Empty>
      )}

      <div className="list">
        {auth.length > 0 && <>
          {groupHead("auth", auth.length, "one sign-in clears all of them")}
          {/* The ACCOUNT card first: signing in is one act for every session
              behind it, so it is not a per-row button. */}
          <div className="q-card">
            <div className="approve-q">
              <KeyRound size={14} style={{ verticalAlign: "-2px" }} /> {signInHeadline(split)}
            </div>
            {(split.out.length + split.unsure.length) > 0 && sign.kind === "link" && <>
              <div className="approve-hint">
                sign in with the link {sign.from.title || "a session"} printed {ago(sign.from.login!.at)}
                {sign.from.login!.awaitingCode ? " — then paste the code there (tap its title below)" : ""}
              </div>
              <div className="approve-opts">
                <button className="approve-btn primary" onClick={() => { track("action:blocked.auth.link"); p.onOpenLink(sign.url); }}>
                  <KeyRound size={14} /> open the sign-in link
                </button>
              </div>
            </>}
            {(split.out.length + split.unsure.length) > 0 && sign.kind === "login" && <>
              <div className="approve-hint">
                sends /login to {sign.target.title || "one of them"}, which prints the sign-in link here
              </div>
              <div className="approve-opts">
                <button className="approve-btn primary" onClick={() => { track("action:blocked.auth.login"); p.onSendLogin(sign.target); }}>
                  <LogIn size={14} /> sign in (sends /login)
                </button>
              </div>
            </>}
            {(split.out.length + split.unsure.length) > 0 && sign.kind === "setup" && (
              <div className="approve-hint">
                {sign.why}
              </div>
            )}
            {/* The host confirmed the sign-in → ASK. Nothing is typed before this tap
                (owner, 2026-11-02); N is exactly the ids the tap sends. */}
            {p.afterSignIn && offer.length > 0 && <>
              <div className="approve-hint">{split.ready.length ? continueAskNote(offer.length, online) : continueUnsureNote(offer.length, online)}</div>
              <div className="approve-opts">
                <button className="approve-btn primary"
                  onClick={() => { track("action:blocked.auth.continueAll"); p.afterSignIn!.onContinue(offer.map((s) => s.id)); }}>
                  <Play size={14} /> {continueAllLabel(offer.length)}
                </button>
              </div>
            </>}
            {continueProgressNote(split) && <div className="approve-hint">{continueProgressNote(split)}</div>}
          </div>
          {auth.map(authRow)}
        </>}

        {net.length > 0 && <>
          {groupHead("net", net.length, "the desktop retries these by itself")}
          {net.map(netRow)}
        </>}

        {spend.length > 0 && <>
          {groupHead("spend", spend.length, "add credit or raise the limit")}
          {spend.map(wallRow)}
        </>}

        {limit.length > 0 && <>
          {groupHead("limit", limit.length, queued.length > 0 ? MODE_TEXT[mode].hint : undefined)}
          {/* All three modes, drawn — a standing preference with three values is
              a choice among three, not a verb cycling through them. */}
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
          {holding && (
            <Hint>
              A resume just came back still blocked, so the limit has not actually reset. Nothing else will spend an
              attempt until {hhmm(holdUntil!)} — tap <b>now</b> on a session to override that.
            </Hint>
          )}
          {queued.length > 1 && mode !== "one" && (
            <Hint>
              The first session still goes alone — if it comes back still blocked, nothing else spends an attempt on the
              same wall. The rest follow once one of them provably starts working again.
            </Hint>
          )}
          {queued.map(wallRow)}
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
          {parked.map(wallRow)}
        </>}
      </div>

      {/* A verb that has nothing to act on is not drawn, never dimmed: with
          nothing blocked the empty sentence above is the reason, with nothing
          in line the "Not resuming" head is, and offline the offline line is. */}
      <div className="sheet-actions">
        {online && anyQueued && <Button data-hint="limit.resumeall"
          title={`Stop waiting for the clock — the queue starts now, ${MODE_TEXT[mode].label}`}
          onClick={() => { track("action:limit.resumeall"); onResume(); }}
        ><Play size={16} /> resume all</Button>}
        {online && walls.length > 0 && <Button data-hint="limit.starredonly"
          title="Only starred sessions resume by themselves; the rest wait for you"
          onClick={() => {
            track("action:limit.starredonly");
            for (const s of walls) onSetOverride(s.id, !!s.starred);
          }}
        ><Star size={16} /> starred only</Button>}
        {online && <Button
          className={globalAuto ? "active" : ""} data-hint="limit.global"
          title="The global switch: whether a session resumes itself at all once a usage or spend limit resets"
          onClick={() => { track("action:limit.global"); onSetGlobal(!globalAuto); }}
        ><Power size={16} /> auto {globalAuto ? "on" : "off"}</Button>}
        <Button onClick={onClose}><X size={16} /> close</Button>
      </div>
    </div>
  );
}
