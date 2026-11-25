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
import { Fragment, useLayoutEffect, useRef } from "react";
import { Activity, Archive, ArrowDownUp, Cpu, CalendarClock, CircleDot, Hourglass, OctagonPause, Camera, ChevronsDownUp, ChevronsUpDown, CloudOff, Download, Eraser, Flag, Gauge, House, Images, ListOrdered, ListRestart, ListTodo, Loader, Menu, MessageSquare, NotebookPen, Plus, RotateCw, ScrollText, Search, Settings, ShieldAlert, Split, SquareTerminal, Star, Terminal as TerminalIcon, Waypoints, X } from "lucide-react";
import { BRAND, repoShown } from "@waterplane/shared";
import { Empty } from "../../Empty";
import { NetActivity } from "../../NetActivity";
import { HintToggle } from "../../HintLayer";
import { ago, baseName, repoAccentStyle } from "../../format";
import { STATUS_LABEL } from "../../sessionFacts";
import { listedBlockOf } from "../../attention";
import { flaggedChipTitle } from "../sessions/followUpFacts";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { RISKY_PERM_MODES } from "../settings/permModes";
import { CliHealthChip } from "../../features/cliHealth";
import { useUsageFace } from "../../features/tokens";
import { LauncherChrome } from "./LauncherChrome";
import { UsageChip } from "./UsageChip";
import { BellButton } from "../../features/notifications";
import { openDecisions } from "../../features/plugins";
import { openSentLog } from "../../features/sentLog";
import { DemoStartCue } from "../../features/demoTour";
import { openSearch } from "../../features/search";
import { openSchedules } from "../../features/schedule";
import { openActivity } from "../../features/activity";
import { pickImageFor } from "../../features/images";
import { useHostPush } from "../../features/hostTools";
import { ElsewhereChip, HostMenuItem, HostSwitchKey } from "../../features/hosts";
import { openLocalRt, openNetHealth } from "../../features/tools";
import { TabsLogo, TabsMenuItem } from "../../SessionTabsBar";
import { FirstRunCard, useFirstRunWhich } from "../../features/onboard";
import { WhatsNewLauncherRow } from "../../features/whatsnew";
import { ProposalsStrip } from "../../features/backlog";
import { enterDemo, isDemo } from "../../demo/mode";
import { isNativeShell } from "../../hostUrl";
import type { LauncherProps } from "./types";
import { launcherScroll, useLauncherModel } from "./useLauncherModel";
import { noReposWords } from "./model";
import { listRead } from "../../listRead";
import { RepoGroup } from "./RepoGroup";
import { UnpinnedHead } from "./UnpinnedHead";
import { ClosedRows } from "./ClosedRows";
import { PlainFolders, scanPlainFolders } from "./PlainFolders";
import { CloseSheet } from "./CloseSheet";
import { LauncherItemKeys, LauncherItems, LauncherMenuBadge, MenuGroup } from "./LauncherItems";
import { questionsWords } from "./homeWords";
import { Button } from "../../kit/Button";
import { AttentionChip } from "./AttentionChip";
import { Row, RowTitle, RowSub } from "../../kit/Row";
import { Hint } from "../../kit/Hint";

export type { LauncherProps } from "./types";

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
  // The first-run card already says what to do with no repos; the line under it would say it twice.
  const firstRunShown = useFirstRunWhich(isDemo()).which !== "none";
  const noReposText = firstRunShown ? null : noReposWords(listRead({ rows: repos, readAt: reposAt }));
  const { status, connVisible } = p.conn;
  const { tailscaleIp } = p.conn.info;
  const { focusRepo, setOverlay, lastVisitedId } = p.route;
  const { openCwd, refreshRepos } = p.launchCore;
  const { clearExited } = p.verbs;
  const {
    tab, setTab, navMenu, setNavMenu, dl, activityBadge, activityKeys, visibleSessions, visibleExternal, clearFocus, repoGroups,
    sessionOrder, resetSessionOrder, waitingTotal, waitingRepliesTotal, blockedTotal, codingTotal, starredTotal, flaggedTotal, shellsTotal,
    statusFilter, setStatusFilter, statusFilterActive, toggleStatusFilter, shownSessions, sortedSessions,
    textQuery, setTextQuery, textOn, noRepoCollapsed,
    allReposCollapsed, persistCollapsedRepos, scheduleWords, scheduleLead, scheduleTitle, setCloseAllPick,
    repoForCwd,
  } = m;
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
      <LauncherChrome off={navMenu}>
      <header className="topbar launcher-top">
        {focusRepo ? (
          <div className="brand brand-focus" style={repoAccentStyle(focusRepo)}>
            <TabsLogo size={32} label="" /><span>{m.shownOf(focusRepo)}</span>
            <button className="focus-clear" title="exit repo focus — show all repos" onClick={clearFocus}><X size={14} /></button>
          </div>
        ) : (
          // The wordmark is the one thing on this bar that says nothing a reading
          // could not: at phone width it pushed the gear onto a second row all by
          // itself. The MARK stays (the app icon people match against, and at phone
          // width the button for the open tabs); the text goes, and its space becomes chips.
          // The host switcher is a row in the menu (Android shell): a long
          // desktop name here took the whole bar for a rarely asked question.
          // 40 = `.topbar > .key`'s min-height: the mark is as tall as the buttons beside it.
          <div className="brand"><TabsLogo size={40} /></div>
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
              counted line inside (activity, extension items); the
              inventories (local/external, files on the phone) are not news. */}
          <LauncherMenuBadge base={activityBadge} />
        </Button>
        {navMenu && (
          <div className="row-more nav-more">
            {/* Grouped by task (whole-app journey spec D6, §1): Start, Find, Waiting,
                Sessions, This desktop. Every line says its screen's title. */}
            <MenuGroup title="Start">
              <button className="more-act" title="pick a repo and open a new session in it"
                onClick={() => { setNavMenu(false); setOverlay("new"); }}><Plus size={ICON} />New project…</button>
              <button className="more-act" title="fan out — run one prompt in several repos at once (a fresh session each)"
                onClick={() => { track("overlay:fanout"); setNavMenu(false); setOverlay("fanout"); }}><Split size={ICON} />Fan out</button>
              <button className="more-act" title="pad — write a thought now, decide where it goes later"
                onClick={() => { setNavMenu(false); setOverlay("pad"); }}><NotebookPen size={ICON} />Pad</button>
            </MenuGroup>
            <MenuGroup title="Find">
              <button className="more-act" title="search words across all sessions"
                onClick={() => { setNavMenu(false); openSearch(null); }}><Search size={ICON} />Search</button>
              <button className="more-act" title="find repos — look again for repos and branch copies under the code folder"
                onClick={() => { setNavMenu(false); refreshRepos(); void scanPlainFolders().then((n) => showToast(n ? `Looked for repos: ${n} folder${n === 1 ? "" : "s"} without git, see above the list` : "Looked for repos: the list is up to date")); }}><RotateCw size={ICON} />Find repos</button>
              <button className="more-act" onClick={() => { setNavMenu(false); setOverlay("gallery"); }}><Images size={ICON} />Images &amp; documents</button>
              {/* The route to the downloads when nothing is downloading: the
                  PullBar strip is drawn only while a transfer is ACTIVE. The 2px
                  rule along the bottom edge is the progress, costing no height. */}
              <button className={`more-act${dl.active > 0 ? " has-bar" : ""}`}
                title={dl.active > 0
                  ? `downloads — ${dl.active} in flight, ${dl.pct}% of the bytes here${dl.stuck ? " (something is stopped)" : ""}`
                  : "downloads — files fetched to this device, and what each repo fetches on its own"}
                onClick={() => { track("overlay:pull"); setNavMenu(false); setOverlay("pull"); }}>
                <Download size={ICON} />Downloads
                {dl.active > 0 ? ` · ${dl.active} downloading, ${dl.pct}%` : dl.onPhone > 0 ? ` · ${dl.onPhone} on this phone` : ""}
                {dl.active > 0 && <span className={`more-dl-bar${dl.stuck ? " warn" : ""}`} style={{ width: `${dl.pct}%` }} />}
              </button>
              {/* The route back to a session closed long enough ago that it has
                  rolled off "Recently closed". */}
              <button className="more-act" title="archive — every conversation this repo ever had, resumable"
                onClick={() => { track("overlay:archive"); setNavMenu(false); setOverlay("archive"); }}>
                <Archive size={ICON} />Archive
              </button>
            </MenuGroup>
            <MenuGroup title="Waiting">
              {/* Where posted work is found afterwards — always drawn, since "what
                  happened to the thing I sent an hour ago" is asked precisely when
                  nothing is pending. A count is a filter: with a number on it, the
                  tap opens exactly those rows. The word carries the count (J-17). */}
              <button className="more-act" data-hint="activity.open"
                title="activity, queued, backlog and scheduled, in Waiting work — every prompt, sweep, build, schedule and download you posted, with what became of it"
                onClick={() => {
                  track("overlay:activity"); setNavMenu(false);
                  openActivity(activityKeys.length ? { keys: activityKeys, label: `the ${activityKeys.length} ${activityKeys.length === 1 ? "row" : "rows"} still open` } : null);
                }}>
                <ListOrdered size={ICON} />Waiting work
                {activityBadge > 0 && <span className="mic-badge">{activityBadge}</span>}
              </button>
              <button className="more-act" title="questions — sessions waiting for your answer"
                onClick={() => { track("overlay:questions"); setNavMenu(false); setOverlay("questions"); }}>
                <CircleDot size={ICON} />Questions{waitingTotal > 0 && <span className="mic-badge">{waitingTotal}</span>}
              </button>
              <button className="more-act" title="blocked — sessions stopped by a limit, a spend wall, the network or a sign-in"
                onClick={() => { track("overlay:limits"); setNavMenu(false); setOverlay("limits"); }}>
                <OctagonPause size={ICON} />Blocked{blockedTotal > 0 && <span className="mic-badge">{blockedTotal}</span>}
              </button>
            </MenuGroup>
            <MenuGroup title="Sessions">
              {/* The local/external switch: a view selector, so it lives with the
                  other views; which view you are IN stays said by the list's own
                  head and by the marker on the menu button. */}
              <button className={`more-act${tab === "home" ? " on" : ""}`} title="sessions this app started"
                onClick={() => { setNavMenu(false); setTab("home"); }}>
                <ListTodo size={ICON} />On this desktop{visibleSessions.length ? ` · ${visibleSessions.length}` : ""}
              </button>
              {/* The list the top line's tabs button opens — reachable with that line off. */}
              <TabsMenuItem size={ICON} onOpen={() => setNavMenu(false)} />
              <button className={`more-act${tab === "external" ? " on" : ""}`} title="`claude` processes started in a terminal by hand — resumable from here"
                onClick={() => { setNavMenu(false); setTab("external"); }}>
                <TerminalIcon size={ICON} />External{visibleExternal.length ? ` · ${visibleExternal.length}` : ""}
              </button>
              <button className="more-act" title="sent commands — everything this app typed into a session, including what it decided by itself"
                onClick={() => { track("overlay:sentlog"); setNavMenu(false); openSentLog(null); }}>
                <MessageSquare size={ICON} />Sent commands
              </button>
              <button className="more-act"
                title="decision log — usage-limit auto-continues and what plugins suggested or answered"
                onClick={() => { setNavMenu(false); openDecisions(null); }}>
                <ScrollText size={ICON} />Decision log
              </button>
            </MenuGroup>
            <MenuGroup title="This desktop">
              {isNativeShell() && <HostMenuItem size={ICON} onOpen={() => setNavMenu(false)} />}
              {/* The two screens the lines at the top open, reachable with those lines switched off. */}
              <button className="more-act" title="connection — the link to this desktop: ping history, speed test, the route"
                onClick={() => { setNavMenu(false); openNetHealth(undefined); }}><Activity size={ICON} />Connection</button>
              <button className="more-act" title="this desktop — CPU, memory, GPU, disk, agents and any local model"
                onClick={() => { setNavMenu(false); openLocalRt(undefined); }}><Cpu size={ICON} />This desktop</button>
              {/* What extensions put on the home menu (Setup & health, Desktop, Links, Vault, Halt). */}
              <LauncherItems size={ICON} onOpen={() => setNavMenu(false)} />
            </MenuGroup>
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
        {/* Another of your desktops waits on you (a vault approval, a question): its name and
            count, a tap opens exactly those rows. Absent when nothing fresh waits elsewhere. */}
        <ElsewhereChip />
        <HostSwitchKey />
        {/* No connection readout here. "open · 100.x.y.z" was a permanent
            green label restating what the net-pulse strip already shows live
            and what the floating `conn-banner` says the moment it stops being
            true. The address itself is still one tap away in Settings, and
            the offline card names it as the last known host. */}
      </header>
      {p.banners}
      </LauncherChrome>

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
                  <li>Is Tailscale connected on this device?</li>
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
          {/* Work a repo's script proposed, until each is fired, scheduled or deleted — first, in its own hue (features/backlog). */}
          <ProposalsStrip repoName={(dir) => {
            const r = repos.find((x) => x.worktreePath === dir);
            return r ? repoShown(r) : dir.split("/").filter(Boolean).pop() || dir;
          }} />
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
              {/* The two attention chips: one component, and each number is
                  `attentionCut`'s — the same call the sheet it opens lists
                  with, so a tap shows exactly the sessions counted. The
                  questions sheet answers offline; the blocked sheet groups
                  sign-in, network, spend and the usage limit's resume queue. */}
              <AttentionChip kind="wait" n={waitingTotal} replies={!!waitingRepliesTotal} noun={questionsWords(waitingTotal).replace(/^\d+ /, "")}
                onClick={() => { track("overlay:questions"); setOverlay("questions"); }} />
              <AttentionChip kind="blocked" n={blockedTotal} hint="limit.open"
                onClick={() => { track("overlay:limits"); setOverlay("limits"); }} />
              {activityKeys.length > 0 && (
                // "4 waiting": the Waiting work rows still open (the ☰ line's own
                // count), and the tap opens exactly those — a count is a filter.
                <button className="repo-group-stat queued" title={`${activityKeys.length} still open in Waiting work — tap to see only those`}
                  onClick={() => { track("overlay:activity"); openActivity({ keys: activityKeys, label: `the ${activityKeys.length} ${activityKeys.length === 1 ? "row" : "rows"} still open` }); }}>
                  <Hourglass size={13} />{activityKeys.length} waiting
                </button>
              )}
              {codingTotal > 0 && (
                // Same filter as the group chips, unscoped: this count is over
                // every repo, so the rows it shows are too.
                <button className={`repo-group-stat coding${statusFilterActive("coding") ? " on" : ""}`}
                  title={`${codingTotal} session${codingTotal > 1 ? "s" : ""} working — tap to show only those`}
                  onClick={() => toggleStatusFilter("coding")}>
                  <Loader size={13} className="spin" />{codingTotal} working
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
                  <Star size={13} fill="currentColor" />{starredTotal} starred
                </button>
              )}
              {flaggedTotal && (
                // The follow-up flags, beside the star they sit beside on
                // every row: the tap is the cut (R-sessions-045), coloured by
                // who set them, or the text colour when that is several.
                <button className={`repo-group-stat fu-${flaggedTotal.tone}${statusFilterActive("followup") ? " on" : ""}`}
                  data-hint="session.followup" title={flaggedChipTitle(flaggedTotal.n)}
                  onClick={() => toggleStatusFilter("followup")}>
                  <Flag size={13} fill="currentColor" />{flaggedTotal.n} flagged
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
                  <SquareTerminal size={13} />{shellsTotal} with shells
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
              {/* Icon keys (owner 2026-11-20: the words were noise once learned; the ☰
                  carries the same verbs worded). The aria-label keeps each key's name. */}
              <button className="head-act" aria-label="Fan out" title="fan out — run one prompt in several repos at once (a fresh session each)" onClick={() => { track("overlay:fanout"); setOverlay("fanout"); }}><Split size={ICON} /></button>
              <button className="head-act" aria-label="Waiting work" title="waiting work — what is running, queued, in a backlog or scheduled"
                onClick={() => { track("overlay:activity"); openActivity(null); }}><ListOrdered size={ICON} /></button>
              {/* The schedules button, and what it is holding.
                  A bare calendar icon says a schedule list exists; it never
                  said whether anything was about to happen. "7 scheduled"
                  would not have either — the same badge covers "all seven
                  fire tonight" and "the next one is a fortnight away", which
                  are opposite situations. So the chip carries the HORIZON
                  (`scheduleHorizon`, node-tested): the two nearest non-empty
                  buckets, disjoint, and nothing at all when nothing is armed. */}
              {scheduleWords && (
                <button className="head-act head-act-wide"
                  // The number is the filter: open the list already cut to the
                  // bucket the chip is counting. With nothing scheduled there is no
                  // chip: the Waiting work key above opens the whole list.
                  title={scheduleTitle} onClick={() => { track("overlay:schedule"); openSchedules(scheduleLead); }}>
                  <CalendarClock size={ICON} /><span className="head-act-n">{scheduleWords}</span>
                </button>
              )}
              <button className="head-act" aria-label="sync repos" title="sync repos — pull, push or sync every repo at once" onClick={() => { track("overlay:reposync"); setOverlay("reposync"); }}><ArrowDownUp size={ICON} /></button>
              {visibleSessions.some((s) => !s.running && !listedBlockOf(s)) && <button className="head-act" aria-label="clear exited sessions" title="clear exited — drop the sessions that have already ended" onClick={clearExited}><Eraser size={ICON} /></button>}
              {visibleSessions.length > 0 && (
                <button className="head-act danger" data-hint="session.close.all" aria-label="Close sessions"
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
            // SHOW. Searching what the sessions SAID is its second option, the
            // key at its end, carrying the typed words (owner 2026-11-20: the
            // head row's separate Search key folded in here — one place to search).
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
                title={textOn ? `search what the sessions SAID for “${textQuery.trim()}” — every transcript, on the desktop` : "search what the sessions SAID — every transcript, on the desktop"}
                onClick={() => { track("action:launcher.search"); openSearch(null, textQuery); }}><ScrollText size={ICON} /></button>
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
          <PlainFolders refreshRepos={refreshRepos} />
          {repoGroups.map(({ repoName, sessions: groupSessions, pinned }, i) => (
            <Fragment key={`g:${repoName}`}>
              {/* Where the pinned block ends: what the rest are and their order (drawn only once a repo is pinned). */}
              {!pinned && i > 0 && repoGroups[i - 1]!.pinned && <UnpinnedHead n={repoGroups.length - i} />}
              <RepoGroup p={p} m={m} repoName={repoName} sessions={groupSessions} />
            </Fragment>
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
            onClick={() => setTab("home")}><House size={13} /> On this desktop</button>
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
      <NetActivity />
      {/* The demo's first cue (features/demoTour): nothing outside the demo's first minute. */}
      <DemoStartCue />
    </div>
  );
}
