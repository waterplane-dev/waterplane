import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@waterplane/shared";
import { setDocTitle } from "./themeOverlay";
import { loadSheetDraft, seedSheetDraft, appendSheetDraft, newAckId, removePadNotes } from "./outbox";
import { useTransportIndex } from "./transportIndex";
import type { Overlay } from "./routing";
import { FOLLOWUP_MARK, STAR_MARK, applyPendingMarks } from "./pendingMarks";
import { clearTokensOn, readingsNow, tokensOpenOnNow, useBilling, useUsage } from "./features/tokens";
import { askConfirm } from "./Confirm";
import { useCostNotices } from "./core/session/useCostNotices";
import { startLinkReporting } from "./link";
import { AuthGate, useAuthGate } from "./features/authGate";
import { viewerHandles } from "./docKind";
import { showToast } from "./toast";
import { backendIdOf, hasCap } from "./backendCaps";
import { useRepoColors } from "./repoColors";
import { openCaptureFor } from "./features/capture"; import { openRepoHealth, openSetup } from "./features/setup"; import { openContext, openContextFor } from "./features/context"; import { openBuildFor } from "./features/build";
import { useUsedOrderSnapshot } from "./features/toolbarCfg";
import { usePullRecords } from "./features/pull";
import { openScheduleCut, useSchedules } from "./features/schedule";
import { openBacklogCut, useBacklog } from "./features/backlog";
import { openActivity, useActivityConfirmedDone, useActivityFiled } from "./features/activity";
import { openPadAt } from "./features/pad";
import {
  annotate, annotateUrl, attachForInbox, routeFiles, backlogEditImage, downloadArtifact, openArtifact, openBrowseAt, openSweep, seedFromRoute, viewImage,
} from "./features/images";
import { track } from "./usage";
import { bindCore } from "./core/api";
import { setPref, usePref } from "./core/prefs";
import { useQueue } from "./core/queue/useQueue";
import { useLaunch } from "./core/launch/useLaunch";
import { QueueBars } from "./core/queue/QueueBars";
import { useSend } from "./core/send/useSend";
import { useCompose, useComposeDraft } from "./core/compose/useCompose";
import { bootFeatures, openPluginFromNotification } from "./core/dispatch";
import { runSheetLeave } from "./core/sheets";
import { useConnection } from "./core/conn/useConnection";
import { useRoute } from "./core/route/useRoute";
import { useTermFeed } from "./core/term/useTermFeed";
import { useSessionVerbs } from "./core/sessions/useSessionVerbs";
import { useHostFrames } from "./core/conn/useHostFrames";
import { overlayLayer } from "./core/route/overlayViews";
import { useSettingsAdoption } from "./core/settings/useSettingsAdoption";
import { useLauncherView } from "./core/launcher/useLauncherView";
import { runToolbarCommand } from "./core/session/runToolbar";
import { useRepoRefresh } from "./core/launcher/useRepoRefresh";
import { useInstallOffer } from "./core/settings/useInstallOffer";
import { useTabStripBridge } from "./core/sessions/useTabStripBridge";
import { useOutsideOpens } from "./core/route/useOutsideOpens";
import { useQueueSignals } from "./core/queue/useQueueSignals";
import { useHostState } from "./core/sessions/useHostState";
import { CliUpdateBanner, InsecureBanner, PhoneSetupBanner, UpdatesBanner } from "./core/Banners";
import { SessionScreen } from "./core/session/SessionScreen";
import { useSessionChrome } from "./core/session/useSessionChrome";
import { LauncherScreen } from "./core/launcher/LauncherScreen";
import { Workspace } from "./core/layout/Workspace";
import { repoOfCwd, sessionRepoNameIn, sessionRowTitleIn } from "./core/launcher/model";
import { useLatest } from "./sdk/hooks";
import { useViewport } from "./useViewport";


export function App() {
  const conn = useConnection();
  const { connRef, status, send, liveSend, liveSendAll, liveAsk, reconnectAsk, setReconnectAsk } = conn;
  const { httpsUrl, root } = conn.info;
  const authGate = useAuthGate(); // the LAN password gate (features/authGate)
  // The three queue switches the launcher's bars and the core read as values
  // (`core/prefs.ts` says what each is; the queue reads its own refs).
  const autoSend = usePref("autoSend");
  const serialSessions = usePref("serialSessions");
  const confirmQueue = usePref("confirmQueue");
  // The lists the host pushes, seeded from the snapshot (`core/sessions`).
  const {
    sessionsRaw, setSessions, recent, setRecent, closed, setClosed, repos, setRepos, reposAt, setReposAt, reposFailAt, setReposFailAt,
    intents, setIntents, backends, setBackends, update, setUpdate, meter, setMeter, updateResultSeenRef,
  } = useHostState();
  // Star, close, clear — the verbs both screens and the tab strip share, and
  // the star presses held for a link that is down (`core/sessions`). Before
  // `sessions`: the pending stars ARE part of that list.
  const verbs = useSessionVerbs(conn, () => sessionsRef.current);
  const { pendingStars, pendingFollowUps, closeSession } = verbs;
  // Everything downstream — rows, the session header, the limit sheet's resume
  // order — reads the merged list, so an offline star is not a per-call-site
  // decoration that half the UI forgets about.
  const sessions = useMemo(() => applyPendingMarks(applyPendingMarks(sessionsRaw, pendingStars, STAR_MARK), pendingFollowUps, FOLLOWUP_MARK), [sessionsRaw, pendingStars, pendingFollowUps]);
  const { initRoute, activeId, setActiveId, overlay, setOverlay, closeSheet, overlayRef, focusRepo, setFocusRepo } = useRoute();
  const term = useTermFeed({
    conn, activeId, setActiveId, setOverlay, sessions,
    getActive: () => active,
    noteVisited: (id) => setLastVisitedId(id),
    onExit: () => q.flushOutbox(),
  });
  /** Navigate to a session this client asked for (or the host pointed at) —
   *  the one copy: `op.ack`'s focus, `session.created`, `session.focus`. */
  function focusSession(id: string) {
    wantNavRef.current = false;
    term.focus(id);
  }
  const { termRef, geomRef, buffers, exitedRef, readMode, readModeRef, setView, fireReader, setOutlineJump, attach } = term;
  /**
   * The compose box's draft, its history and focus (`core/compose`) — state
   * only, above the queue, which reads the box (`composeTextRef`) and puts
   * words back into it. What ACTS on it is `useCompose`, below the send core.
   */
  const draft = useComposeDraft();
  const { compose, setCompose, composeNow, composeRef, pushHistory, insertCompose, composeFocused, setComposeFocused } = draft;
  // Return submits instead of inserting a newline (the keyboard's own key is
  // relabelled "send" to match). On by default — a phone keyboard's Return is
  // the natural send gesture and reaching for the on-screen Send button after
  // every line is the main thing that makes typing here feel unfinished.
  // Off = Return newlines and only the button sends; the escape hatch for
  // multi-line prompts typed by hand (Shift/Ctrl/⌘+Return newlines either way).
  const enterSends = usePref("enterSends");
  // CLI mode as remembered, per device (`cliKeys.ts`; `useCompose` applies it).
  const cliModeOn = usePref("cliMode");
  // A cold notification tap that named a picture (→ the viewer) or a file the
  // viewer renders (→ the gallery on it): the images feature's stores, seeded
  // once before any sheet reads them.
  seedFromRoute(initRoute, !!initRoute.file && viewerHandles(initRoute.file.relPath));
  // The rule list is features/schedule's (seeded from the device cache); the
  // backlog's schedule chips read it here.
  const schedules = useSchedules();
  // Auto-download: the per-device transfer state, as `features/pull` mirrors it.
  const pullRecords = usePullRecords();
  // This phone's own marks on Activity rows (features/activity): the waiting
  // chips and the stuck counts leave out what has already been dealt with.
  const activityFiled = useActivityFiled();
  const activityConfirmedDone = useActivityConfirmedDone();
  const sessionsRef = useLatest(sessions); // the verbs' dead-target check, from callbacks
  const reposRef = useLatest(repos); // the download rows' repo namer

  // Repo whose git diff to show when the git overlay is opened from the launcher
  // (no active session). Falls back to the active session's repo.
  const [gitRepoId, setGitRepoId] = useState<string | null>(null);
  /** The backlog as the host last said it (features/backlog, seeded from the
   *  snapshot): the compose strip, the launcher's badges and the fire-nav read it. */
  const bl = useBacklog();
  /**
   * The per-repo colours, subscribed for the RE-RENDER rather than the value —
   * every `repoAccentStyle(...)` in this file reads `format.ts`'s module state
   * mid-render, and what a change needs is for this tree to run again. Adopting
   * another device's copy (`onSettingsChange` below) goes through the same
   * store, so a colour picked on the desktop repaints the phone's launcher
   * without a reload.
   */
  useRepoColors();
  const tabsOn = usePref("tabsOn");
  // Settings that follow the USER: the sync install and the adopt switch (`core/settings`).
  useSettingsAdoption({ connRef, setLaunch: (l) => setLaunch(l), setHiddenRepoIds: (ids) => setHiddenRepoIds(ids) });
  // Most-used-first toolbar order: the snapshot is taken here (features/toolbarCfg),
  // read by the session screen's menu (`core/session`).
  useUsedOrderSnapshot(activeId);
  const usage = useUsage(); // the last `/usage` reading (features/tokens)
  const billing = useBilling(); // the billing profile (features/tokens)

  const wantNavRef = useRef(false); // jump to the next created session (this client asked for it)
  const firedIdRef = useRef<string | null>(null); // backlog item we just fired (for queue-reuse nav)
  const [lastVisitedId, setLastVisitedId] = useState<string | null>(null); // highlight the row we last opened

  /**
   * The send QUEUE — every compose/slash send, every durable op, every attached
   * file's bytes (`core/queue`). Ref-authoritative, and the one place an ackId
   * is minted (`queue.test.mjs`). App's call sites keep their names below.
   */
  const q = useQueue({
    conn, sessions, repos, activeId, setActiveId, setLastVisitedId: (id) => setLastVisitedId(id),
    overlayRef, setOverlay, wantNavRef, buffers, readModeRef, exitedRef,
    composeTextRef: composeNow, setCompose, pushHistory,
    openSend: (seed) => openSend(seed), sendTargetFor: (sid, cwd) => sendTargetFor(sid, cwd),
    repoForCwd: (cwd) => repoForCwd(cwd),
    // The op created/named a session and the user was looking at the tap that
    // asked for it → open it (`op.ack`'s focus branch; view state is App's).
    focusSession: (sid) => focusSession(sid),
  });
  const outbox = q.entries;
  const {
    outboxRef, writeOutbox, flushOutbox, idleReason, goneLanes, submitInput, queueOp, queueBacklog, queueImageUpload,
    pendingSession, answerPrompt, holdQueueRef, laneLabel, sendQueuedNow, toggleHoldQueued, toggleSerialQueued,
    removeQueued, editQueued, retargetQueued, restoreQueued, retryFailedQueued, moveQueued, addPromptToQueuedCreate,
    scheduleQueueRows, dropScheduleQueue, repoIdOfEntry,
  } = q;
  const { allBufsRef } = q.uploads;
  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? pendingSession,
    [sessions, activeId, pendingSession],
  );
  /** True while the screen on top is a session that has not been created yet. */
  const pending = !!pendingSession && active?.id === pendingSession.id;
  // The launch core: every way a session starts, and the two questions a
  // fresh start may ask first (`core/launch`). Getters for what App derives
  // below this line.
  const launchCore = useLaunch({
    backends, setOverlay, geomRef, queue: q,
    setRepos, setReposAt, setReposFailAt, root, repos, active,
    openingCwds: () => openingCwds, repoForCwd: (cwd) => repoForCwd(cwd),
  });
  const {
    launch, setLaunch, setLaunchOpt, pickBackend, wireLaunch, sessionCan, sessionCant, refreshRepos,
    openRepo, openCwd, startSessionWithPrompt, relaunch,
  } = launchCore;
  /**
   * Whether the READER is the thing on screen — not the same question as
   * `readMode`, which is only the sticky preference: a backend with no
   * `transcript` capability draws the terminal under it either way, and
   * anything scoped to "the reader is up" has to key on what is actually
   * rendered or it fires over a live xterm. Never PENDING: nothing to read yet. */
  const readerShown = readMode && !pending && hasCap(backends, active ? backendIdOf(active) : undefined, "transcript") && !(active?.cliSetup && active.running);
  /**
   * The one send surface's plumbing (`core/send`): the Send sheet's seed,
   * `openSend` and `dispatchIntent` (the one map from a decision onto the send
   * paths), the seeds other screens hand it, and the per-repo send memory.
   */
  const sendCore = useSend({
    connRef, liveSend, liveSendAll, queue: q, sessions, getVisibleRepos: () => visibleRepos, intents, usage,
    launch, wireLaunch, geomRef, repoForCwd: (cwd) => repoForCwd(cwd), startSessionWithPrompt, setOverlay, attach,
  });
  const {
    sendSeed, sendSeedRef, openSend, seedFromIntent, seedFromSchedule,
    sendTargetFor, renderRetime,
  } = sendCore;
  /**
   * The compose bar (`core/compose`): the split Send button and its aim, CLI
   * mode's key pipe, history, snippets and the microphone. Every send it makes
   * goes through the queue or `dispatchIntent`; the box is cleared only once
   * the words are there (`compose.test.mjs`).
   */
  const composeCore = useCompose(draft, {
    conn, active, pending, activeId, sessions, readerShown, enterSends, cliModeOn,
    setCliModeOn: (on) => setPref("cliMode", on), showCli: () => setView(false),
    queue: q, sender: sendCore, repoForCwd: (cwd) => repoForCwd(cwd), leave: () => setActiveId(null), cliInstalled: update?.current, relaunch,
  });
  const { cliMode, voice } = composeCore;
  /**
   * The session screen's chrome — typing room, its peek, full screen and the
   * dismissed reply (`core/session`). A hook here, not state in the screen,
   * because the screen unmounts under every sheet and these must not.
   */
  const chrome = useSessionChrome({ activeId, active, composeFocused, setComposeFocused, composeRef, cliMode });
  const activeRepo = useMemo(() => (active ? repoOfCwd(repos, active.cwd) : null), [active, repos]);
  const activeRepoId = activeRepo?.id ?? null;
  /** What is in this repo's inbox/outbox, read only while the reader is on
   *  screen: it is what lets a bare `shot-04.gif` in a code span resolve to the
   *  file (transportIndex.ts). Absent — offline, or a repo with nothing in
   *  either dir — and such a span stays a code span. */
  const transportKnown = useTransportIndex(activeRepoId, readMode);
  // The launcher's cuts: hidden repos, focus, what is visible, opens in flight (`core/launcher`).
  const {
    setHiddenRepoIds, toggleHideRepo, visibleRepos, hiddenRepos, hiddenRepoPaths, openingCwds, cwdInFocus, cwdVisible,
    visibleBacklogItems,
  } = useLauncherView({ repos, focusRepo, outbox, bl });
  // Which repo a session is in — `core/launcher/model.ts`'s rule, the one the
  // launcher's headers use, so the session accent and title cannot drift.
  const repoForCwd = (cwd: string) => repoOfCwd(repos, cwd);
  const sessionRepo = (s: SessionInfo) => repoOfCwd(repos, s.cwd);
  const sessionRepoName = (s: SessionInfo) => sessionRepoNameIn(repos, s);
  const sessionRowTitle = (s: SessionInfo) => sessionRowTitleIn(repos, s);
  // Name the window after its repo so focused tabs/windows are telling apart.
  useEffect(() => {
    setDocTitle(focusRepo); // `<repo> — <name>`, a fork's name included (`themeOverlay.ts`)
  }, [focusRepo]);
  useViewport();
  // Tick so relative "finished N ago" labels stay current without new messages (visible only: a hidden tick is a render nobody sees).
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) setNowTick((n) => n + 1); }, 30000); return () => clearInterval(t); }, []);
  // Feature usage: every overlay/sheet open counts as a use of that feature.
  // One effect covers all of them (setOverlay is called from ~40 places).
  useEffect(() => { if (overlay) track(`overlay:${overlay}`); }, [overlay]);
  // The toolbar's command switch (`core/session/runToolbar.ts`).
  const runToolbar = (id: string) => runToolbarCommand(id, { setOverlay, activeRepoId, active, readMode, fireReader, send, geomRef, submitInput, openCompanionShell: launchCore.openCompanionShell });
  // The socket's frame switch and its one subscription (`core/conn`).
  useHostFrames({ conn, term, verbs, q, focusSession }, {
    connRef, setBackends, setSessions, setRecent, setClosed, setUpdate, setMeter, setIntents, updateResultSeenRef, wantNavRef,
  });
  // Repos re-listed on connect and on a turn's end; a manual fire followed (`core/launcher`).
  useRepoRefresh({ status, refreshRepos, activeId, active, wantNavRef, firedIdRef, bl, sessions, attach, repos, overlay });
  // The two "worth saying once" toasts — the cost level and a large running subagent.
  useCostNotices(active);
  // The PWA install offer: its state and the prompt capture (`core/settings`).
  const { installEvt, canInstall, setCanInstall, installed } = useInstallOffer();
  // Ship the connectivity roll-up (netlog.ts) — periodic + on hide.
  useEffect(() => { startLinkReporting(); }, []);
  // The tab strip: published, and its two taps heard (`core/sessions`).
  useTabStripBridge({ tabsOn, sessions, sessionRepoName, activeId, repos, attach, closeSession, backends });

  /**
   * Ask for the usage figure when a screen that shows it comes up.
   *
   * **No clock here.** This was two effects, each re-deciding "is the reading
   * stale?" against its own copy of the host's eight-minute TTL, one of them
   * with a throttling ref on top — the phone's clock deciding when the desktop
   * should spend a PTY on a scrape, with the constant living in three places.
   * `usage.refresh` is TTL-respecting host-side now (`getFresh`), so asking is
   * free and idempotent and the rule exists once, where the scrape does.
   */
  useEffect(() => {
    if (status !== "open") return;
    if (active && overlay !== "settings") return;
    send({ t: "usage.refresh" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `send` is bound to the one connection; asked on a screen change or a connect, never per render
  }, [overlay, active, status]);

  // Downloads named, notification taps and the shell's "open this" (`core/route`).
  useOutsideOpens({ reposRef, initRoute, sessions, attach, setOverlay });
  /** Open the git diff view for a repo (untracked count tap). */
  function openGitFor(repoId: string) { setGitRepoId(repoId); setOverlay("git"); }
  // The stuck-sends count and the reload veto (`core/queue`).
  useQueueSignals({ outbox, activityFiled, activityConfirmedDone, allBufsRef });
  // The feature contract (`sdk/types.ts`): App's own functions, rebound every
  // render so a feature reads this render's state. Hooks below stay above the
  // `authGate` return.
  bindCore({
    conn: {
      get status() { return connRef.current.status; }, send, trySend: (f) => connRef.current.trySend(f), liveSend, liveSendAll, liveAsk,
      info: conn.info,
    },
    queue: {
      queueOp, submitInput, mintAckId: newAckId, entries: q.entries, repoIdOf: repoIdOfEntry,
      drop: (ackId) => writeOutbox(outboxRef.current.filter((e) => e.ackId !== ackId)),
      blocked: q.blocked, goneLanes, laneLabel, answerPrompt, queueBacklog,
      flush: flushOutbox, idleReason,
      // The flusher reads `prefRef("serialSessions")`, moved in the same call.
      serial: { on: serialSessions, set: (on) => setPref("serialSessions", on) },
      verbs: {
        sendQueuedNow, toggleHoldQueued, toggleSerialQueued, removeQueued, editQueued, retargetQueued,
        restoreQueued, retryFailedQueued, moveQueued, addPromptToQueuedCreate, scheduleQueueRows, dropScheduleQueue,
      },
      uploads: q.uploads, queueImageUpload,
    },
    nav: {
      overlay, open: setOverlay, close: closeSheet, attach, openRepo, openSend, startSessionWithPrompt, openBacklogCut,
      openScheduleCut, closeSession, openPlugin: (id) => openPluginFromNotification(id), openRepoHealth, openSetup, openContext: (id) => { const s = id ? sessions.find((x) => x.id === id) : undefined; if (s) openContextFor(s); else openContext(); },
      followFire: (id) => { wantNavRef.current = true; firedIdRef.current = id; },
      openPadAt,
      sendSeeded: () => sendSeedRef.current != null,
      openActivity, openGit: openGitFor, openReader: term.openReader, openCapture: openCaptureFor, openBuild: openBuildFor,
    },
    launch: { setOpt: setLaunchOpt, wire: wireLaunch, openCwd, relaunch, focusShell: launchCore.focusShell, shellCant: launchCore.shellCant },
    term: { snapshot: term.snapshot, geom: () => geomRef.current },
    compose: {
      draft: compose, insert: insertCompose, seedDraft: composeCore.seedDraft, typeOn: composeCore.typeOn, send: composeCore.sendNow, pushHistory, removePadNotes,
      loadSheetDraft, seedSheetDraft, appendSheetDraft, gridText: () => termRef.current?.getText() ?? "",
    },
    world: {
      sessions, repos, visibleRepos, active, activeRepo, backends, recent, closed, intents, launches: q.launches, budget: q.budget, billing, meter, usage, get usageReadings() { return readingsNow(); }, get tokensOpenOn() { return tokensOpenOnNow(); }, clearTokensOn, launch, update,
      sessionRepo, sessionRowTitle, sessionCan, sessionCant, repoForCwd, refreshRepos,
      schedules, pending, backlog: bl.items, backlogAuto: bl.auto,
      cwdVisible,
    },
    files: {
      downloadArtifact, openArtifact: (f) => openArtifact(f), viewImage, attachForInbox, annotate,
      openSweep, editBacklogImage: backlogEditImage, annotateUrl, attachFiles: routeFiles, browseTo: openBrowseAt,
      // Named return ⇒ not a notification tap (no `notif:open-file` count).
      openFileFrom: (f, back) => openArtifact(f, back),
    },
    send: { renderRetime, seedFromSchedule, seedFromIntent, targetFor: sendTargetFor },
    say: { toast: showToast, track, confirm: askConfirm },
  });
  const prevOverlayRef = useRef<Overlay>(overlay);
  useEffect(() => { runSheetLeave(prevOverlayRef.current, overlay); prevOverlayRef.current = overlay; }, [overlay]);
  useEffect(() => bootFeatures(), []);

  if (authGate) return <AuthGate reconnect={() => connRef.current.reconnect()} />;

  // ── Overlays (`core/route/overlayViews.tsx`) ─────────────────────────
  const sheet = chrome.drawnSheet(overlayLayer({
    overlay, setOverlay, closeSheet, connRef, status, setReconnectAsk, submitInput, holdQueueRef, flushOutbox, removeQueued,
    pendingSession, insertCompose, setOutlineJump, setView, active, sessions, visibleRepos, outbox, usage, intents,
    launchCore, sessionCant, pickBackend, refreshRepos, sendCore, sendSeed, voice, installed, canInstall, installEvt,
    setCanInstall, gitRepoId, setGitRepoId, activeRepoId, repos, backends,
  }));
  // ── The frame (`core/layout/Workspace`): phone = sheet ?? session ??
  // launcher, wide = the launcher as a sidebar beside them. The launcher's
  // banners: the queue bars and the two banners, between header and list.
  return <Workspace sheet={sheet} overlay={overlay} session={active ? (
    <SessionScreen active={active} pending={pending} conn={conn} term={term} q={q} compose={composeCore}
      launch={launchCore} chrome={chrome} backends={backends} sessions={sessions} update={update}
      readerShown={readerShown} activeRepo={activeRepo} transportKnown={transportKnown}
      visibleBacklogItems={visibleBacklogItems} intents={intents} verbs={verbs} repoForCwd={repoForCwd}
      sessionRepoName={sessionRepoName} setActiveId={setActiveId} setOverlay={setOverlay} runToolbar={runToolbar} />
  ) : null} launcher={
    <LauncherScreen sessions={sessions} recent={recent} closed={closed} repos={repos} reposAt={reposAt} reposFailAt={reposFailAt} backends={backends}
      intents={intents} outbox={outbox} nowTick={nowTick} launch={launch} conn={conn}
      route={{ focusRepo, setFocusRepo, setOverlay, lastVisitedId }}
      view={{ visibleRepos, hiddenRepos, hiddenRepoPaths, cwdInFocus, toggleHideRepo, openingCwds }}
      launchCore={launchCore} term={term} queue={q} openSend={openSend} verbs={verbs} openGitFor={openGitFor}
      banners={<>
        <QueueBars q={q} status={status} reconnectAsk={reconnectAsk} setReconnectAsk={setReconnectAsk}
          autoSend={autoSend} confirmQueue={confirmQueue} pullRecords={pullRecords} setOverlay={setOverlay} />
        <InsecureBanner httpsUrl={httpsUrl} />
        <PhoneSetupBanner onOpen={() => setOverlay("phonesetup")} />
        <CliUpdateBanner update={update} liveAsk={liveAsk} liveSend={liveSend} /><UpdatesBanner />
      </>} />
  } />;
}
