/**
 * One repo on the launcher's ONE list: its header (the roll-up chips, every
 * repo verb, the "⋯" menu), its worktrees as start-point rows, and — unless
 * collapsed — its live sessions, each followed by the agent worktrees it made.
 */
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CalendarClock, Camera, Check, ChevronDown, ChevronRight, CircleDot, CircleSlash, ClipboardCheck, CloudOff, Download, ExternalLink, EyeOff, FileDiff, Flag, FolderTree, GitBranch, Hammer, HeartPulse, Hourglass, Images, ListChecks, ListTodo, Loader, Minus, MoreHorizontal, Plus, ScanEye, SendHorizontal, Star, Terminal, X } from "lucide-react";
import type { SessionInfo } from "@waterplane/shared";
import { branchLabel, horizonWords, isoWeekOf, repoBranchLabel } from "@waterplane/shared";
import { repoAccentStyle } from "../../format";
import { isBudgetHeld } from "../../sendIntent";
import { intentRowKey } from "../../activityRows";
import { queuedChipHeld } from "../../backlogFilter";
import { repoClocksLabel } from "../../clockCuts";
import { isNativeShell } from "../../hostUrl";
import { RepoHealthMenuItem } from "../../RepoHealthRegion";
import { OptInMenuItem } from "../../OptInRegion";
import { gitPending, gitSyncText, gitTitle, noOrigin } from "../../gitCounts";
import { track } from "../../usage";
import { prefRef } from "../prefs";
import { openBuildFor } from "../../features/build";
import { openCaptureFor } from "../../features/capture";
import { openPullRules } from "../../features/pull";
import { openScheduleCut } from "../../features/schedule";
import { openAssessFor, openBacklogCut, openBacklogFor } from "../../features/backlog";
import { openActivity } from "../../features/activity";
import { openRepoHealth, openSetup } from "../../features/setup";
import { healthChip } from "../../healthIndexWords";
import { openBrowseFor, openGalleryFor, openOutboxFor, pickImageFor } from "../../features/images";
import type { LauncherProps } from "./types";
import type { LauncherModel } from "./useLauncherModel";
import { openingText, openingTitle, queuedChipCut, setupMenuLabel, setupMenuTitle, setupTitle } from "./model";
import { SessionRow } from "./SessionRow";
import { ExtBoundary } from "../ExtBoundary";
import { shellBackend } from "../../backendCaps";
import { repoActions, repoChips } from "../extensionPoints";
import { ExtRepoChip } from "./ExtRepoChip";
import { LeftoverHead, LeftoverLine, LeftoverRemove, useLeftovers } from "./LeftoverWorktrees";
import { flaggedChipTitle } from "../sessions/followUpFacts";

const ICON = 16;

export function RepoGroup({ p, m, repoName, sessions: groupSessions }: {
  p: LauncherProps; m: LauncherModel; repoName: string; sessions: SessionInfo[];
}) {
  const { intents, openGitFor } = p;
  const { focusRepo, setOverlay } = p.route;
  const { toggleHideRepo, openingCwds } = p.view;
  const { openRepo, openShell, setBranchPick, refreshRepos } = p.launchCore;
  // Drawn only when this desktop lists a shell backend — an older host has none.
  const canShell = !!shellBackend(p.backends);
  const { enterOldestPending, enterLater } = p.queue;
  const {
    primaryRepo, worktreesOf, attentionByRepo, statusFilter, textOn, collapsedRepos, toggleRepoCollapsed, openFocusWindow,
    statusFilterActive, toggleStatusFilter, waitingRepliesByRepo, queuedByRepo, intentById, clocksPerRepo, starredByRepo, flaggedByRepo,
    repoMenu, setRepoMenu, setCloseAllPick,
  } = m;
  const n = groupSessions.length;
  const main = primaryRepo(repoName);
  const wts = worktreesOf(repoName);
  const wt = wts.length;
  // Worktrees the host names no live owner for — not one whose owner is merely
  // filtered out of view. Each is asked whether anything lives only in it.
  const orphans = wts.filter((t) => !t.ownerSessionId);
  const { readings: leftovers, recheck: recheckLeftovers } = useLeftovers(orphans.map((t) => t.id));
  const leftoverChanged = () => { refreshRepos(); recheckLeftovers(); };
  const att = attentionByRepo.get(repoName) ?? { wait: 0, limit: 0, coding: 0, done: 0, exited: 0 };
  // A filter is an explicit "show me these", so it wins over a collapsed
  // group: leaving the group collapsed would answer the tap by hiding
  // exactly the rows it counted.
  // A repo with nothing running wears the SAME header as one with twelve
  // sessions — chevron, band, type, buttons. It used to be a slimmer chevron-less
  // row, and the owner read that difference as "this repo can do less" (it
  // cannot: same verbs). It stays one line only because it has no chip row.
  const idle = n + wt === 0;
  // An idle repo's fold is NOT the persisted collapsed set: that set defaults to
  // open, and sixteen sessionless repos each opened onto a "no session" line is
  // the wall the slim row was made to avoid. So it starts folded and opening it
  // lasts this screen only — what it reveals is a pointer, not rows to keep.
  const [idleOpen, setIdleOpen] = useState(false);
  // A filter (chip or typed words) shows the rows it found, folded or not.
  const collapsed = idle ? !idleOpen : !statusFilter && !textOn && collapsedRepos.has(repoName);
  // A fold or unfold moves the list to this repo's header. Unfolding left the
  // revealed rows wherever the header happened to sit — often one row above the
  // bottom edge, so the tap seemed to do nothing. Folding from deep inside the
  // group (the header is sticky, so it is tappable there) dropped the rows above
  // the viewport and left the reader at some later repo with the header gone.
  // The header itself is sticky, so its rect is where it is PINNED, not where it
  // lives: the zero-height anchor before it marks the real position.
  // Unfolding goes further (setting `unfoldToEnd`, default on): to the END of
  // what it revealed, so the last row sits at the bottom edge (the sticky header
  // stays pinned above a long group). A group whose end is already on screen is
  // left where it is.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const endRef = useRef<HTMLSpanElement | null>(null);
  const scrollOnFold = useRef(false);
  useLayoutEffect(() => {
    if (!scrollOnFold.current) return;
    scrollOnFold.current = false;
    const a = anchorRef.current;
    const list = a?.closest<HTMLElement>(".list");
    if (!a || !list) return;
    const listTop = list.getBoundingClientRect().top;
    const e = endRef.current;
    if (!collapsed && e && prefRef("unfoldToEnd").current) {
      const end = e.getBoundingClientRect().top - listTop;
      if (end > list.clientHeight) list.scrollTo({ top: list.scrollTop + end - list.clientHeight, behavior: "smooth" });
      return;
    }
    const top = a.getBoundingClientRect().top - listTop + list.scrollTop;
    list.scrollTo({ top, behavior: "smooth" });
  }, [collapsed]);
  const foldToggle = () => {
    scrollOnFold.current = true;
    if (idle) { track("action:repo.collapse"); setIdleOpen((v) => !v); } else toggleRepoCollapsed(repoName);
  };
  const groupHead = (
    <div className={`section repo-group${idle ? " idle" : ""}`} style={repoAccentStyle(repoName)}>
      {/* Every header folds, idle or not: an idle one opens onto a line that
          SAYS nothing is running and points at the "+" (see `idleEmpty`). */}
      {/* Name + the wrapping verbs share one line box; ⋯ and × sit OUTSIDE it
          (`.repo-group-pin`) so a long name or big type moves files/git/build
          onto a second line while those two stay top-right. */}
      <div className="repo-group-line">
      <button className="repo-group-toggle"
        title={idle ? `${collapsed ? "show" : "hide"} — no session open in ${repoName}`
          : collapsed ? `show ${n} session${n === 1 ? "" : "s"}${wt > 0 ? ` and ${wt} worktree${wt === 1 ? "" : "s"}` : ""}`
          : `hide ${n} session${n === 1 ? "" : "s"}${wt > 0 ? ` and ${wt} worktree${wt === 1 ? "" : "s"}` : ""}`}
        onClick={foldToggle}>
        {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
        <span>{repoName}</span>
      </button>
      <span className="repo-group-acts">
        {/* Repo-level affordances, mirrored from where they already live: the
            inbox/untracked count badges the live rows carry, and the build
            button from the "Repos & worktrees" rows. With the group collapsed
            the header stands in for every row, so it has to answer "is there
            anything in the inbox?" and "build it" without expanding first. */}
        {main && (
          // A count on a button is a promise about what opening it shows. The
          // gallery's own default is the outbox in the last 4h, so tapping "42"
          // landed on an empty grid — the badge said 42, the sheet said 0.
          // Carry the scope AND the window the number came from.
          <button className={`focus-btn${main.outboxCount > 0 ? " count" : ""}`}
            title={main.outboxCount > 0 ? `${main.outboxCount} new outbox file${main.outboxCount > 1 ? "s" : ""} since last opened — open files` : `files in ${repoName}`}
            onClick={() => { track("action:repo.files.header"); main.outboxCount > 0 ? openOutboxFor(main.id) : openGalleryFor(main.id); }}>
            <Images size={15} />{main.outboxCount > 0 && main.outboxCount}
          </button>
        )}
        {/* Always drawn: the git view is where a PUSH lives, and commits waiting
            to go out leave the tree clean — gating on changed files hid it
            exactly then. The counts are files, then ↑out ↓in. */}
        {main && (
          <button className={`focus-btn${gitPending(main) ? " count" : ""}`} title={gitTitle(main)}
            onClick={() => openGitFor(main.id)}>
            <FileDiff size={13} />{main.changedCount > 0 && main.changedCount}
            {gitSyncText(main) && <span className="git-ab">{gitSyncText(main)}</span>}
            {noOrigin(main) && <span className="git-ab no-origin"><CloudOff size={12} />no remote</span>}
          </button>
        )}
        {/* Build stays ON the header. It is the rate-limit escape
            hatch — the thing you reach for when a session cannot
            run — so it may not be a tap deeper behind "⋯". Camera,
            first prompt, focus, branch and hide are: seven
            always-on 42px buttons need ~300px, which on a phone
            left no room for the name and broke the strip onto a
            line of its own under every header. */}
        {main && <button className="focus-btn" title={`build ${repoName} (run a build command, no tokens)`} onClick={() => { track("action:repo.build.header"); openBuildFor(main); }}><Hammer size={17} /></button>}
      </span>
      </div>
      <span className="repo-group-pin">
        <button className={`focus-btn${repoMenu === repoName ? " on" : ""}`} aria-label="more actions" aria-expanded={repoMenu === repoName}
          title="more actions" onClick={() => { track("action:repo.more"); setRepoMenu((v) => (v === repoName ? null : repoName)); }}><MoreHorizontal size={17} /></button>
        {n > 0 && (
          <button className="focus-btn danger"
            title={`close sessions in ${repoName} — review the ${n} here, cut by state, idle time, or what is still running underneath`}
            onClick={() => setCloseAllPick(repoName)}><X size={18} /></button>
        )}
      </span>
      {/* Status roll-up: what the rows under this header are doing, in
          the same order and with the same wording as the row badges.
          `waiting` keeps the pulse (it is the one that wants you); the
          rest are quiet counts so a collapsed group still reads at a
          glance. Zero buckets render nothing — a row of "0"s would be
          noise on a phone-width header.
          EVERY chip — session count, worktrees, the roll-up — lives in
          its OWN full-width row under the name. Mixed into the name
          line they wrapped wherever the name happened to run out of
          width, so one group showed two chips beside the name with a
          third dangling underneath while the next split 1/2: ragged,
          per-group header heights, and the counts stopped reading as
          one cluster. The name keeps the line above to itself.
          The roll-up chips are BUTTONS and sit OUTSIDE the collapse
          toggle: each one filters the list to the rows it counts,
          which is the tap everyone tries first, and a button inside
          the toggle button would be invalid markup (and would
          collapse the group on the way past). The total focuses the repo
          and the worktree chip cuts to the worktree rows. */}
      <span className="repo-group-stats">
        {/* **Start something here: now, or later.** The two ways a repo
            begins work, worded and side by side under its name. They were a
            bare "+" among five header icons (found only with a first-run
            word on it) and `send…` one tap deep in "⋯" — so the verb a
            person opens the launcher FOR was the least visible one on it.
            `now` is the empty session, opened at once. `later` is the SAME
            session screen (`enterLater`) with the terminal swapped for the
            sentence that it starts only when its backlog item runs, and the
            compose bar aimed at a new session *when it's free* — the one
            prompt box, paste and drop included, never a second one in a
            sheet. Works with the tunnel down: Send is a backlog row, and
            the chevron's *elsewhere or later…* puts it on a clock.
            Always a "+", never a spinner: what is already in flight is on
            the chip below (see openingCwds); `now` can always start the
            NEXT one. An opened idle repo's empty line points here, so
            `now` is outlined to be found (`.lead`). */}
        {main && (() => {
          const opening = openingCwds.get(main.worktreePath);
          return (
            <span className="repo-start">
              <button className={`repo-start-btn${idle && !collapsed ? " lead" : ""}`}
                title={opening ? `new session in ${repoName} · ${main.branch}, another one now — ${openingTitle(opening)}`
                  : `new session in ${repoName} · ${main.branch}, opened now`}
                onClick={() => { track("action:repo.new.header"); openRepo(main); }}>
                <Plus size={15} />now
              </button>
              <button className="repo-start-btn"
                title={`words for a new session in ${repoName} — held until the repo is free, or on a clock you pick`}
                onClick={() => { track("action:repo.send"); enterLater(main.worktreePath); }}>
                <Plus size={15} />later
              </button>
            </span>
          );
        })()}
        {/* The branch is what the repo row used to say under the
            name, and it is the one fact a repo with nothing
            running still has. With sessions it is redundant — each
            row is titled by its own branch — so it steps aside.
            There is no session-total chip: the owner cut it as not
            worth its width — the status chips beside it already
            split the same rows, and focus is in the ··· menu. */}
        {n === 0 && main && branchLabel(main) && <span className="repo-group-branch" title={`${repoBranchLabel(main)} — nothing running`}>{branchLabel(main)}</span>}
        {/* A count on a control is a filter: the worktree rows under this
            header, plus any session running in one, and nothing else. */}
        {wt > 0 && (
          <button className={`repo-group-stat wt${statusFilterActive("worktrees", repoName) ? " on" : ""}`}
            title={`${wt} open worktree${wt > 1 ? "s" : ""} in ${repoName} — tap to show only those`}
            onClick={() => toggleStatusFilter("worktrees", repoName)}>
            <GitBranch size={13} />{wt}
          </button>
        )}
        {/* The host checks repo wiring on its own (setupwatch.ts) —
            this chip is the only place that check surfaces, since
            the whole point is a repo nobody thought to inspect. No
            chip when the verdict is missing: unchecked is not
            clean, but it is also not something to badge. */}
        {/* Two different questions, two different fields. GATE is
            `issues > 0`, not `!ok`: `ok` means "nothing FAILING", and
            most of these checks can only warn — gating on `!ok` was
            blank on a repo whose checklist was full of amber, and a
            thing to look at is still something to do. STYLE is `!ok`
            (never `failing`, a field the host deleted — it was an
            exact complement of `ok` and `setupwatch.ts` drops it on
            a reload from disk, which read every failing repo as
            amber for up to 6 hours after a restart).
            **Findings live HERE; the menu entry below is the door
            for a repo with none** — a clean or never-inspected repo
            has nothing to badge and still has a checklist to open,
            so the two are not alternatives and neither replaces the
            other. */}
        {(() => {
          // The health index, one chained weekly number. ABSENT on the wire =
          // no chip (never `Health 0`). A called drop wears the warn colour, a
          // called rise the calm one; otherwise it is a plain readout. The tap
          // opens the readings sheet, whose first section is this number.
          const hc = main ? healthChip(main.healthIndex, repoName, isoWeekOf(new Date().toISOString().slice(0, 10))) : null;
          if (!main || !hc) return null;
          const Arrow = hc.arrow === "down" ? ArrowDown : hc.arrow === "up" ? ArrowUp : hc.arrow === "flat" ? Minus : null;
          return (
            <button className={`repo-group-stat health${hc.tone ? ` ${hc.tone}` : ""}`} title={hc.title}
              onClick={() => { track("action:repo.healthindex"); openRepoHealth(main); }}>
              <HeartPulse size={13} />{hc.label}{Arrow ? <Arrow size={12} /> : null}{hc.delta}
            </button>
          );
        })()}
        {main?.setup && main.setup.issues > 0 && (
          <button className={`repo-group-stat ${!main.setup.ok ? "bad" : "warn"}`} title={setupTitle(main.setup)}
            onClick={() => { track("action:repo.setup"); openSetup(main.id, { focus: "findings" }); }}>
            <ListChecks size={13} />{main.setup.issues}
          </button>
        )}
        {(() => {
          // Same receipt the repo row carried: the tap is in the
          // queue, which is otherwise invisible until the session
          // exists. It lives HERE and not on the "+" — a spinner
          // in place of the button reads as "you cannot start
          // another", which is the opposite of what is true.
          const o = main && openingCwds.get(main.worktreePath);
          return o ? (
            <button className="repo-group-stat" title={`${openingTitle(o)} — open its screen`}
              onClick={() => { track("action:repo.pending.open"); enterOldestPending(main!.worktreePath); }}>
              <Loader size={12} className="spin" />{openingText(o)}
            </button>
          ) : null;
        })()}
        {att.limit > 0 && (
          <button className={`repo-group-stat limit${statusFilterActive("limit", repoName) ? " on" : ""}`}
            title={`${att.limit} session${att.limit > 1 ? "s" : ""} in ${repoName} blocked on a usage limit — tap to show only those`}
            onClick={() => toggleStatusFilter("limit", repoName)}>
            <Hourglass size={13} />{att.limit}
          </button>
        )}
        {att.wait > 0 && (
          <button className={`repo-group-wait${statusFilterActive("wait", repoName) ? " on" : ""}`}
            title={`${att.wait} session${att.wait > 1 ? "s" : ""} in ${repoName} waiting for your answer${waitingRepliesByRepo.get(repoName) ? " — some already have a reply on a clock" : ""} — tap to show only those`}
            onClick={() => toggleStatusFilter("wait", repoName)}>
            <CircleDot size={13} />{att.wait} waiting
            {waitingRepliesByRepo.get(repoName) && <CalendarClock size={11} className="wait-sched" />}
          </button>
        )}
        {att.coding > 0 && (
          <button className={`repo-group-stat coding${statusFilterActive("coding", repoName) ? " on" : ""}`}
            title={`${att.coding} session${att.coding > 1 ? "s" : ""} in ${repoName} working — tap to show only those`}
            onClick={() => toggleStatusFilter("coding", repoName)}>
            <Loader size={13} className="spin" />{att.coding}
          </button>
        )}
        {att.done > 0 && (
          <button className={`repo-group-stat done${statusFilterActive("done", repoName) ? " on" : ""}`}
            title={`${att.done} session${att.done > 1 ? "s" : ""} in ${repoName} idle — turn finished; tap to show only those`}
            onClick={() => toggleStatusFilter("done", repoName)}>
            <Check size={13} />{att.done}
          </button>
        )}
        {att.exited > 0 && (
          <button className={`repo-group-stat exited${statusFilterActive("exited", repoName) ? " on" : ""}`}
            title={`${att.exited} exited session${att.exited > 1 ? "s" : ""} in ${repoName} — tap to show only those`}
            onClick={() => toggleStatusFilter("exited", repoName)}>
            <CircleSlash size={11} />{att.exited}
          </button>
        )}
        {(queuedByRepo.get(repoName)?.length ?? 0) > 0 && (() => {
          // Waiting, not running: its own chip because "queued"
          // and "working" are the two states people conflate, and
          // the launcher showed only the second. Taps through to
          // Activity, which is the one screen that follows a
          // piece of work for its whole life.
          //
          // A COUNT ON A CONTROL IS A FILTER: it used to open the
          // unfiltered list — two hundred rows, this repo's
          // fifteen nowhere named, and the reader left to
          // re-derive them. It opens on exactly the rows it
          // counted, by the keys it counted them with, and the
          // sheet says so and carries the way out.
          const keys = queuedByRepo.get(repoName) ?? [];
          const q = keys.length;
          // How many of them the BUDGET is holding, said on the
          // chip: a bare "4" beside a queue that cannot move read
          // as four rows that had gone missing.
          const keySet = new Set(keys);
          // `isBudgetHeld` is the re-time sheet's test too, so
          // this count and *let these N past the budget* agree.
          const heldNow = Date.now();
          const held = intents.filter((i) => keySet.has(intentRowKey(i.id)) && isBudgetHeld(i, heldNow, intentById)).length;
          return (
            <button className="repo-group-stat queued"
              title={`${q} command${q > 1 ? "s" : ""} waiting to run in ${repoName} — on this phone or held by the desktop${held ? `; ${held} held by the usage budget` : ""}. Tap to show only those.`}
              onClick={() => {
                // When every row counted is this repo's queued
                // WORK in one checkout, the tap opens its backlog
                // cut to exactly those — the list where they can
                // be ticked, re-timed together or started past the
                // budget. Activity only reads; it is the fallback
                // for a count that holds phone-side sends too.
                // `queuedChipCut` is the one test of "are these all the
                // Backlog's rows" — a queued build or launch is counted
                // here but is not on that list.
                const cut = queuedChipCut(keys, intents);
                if (cut.kind === "backlog") {
                  track("action:repo.queued.backlog");
                  openBacklogCut(cut.cwd, cut.ids, `the ${q} waiting in ${repoName}`);
                  return;
                }
                track("action:repo.queued.open");
                openActivity({ keys, label: `the ${q} waiting in ${repoName}` });
              }}>
              <Hourglass size={12} />{q}{queuedChipHeld(q, held)}
            </button>
          );
        })()}
        {(clocksPerRepo.get(repoName)?.ids.length ?? 0) > 0 && (() => {
          // **What fires on a clock in THIS repo.** Beside the
          // waiting chip because they are the same question split
          // by WHEN: that one is what is waiting for a turn, this
          // one is what is waiting for an instant. The header's
          // own schedules chip counts the whole desktop, so on a
          // launcher listing fifteen repos it could not answer
          // this without opening the sheet and reading the repo
          // name off every card.
          //
          // A COUNT ON A CONTROL IS A FILTER: the tap carries the
          // ids this number was made of into the sheet, which
          // says so and carries the way out. Same pool, same
          // predicate, same bucketing as the header chip
          // (`clocksByRepo` groups that cut, never re-cuts it).
          const rc = clocksPerRepo.get(repoName)!;
          const n = rc.ids.length;
          const words = horizonWords(rc.horizon);
          return (
            <button className="repo-group-stat"
              title={`${n} thing${n > 1 ? "s" : ""} on a clock in ${repoName}${words ? ` — ${words}` : ""}. Tap to show only those.`}
              onClick={() => {
                track("action:repo.clocks.open");
                openScheduleCut(rc.ids, repoClocksLabel(repoName, n));
              }}>
              <CalendarClock size={12} />{n}
            </button>
          );
        })()}
        {main && repoChips().map((c) => (
          <ExtBoundary key={c.key} feature={c.feature} what={`its ${c.def.id} chip`}><ExtRepoChip def={c.def} repo={main} /></ExtBoundary>
        ))}
        {(starredByRepo.get(repoName) ?? 0) > 0 && (() => {
          // Last chip on the row, because it is the only one that
          // is not a state the rows are IN — it is the mark you
          // left on them.
          const st = starredByRepo.get(repoName) ?? 0;
          return (
            <button className={`repo-group-stat starred${statusFilterActive("starred", repoName) ? " on" : ""}`}
              title={`${st} starred session${st > 1 ? "s" : ""} in ${repoName} — tap to show only those`}
              onClick={() => toggleStatusFilter("starred", repoName)}>
              <Star size={12} fill="currentColor" />{st}
            </button>
          );
        })()}
        {(() => {
          // Beside the star chip, for the reason the flag sits beside the
          // star: the other mark a row carries. The count IS the cut.
          const fl = flaggedByRepo.get(repoName);
          if (!fl) return null;
          return (
            <button className={`repo-group-stat fu-${fl.tone}${statusFilterActive("followup", repoName) ? " on" : ""}`}
              data-hint="session.followup" title={flaggedChipTitle(fl.n, repoName)}
              onClick={() => toggleStatusFilter("followup", repoName)}>
              <Flag size={12} fill="currentColor" />{fl.n}
            </button>
          );
        })()}
      </span>
      {repoMenu === repoName && (
        <div className="row-more">
          {/* First, so a person looking for "a terminal here" finds it
              without reading the whole menu. */}
          {main && canShell && <button className="more-act" title="a plain terminal on the desktop in this repo — no Claude"
            onClick={() => { setRepoMenu(null); openShell(main); }}><Terminal size={ICON} />open a shell here</button>}
          {!focusRepo && <button className="more-act" data-hint="repo.focus" onClick={() => { track("action:repo.focus"); setRepoMenu(null); openFocusWindow(repoName); }}><ExternalLink size={ICON} />{isNativeShell() ? "focus this repo" : "focus window"}</button>}
          {/* The repo TREE, the one entry point that does not need a
              live session: the toolbar's `browse` is derived from the
              ACTIVE SESSION's cwd, so a repo with nothing running could
              not reach its own files at all. */}
          {main && <button className="more-act" onClick={() => { track("action:repo.browse"); setRepoMenu(null); openBrowseFor(main.id); }}><FolderTree size={ICON} />browse files</button>}
          {main && <button className="more-act" onClick={() => { track("action:repo.backlog"); setRepoMenu(null); openBacklogFor(main); }}><ListTodo size={ICON} />backlog</button>}
          {main && <button className="more-act" onClick={() => { track("action:repo.assess"); setRepoMenu(null); openAssessFor(main); }}><ClipboardCheck size={ICON} />what is left</button>}
          {main && repoActions(main).map((a) => (
            <ExtBoundary key={a.key} feature={a.feature} what={`its ${a.id} action`}>
              <button className="more-act" title={a.title} onClick={() => { track(`action:repo.ext.${a.id}`); setRepoMenu(null); a.run(); }}><a.icon size={ICON} />{a.label}</button>
            </ExtBoundary>
          ))}
          {/* The checklist's ALWAYS-ON door. The chip above is a
              FINDINGS badge and says nothing when there is nothing
              to say — so a clean repo, and one the host has not
              inspected yet, had no way into its own checklist from
              the launcher at all. It carries the count too, so the
              verdict is readable from here without going back out
              to the row. */}
          {main && <button className="more-act" title={setupMenuTitle(main.setup)}
            onClick={() => { track("action:repo.setup"); setRepoMenu(null); openSetup(main.id); }}><ListChecks size={ICON} />{setupMenuLabel(main.setup)}</button>}
          {/* What this repo fetches to the phone on its own — the
              rules are PER REPO and stored with the project, so
              the repo row is where they belong. The only door to
              them was the Downloads sheet's rules pane, behind a
              picker holding every repo; from here the repo is
              already chosen. */}
          {main && <button className="more-act" title="what this repo downloads to this phone by itself"
            onClick={() => { track("action:repo.pullrules"); setRepoMenu(null); openPullRules(main.worktreePath); }}><Download size={ICON} />download rules</button>}
          {main && <button className="more-act" onClick={() => { track("action:repo.branch"); setRepoMenu(null); setBranchPick(main); setOverlay("branches"); }}><GitBranch size={ICON} />branch</button>}
          {main && <button className="more-act" data-hint="repo.hide" onClick={() => { track("action:repo.hide"); setRepoMenu(null); toggleHideRepo(main.id); }}><EyeOff size={ICON} />hide</button>}
          {main && <RepoHealthMenuItem repo={main} onOpen={() => { setRepoMenu(null); openRepoHealth(main); }} />}
          {main && <OptInMenuItem onOpen={() => { track("action:repo.optins"); setRepoMenu(null); openSetup(main.id, { region: "optins" }); }} />}
        </div>
      )}
    </div>
  );
  // An agent's worktree sits under the session that made it (`ownerSessionId`,
  // read off the CLI's own subagent records); the rest — and any whose owner is
  // not on screen — stay above the sessions as before.
  const shownIds = new Set(groupSessions.map((s) => s.id));
  const ownedBy = (id: string) => wts.filter((t) => t.ownerSessionId === id);
  const loose = wts.filter((t) => !t.ownerSessionId || !shownIds.has(t.ownerSessionId));
  const wtRow = (t: typeof wts[number]) => (
    <div key={t.id} className={`row-wrap repo-row row-wt${t.ownerSessionId && shownIds.has(t.ownerSessionId) ? " row-wt-owned" : ""}`} style={repoAccentStyle(repoName)}>
      <div className="row grow repo-main" role="button" tabIndex={0}
        onClick={() => openRepo(t)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRepo(t); } }}>
        {/* The branch minus the CLI's `worktree-` prefix — the line below
            already says worktree — and that line names the REPO in its own
            hue: between two session cards a bare branch row read as a
            stranger, not as part of the group it sits in. */}
        <span className="row-title"><span className="wt-branch">{t.branch.replace(/^worktree-/, "")}</span></span>
        <span className="row-sub repo-sub">
          <span className="repo-branch wt-of"><GitBranch size={12} />worktree of <b>{repoName}</b></span>
          {(() => {
            const o = openingCwds.get(t.worktreePath);
            return o ? (
              <button className="row-chip" title={`${openingTitle(o)} — open its screen`}
                onClick={(e) => { e.stopPropagation(); track("action:repo.pending.open"); enterOldestPending(t.worktreePath); }}>
                <Loader size={12} className="spin" />{openingText(o)}
              </button>
            ) : null;
          })()}
          {t.outboxCount > 0 && (
            <button className="row-chip" title={`${t.outboxCount} new outbox file${t.outboxCount > 1 ? "s" : ""} since last opened — open gallery`}
              onClick={(e) => { e.stopPropagation(); track("action:repo.inbox"); openOutboxFor(t.id); }}><Images size={12} />{t.outboxCount}</button>
          )}
          {gitPending(t) && (
            <button className="row-chip" title={gitTitle(t)}
              onClick={(e) => { e.stopPropagation(); track("action:repo.git"); openGitFor(t.id); }}>
              <FileDiff size={12} />{t.changedCount > 0 && t.changedCount}
              {gitSyncText(t) && <span className="git-ab">{gitSyncText(t)}</span>}
            </button>
          )}
          {/* Same split as the repo-group chip above: `issues > 0` gates,
              `!ok` styles — `failing` is gone from the wire. */}
          {t.setup && t.setup.issues > 0 && (
            <button className={`row-chip ${!t.setup.ok ? "bad" : "warn"}`} title={setupTitle(t.setup)}
              onClick={(e) => { e.stopPropagation(); track("action:repo.setup"); openSetup(t.id, { focus: "findings" }); }}><ListChecks size={12} />{t.setup.issues}</button>
          )}
        </span>
        {!t.ownerSessionId && <LeftoverLine r={leftovers.get(t.id)} />}
      </div>
      <button className="row-act" title="send image to this worktree" onClick={() => pickImageFor(t.id)}><Camera size={ICON} /></button>
      {/* The same verb as the repo header's, and the same icon: this
          was the worktree's copy of *first prompt*, wearing the
          pad's NotebookPen. The pad keeps that icon to itself now. */}
      <button className="row-act" title="send words to a new session here — works offline"
        onClick={() => { track("action:repo.send"); enterLater(t.worktreePath); }}><SendHorizontal size={ICON} /></button>
      <button className={`row-act${repoMenu === t.id ? " on" : ""}`} aria-label="more actions" aria-expanded={repoMenu === t.id}
        title="more actions" onClick={() => { track("action:repo.more"); setRepoMenu((v) => (v === t.id ? null : t.id)); }}><MoreHorizontal size={ICON} /></button>
      {repoMenu === t.id && (
        <div className="row-more">
          {canShell && <button className="more-act" title="a plain terminal on the desktop in this worktree — no Claude"
            onClick={() => { setRepoMenu(null); openShell(t); }}><Terminal size={ICON} />open a shell here</button>}
          <button className="more-act" onClick={() => { track("action:repo.build"); setRepoMenu(null); openBuildFor(t); }}><Hammer size={ICON} />build</button>
          <button className="more-act" onClick={() => { track("action:repo.capture"); setRepoMenu(null); openCaptureFor(t); }}><ScanEye size={ICON} />capture</button>
          {/* Same always-on door as the repo header's. */}
          <button className="more-act" title={setupMenuTitle(t.setup)}
            onClick={() => { track("action:repo.setup"); setRepoMenu(null); openSetup(t.id); }}><ListChecks size={ICON} />{setupMenuLabel(t.setup)}</button>
          <button className="more-act" data-hint="repo.hide" onClick={() => { track("action:repo.hide"); setRepoMenu(null); toggleHideRepo(t.id); }}><EyeOff size={ICON} />hide</button>
          {!t.ownerSessionId && <LeftoverRemove t={t} r={leftovers.get(t.id)} onChanged={() => { setRepoMenu(null); leftoverChanged(); }} />}
        </div>
      )}
    </div>
  );
  return (
    <Fragment>
      <span ref={anchorRef} className="repo-group-anchor" aria-hidden />
      {groupHead}
      {idle && !collapsed && (
        <div className="repo-group-empty" style={repoAccentStyle(repoName)}>
          {main ? <>No active session — start one with <Plus size={15} aria-label="plus" />now under the name above.</>
            : "No active session."}
        </div>
      )}
      {!collapsed && <LeftoverHead wts={orphans} readings={leftovers} onChanged={leftoverChanged} />}
      {!collapsed && loose.map(wtRow)}
      {!collapsed && groupSessions.map((s) => (
        <Fragment key={s.id}>
          <SessionRow p={p} m={m} s={s} repoName={repoName} />
          {ownedBy(s.id).map(wtRow)}
        </Fragment>
      ))}
      <span ref={endRef} className="repo-group-anchor" aria-hidden />
    </Fragment>
  );
}
