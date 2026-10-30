/**
 * The launcher: the screen with no session on it. Topbar (brand, the nav menu,
 * the readings that must be seen unprompted), the queue bars and banners, and
 * the ONE list — every repo with its sessions and worktrees — then the
 * recently-closed, recent and hidden lists; or the external `claude`
 * processes, when that view is chosen.
 *
 * Props are what App owns (`types.ts`); a feature's state is read here through
 * its index; the launcher's own state is `useLauncherModel`'s.
 */
import { useLayoutEffect, useRef } from "react";
import { useBackStep } from "../../backStep";
import { Archive, ArrowDownUp, Boxes, CalendarClock, Camera, ChevronsDownUp, ChevronsUpDown, CircleDot, CloudOff, Download, Eraser, Flag, Gauge, Hourglass, Images, ListOrdered, ListRestart, ListTodo, Loader, Menu, MessageSquare, NotebookPen, Plus, RotateCw, ScrollText, Search, Settings, ShieldAlert, Split, SquareTerminal, Star, Terminal as TerminalIcon, Waypoints, X } from "lucide-react";
import { BRAND, branchLabel, repoLabel } from "@waterplane/shared";
import { Empty } from "../../Empty";
import { Logo } from "../Logo";
import { NetActivity } from "../../NetActivity";
import { HintToggle } from "../../HintLayer";
import { ago, baseName, repoAccentStyle } from "../../format";
import { STATUS_LABEL } from "../../sessionFacts";
import { flaggedChipTitle } from "../sessions/followUpFacts";
import { nativeInstallSupported } from "../../nativeInstall";
import { openAppsOnReady } from "../../appsPane";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { RISKY_PERM_MODES } from "../settings/permModes";
import { CliHealthChip } from "../../features/cliHealth";
import { useUsageFace } from "../../features/tokens";
import { UsageChip } from "./UsageChip";
import { BellButton } from "../../features/notifications";
import { openDecisions } from "../../features/plugins";
import { openSentLog } from "../../features/sentLog";
import { DemoStartCue } from "../../features/demoTour";
import { openSearch } from "../../features/search";
import { openSchedules } from "../../features/schedule";
import { openActivity } from "../../features/activity";
import { pickImageFor } from "../../features/images";
import { takeShot, useHostPush } from "../../features/hostTools";
import { HostMenuItem, HostSwitchKey } from "../../features/hosts";
import { FirstRunCard } from "../../features/onboard";
import { WhatsNewLauncherRow } from "../../features/whatsnew";
import { enterDemo, isDemo } from "../../demo/mode";
import { isNativeShell } from "../../hostUrl";
import type { LauncherProps } from "./types";
import { launcherScroll, useLauncherModel } from "./useLauncherModel";
import { noReposWords } from "./model";
import { listRead } from "../../listRead";
import { RepoGroup } from "./RepoGroup";
import { ClosedRows } from "./ClosedRows";
import { CloseSheet } from "./CloseSheet";
import { LauncherItemKeys, LauncherItems, LauncherMenuBadge } from "./LauncherItems";
import { Button } from "../../kit/Button";
import { Row, RowTitle, RowSub } from "../../kit/Row";
import { Hint } from "../../kit/Hint";
import { SHEET } from "../../sheetNames";

export type { LauncherProps } from "./types";
export { openShotPick } from "./useLauncherModel";

const ICON = 16;

/**
 * The app mark in the topbar is `<Logo>`: the brand SVG inlined into the bundle,
 * not an `<img>`. (The old PNG existed because the Android shell's local server
 * could not serve an `.svg` it could not name; an inlined mark never asks.)
 */

/**
 * How old a repo listing may get before the launcher says so.
 *
 * `refreshRepos` runs on every socket state change and on every session switch,
 * so on a live link the answer is always seconds. Past this the listing is one
 * the host has not confirmed since — which is exactly the case where the rows
 * on screen are a memory, and the difference between "these are the repos" and
 * "these were the repos" is the difference between a tap that opens a session
 * and a tap that fails.
 */
const REPOS_STALE_MS = 60_000;

export function LauncherScreen(p: LauncherProps) {
  const m = useLauncherModel(p);
  const { sessions, recent, repos, reposAt, reposFailAt, launch } = p;
  const noReposText = noReposWords(listRead({ rows: repos, readAt: reposAt }));
  const { status, connVisible } = p.conn;
  const { tailscaleIp } = p.conn.info;
  const { focusRepo, setOverlay, lastVisitedId } = p.route;
  const { visibleRepos } = p.view;
  const { openCwd, refreshRepos } = p.launchCore;
  const { clearExited } = p.verbs;
  const {
    tab, setTab, navMenu, setNavMenu, dl, appsReady, activityBadge, activityKeys, visibleSessions, visibleExternal, clearFocus, repoGroups,
    sessionOrder, resetSessionOrder, waitingTotal, waitingRepliesTotal, limitTotal, codingTotal, starredTotal, flaggedTotal, shellsTotal,
    statusFilter, setStatusFilter, statusFilterActive, toggleStatusFilter, shownSessions, sortedSessions,
    textQuery, setTextQuery, textOn, noRepoCollapsed,
    allReposCollapsed, persistCollapsedRepos, scheduleWords, scheduleLead, scheduleTitle, setCloseAllPick,
    shotPick, setShotPick, repoForCwd,
  } = m;
  // The screenshot repo picker: Back shuts it, never exits the app from under it.
  useBackStep(shotPick, () => setShotPick(false));
  const face = useUsageFace(); // windows (subscription) / dollars (api, cloud) / a bare door
  const push = useHostPush();

  // Returning to the launcher — from a session or from a sheet — React remounts
  // the list, which would snap it to the top. Restore the saved scroll offset,
  // then pull the just-visited row into view if it's off-screen (row order is
  // stable now, but sessions opened or closed meanwhile still shift it).
  // useLayoutEffect ⇒ before paint, no flash.
  const listRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = launcherScroll.top;
    if (!lastVisitedId) return;
    const row = el.querySelector<HTMLElement>(`[data-sid="${CSS.escape(lastVisitedId)}"]`);
    if (!row) return;
    const er = el.getBoundingClientRect(), rr = row.getBoundingClientRect();
    if (rr.top < er.top || rr.bottom > er.bottom) row.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: restore the scroll once when the list mounts, not as rows move
  }, []);

  return (
    <div className="screen">
      <header className="topbar">
        {focusRepo ? (
          <div className="brand brand-focus" style={repoAccentStyle(focusRepo)}>
            <Logo size={32} label="" /><span>{focusRepo}</span>
            <button className="focus-clear" title="exit repo focus — show all repos" onClick={clearFocus}><X size={14} /></button>
          </div>
        ) : (
          // The wordmark is the one thing on this bar that says nothing a reading
          // could not: at phone width it pushed the gear onto a second row all by
          // itself. The MARK stays (it is the tap-free identity and the app icon
          // people match against); the text goes, and its space becomes chips.
          // The host switcher is a row in the menu (Android shell): a long
          // desktop name here took the whole bar for a rarely asked question.
          // 40 = `.topbar > .key`'s min-height: the mark is as tall as the buttons beside it.
          <div className="brand"><Logo size={40} /></div>
        )}
        {launch.permissionMode && RISKY_PERM_MODES.has(launch.permissionMode) && (
          // Standing reminder: the launch default is armed to skip every
          // approval, and it persists across reloads. It should not be
          // discoverable only by reopening the settings sheet.
          <Button
            variant="danger"
            title={`New sessions launch with --permission-mode ${launch.permissionMode}: every tool call runs without asking. Tap to change it.`}
            onClick={() => setOverlay("settings")}
          >
            <ShieldAlert size={ICON} /> no approvals
          </Button>
        )}
        {/* Nine navigation chips wrapped onto three rows above the first
            repo. They are one tap into a sheet and nothing more, so they go
            behind one button; what STAYS on the bar is every reading that has
            to be seen without being looked for (usage, CLI health, the
            no-approvals warning, notifications) plus settings.

            `data-nohint` for the same reason the `?` chip carries it: in
            explain mode every button is intercepted, and a container control
            that explained itself instead of opening would put the explain
            toggle it holds out of reach. The items inside stay explainable. */}
        {/* Explain mode is global — the same `?` the session header carries,
            ON the bar (it was inside the menu) so the two screens match, and
            gone from both once the one-time ask is answered "remove it". */}
        <HintToggle compact />
        <Button className={`nav-key${navMenu ? " on" : ""}`} data-nohint
          aria-label="menu" aria-expanded={navMenu}
          title={`menu — new, pad, activity, search, files, downloads, archive, logs, local/external${tab === "external" ? "\nshowing: external processes" : ""}`}
          onClick={() => { track("action:nav.menu"); setNavMenu((v) => !v); }}>
          {/* Icon only. The topbar is brand + menu + usage + health + bell +
              settings, and two spelled-out labels ("menu", "settings") were
              what pushed it onto a second row on a phone — the one row where
              every readout is supposed to be seen without being looked for.
              A hamburger and a cog are the two glyphs that need no word; the
              title and aria-label still carry it for a screen reader and a
              long-press. */}
          <Menu size={ICON} />
          {/* Which VIEW you are in has to stay on screen now that the segmented
              bar is gone: the external list is the one state where the launcher
              shows none of your repos, and "everything vanished" must not be
              the only clue. The tab lives behind the button, so the button says
              when it is not the default. */}
          {tab === "external" && <span className="nav-tab"><TerminalIcon size={12} /> external</span>}
          {/* Downloads are the one thing in this app that runs with nothing
              open — no session, no sheet, often no screen on. Every other
              readout of them appears only while a transfer is in flight (the
              strip) or while you are already in the sheet, so the count went
              on the one control that is on screen on every launcher. Bytes,
              not files, and it disappears entirely when nothing is moving. */}
          {dl.active > 0 && (
            <span className={`nav-dl${dl.stuck ? " warn" : ""}`}>
              <Download size={11} /> {dl.pct}%
            </span>
          )}
          {/* The counts follow their buttons in: a badge that only exists
              while the menu is open is a badge nobody sees. Summed over every
              counted line inside (activity, apps ready, extension items); the
              inventories (local/external, files on the phone) are not news. */}
          <LauncherMenuBadge base={activityBadge + (nativeInstallSupported() ? appsReady : 0)} />
        </Button>
        {navMenu && (
          <div className="row-more nav-more">
            {isNativeShell() && <HostMenuItem size={ICON} onOpen={() => setNavMenu(false)} />}
            <button className="more-act" onClick={() => { setNavMenu(false); setOverlay("new"); }}><Plus size={ICON} />new</button>
            <button className="more-act" title="prompt pad — write a thought now, decide where it goes later"
              onClick={() => { setNavMenu(false); setOverlay("pad"); }}><NotebookPen size={ICON} />pad</button>
            {/* Where a posted piece of work is found afterwards. It has to be on
                the launcher and not behind the recovery bar: that bar appears only
                while something is in flight, and "what happened to the thing I
                sent an hour ago" is asked precisely when nothing is. The same
                argument the archive entry two buttons along is built on — an entry
                point that exists only when there is something pending is
                unreachable at the moment you want to ask whether anything is.
                The badge rides on it and does not replace it: a standing button
                and a count are not in conflict, and only one of them can be
                zero. */}
            <button className="more-act" data-hint="activity.open"
              title="activity — every prompt, sweep, build, schedule and download you posted, with what became of it. Select rows here to deal with many at once."
              onClick={() => {
                track("overlay:activity"); setNavMenu(false);
                // A count is a filter: with a number on it, the tap opens those rows.
                openActivity(activityKeys.length ? { keys: activityKeys, label: `the ${activityKeys.length} ${activityKeys.length === 1 ? "row" : "rows"} still open` } : null);
              }}>
              <ListOrdered size={ICON} />activity
              {activityBadge > 0 && <span className="mic-badge">{activityBadge}</span>}
            </button>
            <button className="more-act" title="search words across all sessions"
              onClick={() => { setNavMenu(false); openSearch(null); }}><Search size={ICON} />search</button>
            <button className="more-act" onClick={() => { setNavMenu(false); setOverlay("gallery"); }}><Images size={ICON} />files</button>
            {/* The route to the downloads when nothing is downloading. The
                PullBar strip is rendered only while a transfer is ACTIVE, so
                the finished files ("on this phone · tap to save it") and the
                per-repo rules were reachable only through Settings → Data
                usage — three taps and a section nobody looks in for a file.
                Same argument as activity and archive two buttons along: an
                entry point that exists only while something is pending is
                missing at the moment you want to ask whether anything is. The
                2px rule along the bottom edge is the progress, costing no
                height; the label says the count either way. */}
            <button className={`more-act${dl.active > 0 ? " has-bar" : ""}`}
              title={dl.active > 0
                ? `downloads — ${dl.active} in flight, ${dl.pct}% of the bytes here${dl.stuck ? " (something is stopped)" : ""}`
                : "downloads — files fetched to this phone, and what each repo fetches on its own"}
              onClick={() => { track("overlay:pull"); setNavMenu(false); setOverlay("pull"); }}>
              <Download size={ICON} />downloads
              {dl.active > 0 ? ` ${dl.active} · ${dl.pct}%` : dl.onPhone > 0 ? ` ${dl.onPhone}` : ""}
              {dl.active > 0 && <span className={`more-dl-bar${dl.stuck ? " warn" : ""}`} style={{ width: `${dl.pct}%` }} />}
            </button>
            {/* The route back to a session closed long enough ago that it has
                rolled off "Recently closed". Lives here, not in that section's
                header, because the section disappears once the shortlist empties —
                which is exactly when the archive is the only way back. */}
            {/* Your own apps, and which of them install themselves. Its own
                entry rather than a switch inside Downloads: that sheet is
                about transfers, and a setting reachable only from the
                transfer that happened to bring the file is one you cannot
                survey — which is how a downloaded build could turn a silent
                installer on with nowhere to see the list afterwards. Drawn in
                the Android shell only: a browser has no installer to offer,
                and an entry that opens a screen saying "not here" is worse
                than no entry. */}
            {nativeInstallSupported() && (
              <button className="more-act"
                title={appsReady > 0
                  ? `apps — ${appsReady} build${appsReady === 1 ? "" : "s"} ready to install`
                  : "apps — builds from your repos, and which install themselves"}
                onClick={() => {
                  track("overlay:apps");
                  // The count is a filter: `2 ready` opens exactly those two.
                  if (appsReady > 0) openAppsOnReady();
                  setNavMenu(false); setOverlay("apps");
                }}>
                <Boxes size={ICON} />apps{appsReady > 0 ? ` · ${appsReady} ready` : ""}
              </button>
            )}
            <button className="more-act" title="archive — every conversation this repo ever had, resumable"
              onClick={() => { track("overlay:archive"); setNavMenu(false); setOverlay("archive"); }}>
              <Archive size={ICON} />archive
            </button>
            <button className="more-act"
              title="decision log — usage-limit auto-continues and what plugins suggested or answered"
              onClick={() => { setNavMenu(false); openDecisions(null); }}>
              <ScrollText size={ICON} />decisions
            </button>
            <button className="more-act" title="sent commands — everything this app typed into a session, including what it decided by itself"
              onClick={() => { track("overlay:sentlog"); setNavMenu(false); openSentLog(null); }}>
              <MessageSquare size={ICON} />sent
            </button>
            {/* The local/external switch. It used to be a full-width segmented
                bar directly under the topbar — two 46px buttons of permanent
                vertical space for a choice almost nobody changes, pushing the
                first repo below the fold on a phone. It is a view selector, so
                it belongs with the other nine view entries; what stays visible
                is which view you are IN, said by the list's own section head
                and by the marker on the menu button. */}
            <button className={`more-act${tab === "home" ? " on" : ""}`} title="sessions this app started"
              onClick={() => { setNavMenu(false); setTab("home"); }}>
              <ListTodo size={ICON} />local {visibleSessions.length ? `(${visibleSessions.length})` : ""}
            </button>
            <button className={`more-act${tab === "external" ? " on" : ""}`} title="`claude` processes running outside this app — resumable from here"
              onClick={() => { setNavMenu(false); setTab("external"); }}>
              <TerminalIcon size={ICON} />external {visibleExternal.length ? `(${visibleExternal.length})` : ""}
            </button>
            {/* What extensions put on the home menu (Desktop, Links, Vault). None ⇒ nothing drawn. */}
            <LauncherItems size={ICON} onOpen={() => setNavMenu(false)} />
          </div>
        )}
        {face.kind === "windows" ? (
          <UsageChip sessions={sessions} />
        ) : (
          /* An account with no 5-hour or weekly window: dollars for its period, or the gauge alone
             (a door into token statistics) when none is measured — never a `?`. */
          <Button
            className={`usage-key ${face.kind === "usd" && face.chip.hot ? "danger" : ""}`}
            aria-label={face.kind === "usd" ? face.chip.text : "token statistics"}
            title={`${face.kind === "usd" ? face.chip.title : "Spend on this desktop"}\ntap for the token history`}
            onClick={() => { track("overlay:tokens"); setOverlay("tokens"); }}
          >
            <Gauge size={ICON} />
            {face.kind === "usd" && <span className={face.chip.hot ? "usage-hot" : ""}>{face.chip.text}</span>}
          </Button>
        )}
        {/* The unprompted mark for Decision 8 — why it is here: features/cliHealth. */}
        <CliHealthChip />
        {/* An extension item with something waiting (the vault's asks), out of the ☰ menu while it waits. */}
        <LauncherItemKeys size={ICON} />
        <BellButton size={ICON} />
        <Button
          className={push === "insecure" ? "danger" : ""}
          aria-label="settings"
          title="settings — notifications, launch defaults, plugins, tools"
          onClick={() => setOverlay("settings")}
        ><Settings size={ICON} /></Button>
        {/* With a second desktop saved, which one this is becomes a reading
            and switching a habit: a split key — toggle to the next desktop /
            open the switcher — sized to fit beside the cog. One host ⇒ none. */}
        <HostSwitchKey />
        {/* No connection readout here. "open · 100.x.y.z" was a permanent
            green label restating what the net-pulse strip already shows live
            and what the floating `conn-banner` says the moment it stops being
            true. The address itself is still one tap away in Settings, and
            the offline card names it as the last known host. */}
      </header>
      {p.banners}

      {tab === "home" && (
        <div className="list" ref={listRef} onScroll={(e) => { launcherScroll.top = e.currentTarget.scrollTop; }}>
          {/* First-ever offline start: no localStorage snapshot to seed from
              (the snapshot keys for sessions, recent and repos are all empty) and no socket, so
              every section below renders nothing and the launcher is a blank
              screen that looks broken. Say what happened instead. Gated on
              connVisible so a normal cold start — which is offline for the
              first few hundred ms — never flashes this. */}
          {sessions.length === 0 && recent.length === 0 && repos.length === 0 && status !== "open" && connVisible && (
            <>
              <div className="offline-card">
                <div className="offline-card-head"><CloudOff size={18} /> Can’t reach the host and nothing is cached yet</div>
                <div className="offline-card-body">
                  The launcher fills in when the tunnel is back — sessions, repos and recent
                  conversations all come from the desktop.
                </div>
                <ul className="offline-card-hints">
                  <li>Is Tailscale connected on this phone?</li>
                  <li>Is the desktop awake, with the {BRAND.name} daemon running?</li>
                  {tailscaleIp && <li>Last known host address: <span className="mono">{tailscaleIp}</span></li>}
                </ul>
              </div>
              {/* Skeleton rows: shape of what will be here, so the wait reads as
                  "loading", not "empty". Inert — nothing to tap yet. */}
              {[0, 1, 2].map((i) => (
                <div key={i} className="row-wrap skel-row" aria-hidden="true">
                  <span className="skel-bar skel-title" />
                  <span className="skel-bar skel-sub" />
                </div>
              ))}
            </>
          )}
          {/* Once per desktop version: what this release brought, and the way to each (features/whatsnew). */}
          <WhatsNewLauncherRow />
          {/* A host that has never opened a session: three ways in (features/onboard). */}
          <FirstRunCard repos={repos.length} demo={isDemo()} onDemo={() => enterDemo("first-look")} />
          {repoGroups.length > 0 && (
            <div className="section section-head launcher-head">
              {/* One head for one list. It used to say "Live sessions" and a
                  second head further down said "Repos & worktrees"; the age of
                  the repo listing was stated there, and it is stated here now
                  for the same reason — a listing confirmed seconds ago needs no
                  sentence, one from before the tunnel died does. */}
              <span>Sessions &amp; repos <span className="section-hint">· {visibleSessions.length} live in {repoGroups.length} repo{repoGroups.length > 1 ? "s" : ""}{sessionOrder.length ? " · custom order" : ""}
                {/* Said only when a re-read FAILED after the listing landed: an old
                    listing on its own means nobody asked (the repos are re-read on
                    a connect, a turn's end, coming back here), and stating the
                    host's silence over a healthy link was a false alarm. */}
                {reposAt && reposFailAt > reposAt && Date.now() - reposAt > REPOS_STALE_MS
                  ? <> — repos as of {ago(reposAt)}, the host hasn’t answered since</>
                  : <> — hold a row to drag</>}</span></span>
              {/* Chips + actions in ONE .head-acts. The actions are ICON buttons
                  (.head-act), not text links: four 11.5px links wrapped this head
                  onto two rows on a phone and each was a sub-fingertip target. */}
              <span className="head-acts tight">
              {waitingTotal > 0 && (
                // A BUTTON, not a label: this count was the only place the
                // launcher admitted a session was waiting, and the only way
                // to act on it was to find the right row and open its
                // terminal — which is exactly the trip you cannot make with
                // no tunnel. It opens the questions sheet, where every
                // pending question is answerable offline.
                <button className="head-wait"
                  title={`${waitingTotal} session${waitingTotal > 1 ? "s" : ""} waiting for your answer${waitingRepliesTotal ? " — some already have a reply on a clock" : ""} — tap to answer them here`}
                  onClick={() => { track("overlay:questions"); setOverlay("questions"); }}>
                  <CircleDot size={13} /> {waitingTotal} waiting
                  {/* A DOT and not a second number: this chip is already a
                      count and already the way into those sessions, so a
                      count beside it would be a filter with no tap left to
                      spend. It says only *some of these are already
                      answered, on a clock* — the row chip carries which and
                      when. */}
                  {waitingRepliesTotal && <CalendarClock size={11} className="wait-sched" />}
                </button>
              )}
              {limitTotal > 0 && (
                // A BUTTON for the same reason the waiting count is one: these
                // sessions all resume off the same reset, so the useful action
                // is choosing between them, and that had no home. It also says
                // out loud that they go one at a time — several rows reading
                // "auto 12:02" otherwise look like a pile-on about to happen.
                <button className="head-wait limit" data-hint="limit.open"
                  title={limitTotal > 1
                    ? `${limitTotal} sessions at the usage limit — they resume one at a time; tap to set the order`
                    : "a session is at the usage limit — tap to steer when it resumes"}
                  onClick={() => { track("overlay:limits"); setOverlay("limits"); }}>
                  <Hourglass size={13} /> {limitTotal} at limit
                </button>
              )}
              {codingTotal > 0 && (
                // Same filter as the group chips, unscoped: this count is over
                // every repo, so the rows it shows are too.
                <button className={`repo-group-stat coding${statusFilterActive("coding") ? " on" : ""}`}
                  title={`${codingTotal} session${codingTotal > 1 ? "s" : ""} working — tap to show only those`}
                  onClick={() => toggleStatusFilter("coding")}>
                  <Loader size={13} className="spin" />{codingTotal}
                </button>
              )}
              {starredTotal > 0 && (
                // The one mark the user put there by hand, and until now the
                // only one you could not get back to: a star painted the row
                // and nothing else, so "show me the ones I flagged" meant
                // scrolling every repo looking for filled stars.
                <button className={`repo-group-stat starred${statusFilterActive("starred") ? " on" : ""}`}
                  title={`${starredTotal} starred session${starredTotal > 1 ? "s" : ""} — tap to show only those`}
                  onClick={() => toggleStatusFilter("starred")}>
                  <Star size={13} fill="currentColor" />{starredTotal}
                </button>
              )}
              {flaggedTotal && (
                // The follow-up flags, beside the star they sit beside on
                // every row: the tap is the cut (R-sessions-045), coloured by
                // who set them, or the text colour when that is several.
                <button className={`repo-group-stat fu-${flaggedTotal.tone}${statusFilterActive("followup") ? " on" : ""}`}
                  data-hint="session.followup" title={flaggedChipTitle(flaggedTotal.n)}
                  onClick={() => toggleStatusFilter("followup")}>
                  <Flag size={13} fill="currentColor" />{flaggedTotal.n}
                </button>
              )}
              {shellsTotal > 0 && (
                // Sessions running background shells — a session with only
                // quiet ones reads `done` (`sessionStatus`), so this is its
                // own count for the same reason `starredTotal` is: orthogonal
                // to the working/idle badge, and not a sixth roll-up bucket.
                <button className={`repo-group-stat coding${statusFilterActive("shells") ? " on" : ""}`}
                  title={`${shellsTotal} session${shellsTotal > 1 ? "s" : ""} running background shells — tap to show only those`}
                  onClick={() => toggleStatusFilter("shells")}>
                  <SquareTerminal size={13} />{shellsTotal}
                </button>
              )}
              {sessionOrder.length > 0 && <button className="head-act" aria-label="reset order" title="reset order — drop the custom order and go back to creation order" onClick={() => { track("action:session.order.reset"); resetSessionOrder(); showToast("order reset to oldest-first"); }}><ListRestart size={ICON} /></button>}
              {/* Two verbs, not one toggle: a single icon that flips between
                  ⇕ and ⇳ read as one control with a state nobody could see. */}
              <button className="head-act" aria-label="expand all repo groups"
                title={noRepoCollapsed ? "expand all — every repo group is already open" : "expand all — every repo group opens"}
                onClick={() => { track("action:repo.expand.all"); persistCollapsedRepos(new Set()); }}>
                <ChevronsUpDown size={ICON} />
              </button>
              <button className="head-act" aria-label="collapse all repo groups"
                title={allReposCollapsed ? "collapse all — every repo group is already folded" : "collapse all — headers stay, session and worktree rows hide"}
                onClick={() => { track("action:repo.collapse.all"); persistCollapsedRepos(new Set(repoGroups.map((g) => g.repoName))); }}>
                <ChevronsDownUp size={ICON} />
              </button>
              {/* The three verbs that are about the SET of repos, not one of
                  them — they headed the repos section that this list absorbed,
                  and there is nowhere else for them to be. */}
              <button className="head-act" aria-label="fan out" title="fan out — run one prompt in several repos at once (a fresh session each)" onClick={() => { track("overlay:fanout"); setOverlay("fanout"); }}><Split size={ICON} /></button>
              {/* The schedules button, and what it is holding.
                  A bare calendar icon says a schedule list exists; it never
                  said whether anything was about to happen. "7 scheduled"
                  would not have either — the same badge covers "all seven
                  fire tonight" and "the next one is a fortnight away", which
                  are opposite situations. So the chip carries the HORIZON
                  (`scheduleHorizon`, node-tested): the two nearest non-empty
                  buckets, disjoint, and nothing at all when nothing is armed. */}
              <button className={`head-act${scheduleWords ? " head-act-wide" : ""}`} aria-label={SHEET.automation.toLowerCase()}
                // The number is the filter: open the list already cut to the
                // bucket the chip is counting. With nothing armed there is no
                // number and no claim to check, so it opens whole.
                title={scheduleTitle} onClick={() => { track("overlay:schedule"); openSchedules(scheduleWords ? scheduleLead : null); }}>
                <CalendarClock size={ICON} />{scheduleWords && <span className="head-act-n">{scheduleWords}</span>}
              </button>
              <button className="head-act" aria-label="sync repos" title="sync repos — pull, push or sync every repo at once" onClick={() => { track("overlay:reposync"); setOverlay("reposync"); }}><ArrowDownUp size={ICON} /></button>
              <button className="head-act" aria-label="rescan repos" title="rescan the host root for repos and worktrees" onClick={() => { refreshRepos(); showToast("repos rescanned"); }}><RotateCw size={ICON} /></button>
              {visibleSessions.some((s) => !s.running) && <button className="head-act" aria-label="clear exited sessions" title="clear exited — drop the sessions that have already ended" onClick={clearExited}><Eraser size={ICON} /></button>}
              {visibleSessions.length > 0 && (
                <button className="head-act danger" data-hint="session.close.all" aria-label="close sessions"
                  title={`close sessions — review the ${visibleSessions.length} listed, cut by state, idle time, what is still running underneath, or a repo`}
                  onClick={() => setCloseAllPick("*")}>
                  <X size={ICON} />
                </button>
              )}
              </span>
            </div>
          )}
          {(repoGroups.length > 0 || textOn) && (
            // The quick filter: always on screen, filters the rows by what they
            // SHOW. Searching what the sessions SAID is the search sheet,
            // one tap at its end — the two searches side by side.
            <div className="section quick-filter">
              <Search size={14} className="quick-filter-icon" />
              <input type="search" value={textQuery} placeholder="filter sessions & repos"
                aria-label="filter sessions and repos by the text on their rows"
                onChange={(e) => setTextQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape" && textQuery) { e.preventDefault(); e.stopPropagation(); setTextQuery(""); } }} />
              {textOn && <span className="quick-filter-n">{shownSessions.length} of {sortedSessions.length}</span>}
              {textOn && (
                <button className="head-act" aria-label="clear the filter" title="clear the filter — every row again"
                  onClick={() => setTextQuery("")}><X size={ICON} /></button>
              )}
              <button className="head-act" aria-label="search what sessions said"
                title="search what the sessions SAID — every transcript, on the desktop"
                onClick={() => { track("action:launcher.search"); openSearch(null); }}><ScrollText size={ICON} /></button>
            </div>
          )}
          {statusFilter && (
            // Says what is being hidden and why, because the alternative
            // reading of a short list is "my sessions are gone". Counts come
            // from the unfiltered list, so "2 of 31" is the whole answer.
            <div className="section filter-bar">
              <span className="filter-bar-txt">
                showing {STATUS_LABEL[statusFilter.status]}{statusFilter.repo ? ` in ${statusFilter.repo}` : ""}
                {statusFilter.status === "worktrees" && statusFilter.repo
                  ? <>{" · "}{m.worktreesOf(statusFilter.repo).length} worktree{m.worktreesOf(statusFilter.repo).length === 1 ? "" : "s"}, {shownSessions.length} of {sortedSessions.length} sessions</>
                  : <>{" · "}{shownSessions.length} of {sortedSessions.length}</>}
                {shownSessions.length === 0 && statusFilter.status !== "worktrees" && (statusFilter.status === "starred" ? " — nothing is starred any more"
                  : statusFilter.status === "followup" ? " — nothing is flagged any more"
                  : statusFilter.status === "shells" ? " — no session is running one any more"
                  : " — nothing is in that state any more")}
              </span>
              <button className="filter-bar-clear" title="clear the filter — show every live session again"
                onClick={() => setStatusFilter(null)}><X size={13} /> clear</button>
            </div>
          )}
          {repoGroups.map(({ repoName, sessions: groupSessions }) => (
            <RepoGroup key={`g:${repoName}`} p={p} m={m} repoName={repoName} sessions={groupSessions} />
          ))}
          {noReposText && <Empty>{noReposText}</Empty>}
          {textOn && repoGroups.length === 0 && <Empty>No session or repo shows “{textQuery.trim()}”. The search at the end of the filter looks through what sessions said.</Empty>}

          <ClosedRows p={p} m={m} />
        </div>
      )}

      {tab === "external" && (
      <div className="list">
        <div className="section section-head">
          <span>External claude processes</span>
          <button className="head-act" title="back to the sessions this app started"
            onClick={() => setTab("home")}><ListTodo size={13} /> local</button>
        </div>
        {visibleExternal.length === 0 && <Empty>No `claude` running outside {BRAND.name}. Started one in a terminal? It shows here.</Empty>}
        {visibleExternal.map((e) => (
          <Row key={e.pid} kind="wrap">
            <Row as="button" kind="grow" onClick={() => openCwd(e.cwd, baseName(e.cwd), true)}>
              <RowTitle className="mono">{baseName(e.cwd)}</RowTitle>
              <RowSub>pid {e.pid} · <Waypoints size={12} /> resume here</RowSub>
            </Row>
            {repoForCwd(e.cwd) && <button className="row-act" title="send image to this repo" onClick={() => pickImageFor(repoForCwd(e.cwd)!.id)}><Camera size={ICON} /></button>}
          </Row>
        ))}
        <Hint>Can't attach to another terminal's TTY directly — "resume here" opens a session here in that directory with <span className="mono">--continue</span>.</Hint>
      </div>
      )}
      <CloseSheet p={p} m={m} />
      {shotPick && (
        <div className="bl-modal-backdrop" onClick={() => setShotPick(false)}>
          <div className="bl-modal" onClick={(e) => e.stopPropagation()}>
            <div className="bl-modal-title">Screenshot → which repo?</div>
            <div className="bl-modal-repo">The capture is saved into the chosen repo, then opens in the annotator.</div>
            <div className="list">
              {visibleRepos.map((t) => (
                <Row key={t.id} as="button" onClick={() => { setShotPick(false); void takeShot(t.id); }}>
                  <RowTitle>{repoLabel(t)}</RowTitle>
                  {branchLabel(t) && <RowSub>{branchLabel(t)}</RowSub>}
                </Row>
              ))}
            </div>
            <div className="bl-modal-actions">
              <Button onClick={() => setShotPick(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
      <NetActivity />
      {/* The demo's first cue (features/demoTour): nothing outside the demo's first minute. */}
      <DemoStartCue />
    </div>
  );
}
