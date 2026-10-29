/**
 * What a session IS, as facts a row can show — written once, for every list.
 *
 * The launcher's live list answers "what is this session doing, where did it
 * start, where is it now, how long has it been open" in one row. Every OTHER
 * list of sessions in the app answered a subset of that, or none of it: the
 * search sheet's result header carried a title, a repo label and a hit count,
 * so a match in a session you had forgotten about named a session you could
 * not identify — the launcher row two taps away knew all of it.
 *
 * So the derivations live here rather than as closures inside `App.tsx`, and
 * the pills are returned as PARTS (`cls` / `title` / `body`) rather than as
 * markup: the launcher wraps them in a filter control, other lists render them
 * plain, and neither can drift from the other's wording. `App.tsx`'s
 * `statusTags`/`contextTag` are the wrappers; `SessionFacts` is the plain one.
 */
import type { ReactNode } from "react";
import { Bot, Brain, CircleDot, Clock, Hourglass, Link2, Loader, Terminal, TrendingUp } from "lucide-react";
import type { RepoTarget, SessionCostReading, SessionInfo } from "@waterplane/shared";
import { PromptPair } from "./PromptPair";
import { repoLabel, peerJobLine, peerJobOriginText, peerSpendSplit, peerWaitWords, sessionCostOf, shellsSummary } from "@waterplane/shared";
import { ago, dur, hhmm } from "./format";
import { isShellBackend, type BackendList } from "./backendCaps";
import { isFlagged } from "./core/sessions/followUpFacts.ts";
import { liveLaunch } from "./liveLaunch";
import { RowSub } from "./kit/Row";
import { Tag } from "./kit/Tag";

/**
 * The ONE definition of "what is this session doing" — the row badge
 * (`statusTags`), the per-repo header roll-up and the status FILTER all read
 * it, so the three can never disagree. Buckets are mutually exclusive and
 * ordered exited > limit > waiting > done > coding: a session lands in exactly
 * one, so the header's counts sum to its row count and tapping a count always
 * yields that many rows. Three independent copies of this ladder drifted the
 * moment a state was added, and a header that disagrees with the rows it stands
 * for is worse than no header badge at all.
 */
export type SessionStatus = "exited" | "limit" | "wait" | "done" | "coding";

export function sessionStatus(s: SessionInfo, backends: BackendList = null): SessionStatus {
  if (!s.running) return "exited";
  if (s.limit?.blocked) return "limit";
  // A dialog we could not parse into options is still blocked on you.
  // …and so is a turn that ENDED on a question: the CLI takes typing, but the
  // work does not move until you answer, and `done` said the opposite.
  if (s.prompt || s.awaitingInput || s.asking) return "wait";
  // A shell has no turns, so nothing ever marks it idle — and "no idle yet" is
  // what reads as "coding". A turnless session is never working.
  if (isShellBackend(backends, s.backend)) return "done";
  // A quiet MAIN loop is not a quiet session: a background agent outlives the
  // turn that launched it, so a session waiting on two of them is working, and
  // `done` (the row, the roll-up count and the filter, all three) said the work
  // had finished while the terminal counted "2 agents · ↓ 73.4k tokens". The
  // fact is read off the CLI's own logs (host `agents.ts`), so it is absent
  // rather than wrong when nothing can be read.
  // Background shells (a `run_in_background` Bash, a Monitor) are the same
  // fact by another route — the CLI's own session record (host `readCliStatus`).
  // `shellList` (host `shells.ts`) is the newer, richer reading: a shell that
  // is only WAITING in a loop (`workers === 0`) or gone QUIET is not "still
  // coding" the way a real worker is — but it is not nothing either, so it
  // stays visible with a chip (`statusPill`) rather than counting toward the
  // working spinner. An older host (no `shellList`, only the boolean `shells`)
  // keeps reading `coding`, exactly as it always has.
  if (s.idle) {
    if (s.agents?.length) return "coding";
    if (s.shellList) {
      // Only a shell with real workers under it is work. A `waiting` one is a
      // poll loop that only sleeps between checks — counting it read "coding"
      // on a session sitting at an empty prompt with nothing running.
      return shellsSummary(s.shellList, Date.now()).working > 0 ? "coding" : "done";
    }
    return s.shells ? "coding" : "done";
  }
  return "coding";
}

/**
 * What the live list can be filtered DOWN to. Every `SessionStatus`, plus
 * `starred` — which is not a status at all: a star is a mark the user put on a
 * session by hand ("come back to this one"), orthogonal to what it is doing, and
 * therefore the one filter you cannot reach by tapping a badge that already says
 * what a row is up to. It rides on the same filter state rather than a second
 * one, because two independent filters would need a rule for what "starred AND
 * working, in this repo" shows and the launcher has no room to say which of them
 * is in force.
 *
 * `"followup"` is the star's twin — the follow-up flag, set by hand, by a
 * launch option or by the session's agent (R-sessions-045), one predicate for
 * the chip and the cut (`isFlagged`).
 *
 * `"shells"` is the same shape of exception: a session runs background shells
 * or it does not, independent of `sessionStatus` (a session with only quiet
 * shells reads `done`, one with a working shell reads `coding` — either may
 * carry the filter).
 */
/** `worktrees` is a session running in one of a repo's other checkouts — the
 *  header's worktree chip. Only the launcher can tell (it needs the repo list),
 *  so `matchesFilterKind` answers false for it and the launcher decides. */
export type SessionFilter = SessionStatus | "starred" | "followup" | "shells" | "worktrees";

/** Words for a filter, used by the filter bar and every chip title. */
export const STATUS_LABEL: Record<SessionFilter, string> = {
  exited: "exited", limit: "at the usage limit", wait: "waiting for your answer", done: "idle", coding: "working",
  starred: "starred", followup: "flagged for follow up", shells: "running background shells", worktrees: "worktrees",
};

/**
 * Does this session match a filter's KIND? (The `repo` half is applied by the
 * caller, which is the only place that can resolve a session to its repo name.)
 */
export function matchesFilterKind(s: SessionInfo, kind: SessionFilter, backends: BackendList = null): boolean {
  if (kind === "starred") return !!s.starred;
  if (kind === "followup") return isFlagged(s);
  if (kind === "shells") return !!s.shellList?.length;
  if (kind === "worktrees") return false;
  return sessionStatus(s, backends) === kind;
}

export const shortModel = (m?: string) => (m ? m.replace(/^claude-/, "") : "");

/**
 * How this session was launched: backend · model · effort · permission mode.
 *
 * `backendLabel` is passed only for a session running something OTHER than
 * claude (`backendCaps.backendMark`, which answers null for claude, for an
 * undescribed backend and for every host that never sent a `backends` frame).
 * So a claude session's row is character-for-character what it always was —
 * the marker is earned by being different, not paid for by everyone. It leads
 * because it is the fact that reframes the three after it: `sonnet` under one
 * binary and under another are not the same launch.
 */
export function launchLabel(
  o: { model?: string; effort?: string; permissionMode?: string; backend?: string },
  backendLabel?: string | null,
  backends: BackendList = null,
): string {
  // A shell has no model to be "default" — say only that it is one.
  if (isShellBackend(backends, o.backend)) return backendLabel || "Shell";
  return [backendLabel || null, shortModel(o.model) || "default", o.effort, o.permissionMode && o.permissionMode !== "default" ? o.permissionMode : null]
    .filter(Boolean).join(" · ");
}

/** A pill as its parts, so a caller decides whether it is also a control. */
export interface Pill { cls: string; title: string; body: ReactNode }

/** The status badge's class, tooltip and contents — the words, without the tag. */
export function statusPill(s: SessionInfo, backends: BackendList = null): Pill {
  const st = sessionStatus(s, backends);
  if (st === "exited") return { cls: "dead", title: "", body: "exited" };
  const lim = s.limit;
  if (st === "limit" && lim?.needsYou && !lim.nextAttemptAt) {
    // A wall the backend's own channel reported with no time it lifts (Gemini's credit wall): the
    // host schedules nothing, so the row says it is the person's, in the backend's words.
    return {
      cls: "limit-manual",
      title: `blocked — it needs you: ${lim.needsYou}; resume it once that is sorted`,
      body: <><Hourglass size={12} /> blocked · needs you</>,
    };
  }
  if (st === "limit" && lim?.spend) {
    // An API account out of credit or over a spend limit: not a plan window, so no "usage" and no
    // invented clock. A time is worded only where the host has one (a printed reset or the period's).
    const at = lim.nextAttemptAt ?? lim.resetAt;
    return {
      cls: lim.autoContinue && at ? "limit-auto" : "limit-manual",
      title: at
        ? `at a spend limit — resumes ~${hhmm(at)}${lim.attempts ? ` · attempt ${lim.attempts}` : ""}`
        : "at a spend limit — it needs you: add credit or raise the limit, then resume",
      body: <><Hourglass size={12} /> {at ? `spend · resumes ${hhmm(at)}` : "spend limit · needs you"}</>,
    };
  }
  if (st === "limit" && lim) {
    // Wording dodges the limit.ts detection regexes (this file printed inside
    // a session must not trip them).
    const title = lim.autoContinue
      ? `at the usage limit${lim.resetAt ? ` — reset ~${hhmm(lim.resetAt)}` : ""}${lim.nextAttemptAt ? `; "continue" is scheduled for ${hhmm(lim.nextAttemptAt)}` : ""}${lim.attempts ? ` · attempt ${lim.attempts}` : ""}`
      : "at the usage limit — auto-continue is off for this session, resume manually";
    // The QUEUE PLACE belongs on the row, not only in the sheet: several rows
    // reading "limit · auto 12:02" is what made a group block look like five
    // sessions about to fire at the same instant. `#2` says the opposite —
    // they go one at a time — without opening anything.
    const place = lim.resuming ? " · resuming" : lim.queuePos && lim.queuePos > 1 ? ` · #${lim.queuePos}` : "";
    // Both are "at the usage limit" and both wear `--limit`; the manual one is
    // filled because it is the one that needs a hand. It used to be `"wait"`,
    // which is the red pill an open question box gets — so a row nobody had to
    // touch looked exactly like one that was blocking on an answer.
    return {
      cls: lim.autoContinue ? "limit-auto" : "limit-manual",
      title: title + (lim.queuePos ? ` · #${lim.queuePos} in the resume queue (they resume one at a time)` : ""),
      body: <><Hourglass size={12} /> limit{lim.autoContinue ? (lim.nextAttemptAt ? ` · auto ${hhmm(lim.nextAttemptAt)}` : " · auto") : " · manual"}{place}</>,
    };
  }
  if (st === "wait") {
    // Three shapes of waiting, one pill: a parsed box (the buttons say the
    // rest), an unparsable dialog, and a turn that ended on a question in
    // prose. The third names ITSELF in the tooltip, because unlike the other
    // two there is nothing on screen to go and look at — the composer is empty
    // and the ask has scrolled up.
    const title = s.prompt ? ""
      : s.awaitingInput ? "a dialog is open in the CLI — open the session to answer"
      : s.asking ? `the turn ended on a question — “${s.asking.text}”`
      : "";
    return { cls: "wait", title, body: <><CircleDot size={12} /> {s.asking && !s.prompt && !s.awaitingInput ? "asked you" : "waiting"}</> };
  }
  if (st === "done" && isShellBackend(backends, s.backend)) {
    return { cls: "idle", title: "a plain shell — it has no turns to finish", body: <><Terminal size={12} /> shell</> };
  }
  if (st === "done") {
    // A session can be `done` and still be running quiet/unknown background
    // shells (`sessionStatus`) — not counted in the working spinner, but not
    // nothing either. That fact is `shellsTag`'s (`core/sessions/tags.tsx`),
    // drawn as its OWN chip beside this one — not folded in here, or a row
    // wearing both drew the same words twice.
    return {
      cls: "idle",
      title: "",
      body: <>done{s.idleSince ? ` · ${ago(s.idleSince)}` : ""}</>,
    };
  }
  // Working, but not on its own turn: the row says WHOSE work it is, because
  // "coding" on a session whose composer is free reads as a session you cannot
  // type into, and this is the opposite — you can, and something is still
  // running underneath.
  const agents = s.agents?.length ?? 0;
  if (agents && s.idle) {
    return {
      cls: "coding",
      title: s.agents!.map((a) => a.what).join(" · ") + " — open the session to see what they are doing",
      body: <><Bot size={12} /> {agents} agent{agents === 1 ? "" : "s"}</>,
    };
  }
  // A session with only background shells working (no agents) is
  // still `coding` (`sessionStatus`), but the shell-specific words are
  // `shellsTag`'s own chip, drawn separately — this pill stays the plain
  // spinner it always was, whatever is running underneath.
  return { cls: "coding", title: "", body: <><Loader size={12} className="spin" /> coding</> };
}

/**
 * "waiting on pc · 4 min" — the session handed a job to a peer desktop and is
 * waiting for its report. The words are `shared/peer.ts`'s (`peerWaitWords`,
 * the age read off the PHONE's clock `now`); null when there is nothing true
 * to say. Plain parts: the launcher row wraps it in a tap
 * (`features/peers` `PeerWaitTag`), other lists draw it as is.
 */
export function peerWaitPill(s: SessionInfo, now: number = Date.now()): Pill | null {
  const text = peerWaitWords(s.peerWait, now);
  if (!text) return null;
  const st = s.peerWait?.state;
  const bad = st === "failed" || st === "refused" || st === "unreachable";
  return { cls: bad ? "limit" : "wait", title: "", body: <><Link2 size={12} /> {text}</> };
}

/**
 * What this session cost SPLIT by desktop — "$22.28 here + $0.84 on pc" — once
 * it has handed a job to a peer whose cost came back. Never one summed figure:
 * the halves were measured on two machines (`shared/peer.ts`'s `peerSpendSplit`).
 * Null when no job of this session carries a cost.
 */
export function peerSpendPill(s: SessionInfo): Pill | null {
  const split = peerSpendSplit(s.contextSpark?.costUsd, s.peerJobs);
  if (!split) return null;
  return {
    cls: "idle",
    title: `${split.text} — list-price estimates, each measured on the desktop that spent it; never added into one figure`,
    body: <><Link2 size={12} /> {split.text}</>,
  };
}

/**
 * On the PEER: why this session exists — "job from mac · <asking session> ·
 * <label>" (`peerJobOriginText`). Null for every session that is not a job's.
 */
export function peerOriginPill(s: SessionInfo): Pill | null {
  const text = peerJobOriginText(s.peerJob);
  if (!text) return null;
  return { cls: "idle", title: `${text} — another desktop handed this session its work; its answer goes back there`, body: <><Link2 size={12} /> {text}</> };
}

/** One line per job this session handed to a peer — "sent to pc: run e2e · done · $0.84 · 6 min". */
export function peerJobLines(s: SessionInfo): { key: string; text: string; bad: boolean }[] {
  return (s.peerJobs ?? []).flatMap((j) => {
    const text = peerJobLine(j);
    return text ? [{ key: j.jobId, text, bad: j.state === "failed" || j.state === "refused" || j.state === "unreachable" }] : [];
  });
}

/**
 * Context-window badge: percent of the window still free (parsed from the TUI).
 * Null until the CLI has printed a figure. Warm colours as it runs low.
 */
export function contextPill(s: SessionInfo): Pill | null {
  if (!s.running || s.contextLeft == null) return null;
  const pct = s.contextLeft;
  return {
    cls: pct <= 15 ? "ctx-low" : pct <= 40 ? "ctx-mid" : "ctx-ok",
    title: `${pct}% of the context window free`,
    body: <><Brain size={12} /> {pct}%</>,
  };
}

/**
 * What a turn in this session costs, against a fresh one — as a badge.
 *
 * Deliberately NOT folded into `contextPill`, which is a different fact wearing
 * similar units: that one says how much window is LEFT, i.e. when the CLI will
 * compact. This one says what the next turn PRICES AT. A session at 40% free is
 * comfortable by the first measure and the most expensive thing on the desktop
 * by the second, and collapsing them would hide exactly that case.
 *
 * Null until there is something worth saying, which is the whole contract: a
 * badge that is always lit is furniture. An exited session gets none either —
 * there is no next turn to price.
 */
export function sessionCostPill(s: SessionInfo): (Pill & { reading: SessionCostReading }) | null {
  if (!s.running) return null;
  // The clock is read HERE, at render, and never carried from the host: a
  // warm/cold flag computed on the desktop is stale by the time it arrives,
  // and a phone that has been asleep for three hours has to recompute this
  // rather than redraw it. `lastTurnAt` is the CLI's own record of its newest
  // turn and is already on `SessionInfo` — nothing new rides the wire for it.
  const r = sessionCostOf(s.contextSpark, { lastTurnAt: s.lastTurnAt, turnActive: s.turnActive, now: Date.now() });
  if (!r || !r.chip) return null;
  return {
    // Two weights of the SAME amber, and never the red: this is a reminder
    // about price, not a fault. `--dead` and `--limit` both already mean
    // something is wrong or stopped, and a cost chip in either would be read as
    // a session that has broken. `steep` earns the filled treatment because it
    // is the case the measurement says dominates a week's usage.
    cls: r.level === "steep" ? "cost-steep" : r.level === "heavy" ? "cost-heavy" : "cost-warm",
    title: `${r.note}${r.advice ? `\n\n${r.advice}` : ""}\n\nTap the context readout for the whole picture. Nothing here stops you.`,
    body: <><TrendingUp size={12} /> {r.chip}</>,
    reading: r,
  };
}

/**
 * The launcher row's facts, rendered plain — no filters, no drag, no actions.
 *
 * For every OTHER list that names a session (the search sheet's result header
 * today). It deliberately shows the same four things in the same order the
 * launcher row does — status, how it was launched, how long it has been open,
 * and the "first … last prompt" gist — because a session identified two ways is
 * a session you have to identify twice.
 */
export function SessionFacts({ s, repoLabel, backendLabel, backends }: {
  s: SessionInfo;
  /** "<repo> · <branch>", when the caller knows it and the title does not say. */
  repoLabel?: string;
  /** The backend's own label, ONLY when it is not claude — the caller holds
   *  the `backends` list, this file does not. Absent ⇒ the row is unchanged. */
  backendLabel?: string | null;
  /** The host's backends list: a shell is a backend of kind `shell`, not the id "shell". */
  backends?: BackendList;
}) {
  const st = statusPill(s, backends);
  const ctx = contextPill(s);
  const cost = sessionCostPill(s);
  const peer = peerWaitPill(s);
  const spend = peerSpendPill(s);
  const origin = peerOriginPill(s);
  const jobs = peerJobLines(s);
  // Spans, not divs: the search sheet renders this INSIDE its result-header
  // button, and a <div> in a <button> is invalid markup (the same rule that
  // keeps the launcher's filter pills spans with role="button").
  return (
    <span className="sess-facts">
      <span className="sess-facts-tags">
        <Tag className={st.cls} title={st.title}>{st.body}</Tag>
        {ctx && <Tag className={ctx.cls} title={ctx.title}>{ctx.body}</Tag>}
        {cost && <Tag className={cost.cls} title={cost.title}>{cost.body}</Tag>}
        {peer && <Tag className={peer.cls} title={peer.title}>{peer.body}</Tag>}
        {spend && <Tag className={spend.cls} title={spend.title}>{spend.body}</Tag>}
        {origin && <Tag className={origin.cls} title={origin.title}>{origin.body}</Tag>}
        <RowSub className="row-launch">{launchLabel(liveLaunch(s), backendLabel, backends)}</RowSub>
        {s.createdAt && s.running && (
          <RowSub title={`session open for ${dur(s.createdAt)} — started ${new Date(s.createdAt).toLocaleString()}`}>
            <Clock size={11} /> {dur(s.createdAt)}
          </RowSub>
        )}
        {repoLabel && <RowSub>{repoLabel}</RowSub>}
      </span>
      {jobs.map((j) => <RowSub key={j.key} className={`peer-job-line${j.bad ? " warn" : ""}`}>{j.text}</RowSub>)}
      <PromptPair firstPrompt={s.firstPrompt} lastPrompt={s.lastPrompt} pinnedPrompt={s.pinnedPrompt} />
    </span>
  );
}

/**
 * The id that makes a reopen land on THIS conversation and no other — the ONE
 * place a row is asked for it.
 *
 * `resumeSessionId` on a `session.create` is a single wire field, but the id
 * that goes in it comes from one of two places depending on which binary wrote
 * the conversation: claude's own uuid (`claudeSessionId`, the basename of the
 * jsonl it keeps) or the backend's own id (`backendSessionId`, opencode's
 * `ses_…`). They are two fields on purpose — every log reader in the daemon
 * turns the first into a path under `~/.claude/projects`, so an opencode id
 * there is a reader pointed at a file that will never exist
 * (`shared/wire/session.ts`) — and they are never both set on one row, so the
 * `??` is a choice between a value and an absence, not a precedence rule.
 *
 * Why a function and not `a ?? b` at the four reopen call sites: it was
 * `claudeSessionId` alone at all four, which for an opencode row is always
 * `undefined` — so every reopen fell through to the directory's `--continue`
 * and, with two closed conversations in one repo, tapping the OLDER row carried
 * on the NEWER one. Silently: the row said "reopen", the session opened, and
 * nothing on screen was wrong except which conversation you were in. Four
 * hand-written copies of this is how one of them goes back to reading a single
 * field.
 *
 * **Absent is a real answer.** The host discovers a backend id only when
 * exactly one candidate matches, so a row may legitimately have neither — and
 * then the reopen IS approximate, which is what `resumeHint` and the sentence
 * on the row say out loud rather than leaving the person to find out.
 *
 * Pinned by `createOp.test.mjs`: a reopen site that reads a session-id field
 * directly fails there, by name.
 */
export function resumeIdOf(r: { claudeSessionId?: string; backendSessionId?: string }): string | undefined {
  return r.claudeSessionId ?? r.backendSessionId;
}

/**
 * What a reopen/resume row's `title` may say about what it will do.
 *
 * Backend-neutral on purpose. These titles used to read "claude --resume,
 * exactly this conversation" / "claude --continue" on every row including the
 * ones that run something else entirely — asserting a command the row would
 * never run, and naming the wrong binary while doing it. The alternative,
 * naming each backend's own flag, would put a second copy of the host's argv
 * table on the phone (`backends/opencode.ts` spells it `--session <id>`), which
 * is exactly the two-tables-that-must-agree problem `backendCaps.ts` exists to
 * avoid. So this says the EFFECT, which is the part that is true for every
 * backend and is also the part a person is deciding about.
 *
 * (A `title` is invisible on a phone — `Unavailable.tsx`. This is the desktop
 * tab's copy of a fact the row itself states in words when it matters.)
 */
export function resumeHint(exact: boolean): string {
  return exact
    ? "resumes exactly this conversation"
    : "carries on this folder’s most recent conversation — which may not be this one";
}


/** Group repos by name (alpha), primary repo first, worktrees beneath it by branch. */
export function groupByRepo(list: RepoTarget[]): RepoTarget[] {
  return [...list].sort((a, b) =>
    repoLabel(a).localeCompare(repoLabel(b)) ||
    (a.isPrimary === b.isPrimary ? a.branch.localeCompare(b.branch) : a.isPrimary ? -1 : 1));
}
