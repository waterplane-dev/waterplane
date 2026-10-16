/**
 * The session screen: one attached session (or a queued open — the pending
 * session IS a session screen, `web`) with its header, the terminal or
 * the reader, the next-prompt strip, the queue bars and the compose bar.
 *
 * Lifted out of App unchanged. It is App's `return` for "a session is on top
 * and no overlay covers it"; App returns early for every overlay, so this
 * UNMOUNTS under a sheet — which is why the chrome state that must outlive a
 * sheet (full screen, the dismissed reply) is `useSessionChrome`, called once
 * in App, and not state in here. Everything else it reads is a store (a pref,
 * a feature's hook) or a core hook's return handed down whole.
 *
 * What a toolbar tap DOES stays App's (`runToolbar`, the command switch): it
 * reaches the reader, the search sheet and the socket, and falls through to a
 * feature's own command.
 */
import type { ReactNode } from "react";
import type { BackendInfo, BacklogItem, Intent, RepoTarget, SessionInfo, UpdateInfo } from "@waterplane/shared";
import type { Overlay } from "../../routing";
import { NetActivity } from "../../NetActivity";
import type { Connection } from "../conn/useConnection";
import type { TermFeed } from "../term/useTermFeed";
import type { QueueApi } from "../queue/useQueue";
import type { ComposeApi } from "../compose/useCompose";
import type { SessionVerbs } from "../sessions/useSessionVerbs";
import { usePref } from "../prefs";
import { ComposeBar } from "../compose/ComposeBar";
import { NextPromptStrip } from "../compose/NextPromptStrip";
import { QueueBars, type QueueBarsProps } from "../queue/QueueBars";
import { CliRestartBanner, CliUpdateBanner, InsecureBanner } from "../Banners";
import { useHeaderCmds, useHeaderSplit, useToolbarCfg } from "../../features/toolbarCfg";
import { usePullRecords } from "../../features/pull";
import { pickFileFor, pickImageFor } from "../../features/images";
import { SessionHeader } from "./SessionHeader";
import { ReturnChip } from "./ReturnChip";
import { TermArea, type TermAreaProps } from "./TermArea";
import type { ToolbarCtx } from "./ToolbarMenu";
import type { Launch } from "../launch/useLaunch";
import type { SessionChrome } from "./useSessionChrome";
import { isLaterId } from "../queue/logic.ts";

/** `Pick<>`s per hook, like `LauncherProps`: the members this screen and the
 *  pieces it draws read, and no more. */
export interface SessionScreenProps {
  active: SessionInfo;
  /** True while the screen is a session that has not been created yet. */
  pending: boolean;
  conn: TermAreaProps["conn"] & Pick<Connection, "liveSend" | "liveAsk" | "reconnectAsk" | "setReconnectAsk">;
  term: TermAreaProps["term"] & Pick<TermFeed, "refreshTerminal">;
  q: TermAreaProps["q"] & QueueBarsProps["q"] & Pick<QueueApi, "outboxRef" | "holdWall" | "isPendingId" | "sendQueuedNow"
    | "toggleHoldQueued" | "handToDesktop" | "removeQueued" | "uploads">;
  compose: ComposeApi;
  launch: TermAreaProps["launch"] & Pick<Launch, "relaunch">;
  chrome: SessionChrome;
  backends: BackendInfo[] | null;
  sessions: SessionInfo[];
  update: UpdateInfo | null;
  /** Whether the READER is the thing on screen (App's `readerShown`, which the compose core reads too). */
  readerShown: boolean;
  activeRepo: RepoTarget | null;
  /** What is in this repo's inbox/outbox, read while the reader is up (`useTransportIndex`, App's). */
  transportKnown: readonly string[] | undefined;
  /** The backlog as the launcher cuts it (hidden repos, focus) — the compose badge counts this repo's share. */
  visibleBacklogItems: BacklogItem[];
  /** The intent store — the next-prompt strip asks which pinned row the budget holds. */
  intents: readonly Intent[];
  /** Star and close — the verbs the launcher takes as the same one prop. */
  verbs: Pick<SessionVerbs, "pendingStars" | "toggleStar" | "pendingFollowUps" | "toggleFollowUp" | "closeSession">;
  repoForCwd(cwd: string): RepoTarget | null;
  sessionRepoName(s: SessionInfo): string;
  setActiveId(id: string | null): void;
  setOverlay(o: Overlay): void;
  /** App's toolbar command switch. */
  runToolbar(id: string): void;
}

export function SessionScreen(p: SessionScreenProps): ReactNode {
  const {
    active, pending, conn, term, q, compose, launch, chrome, backends, sessions, update, readerShown, activeRepo,
    transportKnown, visibleBacklogItems, repoForCwd, sessionRepoName, setActiveId, setOverlay, runToolbar,
  } = p;
  const { pendingStars, toggleStar, pendingFollowUps, toggleFollowUp, closeSession } = p.verbs;
  const { status, liveSend, liveAsk, reconnectAsk, setReconnectAsk } = conn;
  const outbox = q.entries;
  const { pendingEntry, outboxRef, holdWall, isPendingId, sendQueuedNow, toggleHoldQueued, handToDesktop, removeQueued } = q;
  const { uploading, parking, upProg, uploadPending, uploadRowLinger, cancelUploads } = q.uploads;
  const { chromeHidden, fullMode } = chrome;
  const activeRepoId = activeRepo?.id ?? null;
  // One-tap commands pinned into the session header (see headerCmds.ts; features/toolbarCfg).
  const headerCmds = useHeaderCmds();
  const toolbarCfg = useToolbarCfg();
  // Auto-download: the per-device transfer state, as `features/pull` mirrors it.
  const pullRecords = usePullRecords();
  const autoSend = usePref("autoSend");
  const confirmQueue = usePref("confirmQueue");
  /**
   * Which header chips the session on screen can take, and how many it cannot.
   *
   * ONE call, feeding the chips the header DRAWS and the count the cants strip
   * NAMES — CLAUDE.md's rule that a count on a control is a filter, and that
   * one function feeds both the number and the cut.
   *
   * This is the screen where a live `opencode` session showed a `/compact` chip
   * two rows above the sentence "no slash commands", and tapping it typed
   * Claude's vocabulary at a binary that treats it as ordinary prose. The fix is
   * worth nothing if the number and the cut can ever be computed apart.
   *
   * For claude — and for every host that never described a backend at all —
   * this is the list unchanged with `hiddenSlash: 0`, so the header is
   * byte-identical to what it has always been.
   */
  const hdrSplit = useHeaderSplit(launch.sessionCan(active, "slash"));
  const toolbar: ToolbarCtx = {
    active, pending, status, activeRepo, toolbarCfg, pendingStars, toggleStar, pendingFollowUps, toggleFollowUp, setOverlay, runToolbar, backends,
  };
  return (
    <div className={`screen${chromeHidden ? " typing" : ""}${fullMode ? " fullscreen" : ""}${readerShown ? " reading" : ""}`}>
      <SessionHeader active={active} sessions={sessions} pending={pending} pendingEntry={pendingEntry} status={status} liveSend={liveSend}
        backends={backends} sessionCan={launch.sessionCan} sessionRepoName={sessionRepoName} repoForCwd={repoForCwd}
        setActiveId={setActiveId} setOverlay={setOverlay} removeQueued={removeQueued} closeSession={closeSession}
        chrome={chrome} hdrShown={isLaterId(active.id) ? [] : hdrSplit.shown} headerCmds={headerCmds} runHeaderCmd={compose.runHeaderCmd}
        refreshTerminal={term.refreshTerminal} toolbar={toolbar} />
      <ReturnChip activeId={active.id} />
      <InsecureBanner httpsUrl={conn.info.httpsUrl} />
      <CliUpdateBanner update={update} liveAsk={liveAsk} liveSend={liveSend} />
      {!pending && <CliRestartBanner active={active} update={update} relaunch={launch.relaunch} />}

      <TermArea active={active} pending={pending} conn={conn} term={term} q={q}
        compose={compose} launch={launch} chrome={chrome} backends={backends} readerShown={readerShown}
        hiddenSlash={hdrSplit.hiddenSlash} activeRepoId={activeRepoId} transportKnown={transportKnown}
        setActiveId={setActiveId} closeSession={closeSession}
        openOutline={(toolbarCfg.pinned ?? []).includes("outline") ? () => runToolbar("outline") : undefined} />

      <NextPromptStrip active={active} outbox={outbox} outboxRef={outboxRef} online={status === "open"} holdWall={holdWall}
        isPendingId={isPendingId} sendQueuedNow={sendQueuedNow} toggleHoldQueued={toggleHoldQueued} handToDesktop={handToDesktop}
        liveSend={liveSend} setOverlay={setOverlay} intents={p.intents} />

      <QueueBars q={q} status={status} reconnectAsk={reconnectAsk} setReconnectAsk={setReconnectAsk}
          autoSend={autoSend} confirmQueue={confirmQueue} pullRecords={pullRecords} setOverlay={setOverlay}
          stripSessionId={active.id} />

      <ComposeBar api={compose} active={active} sessions={sessions} outbox={outbox} online={status === "open"}
        repoForCwd={repoForCwd} uploads={{ uploading, parking, upProg, uploadPending, uploadRowLinger, cancelUploads }}
        activeRepoId={activeRepoId} pickImageFor={pickImageFor} pickFileFor={pickFileFor}
        visibleBacklogItems={visibleBacklogItems} setOverlay={setOverlay} />

      <NetActivity />
    </div>
  );
}
