import type { MutableRefObject, ReactNode } from "react";
import type { BackendInfo, Intent, RepoTarget, SessionInfo, UsageInfo } from "@waterplane/shared";
import { parseFocus, type Overlay } from "../../routing";
import { SlashSheet } from "../../SlashSheet";
import { backendIdOf, ownCommandsHere } from "../../backendCaps";
import { GitNoRepo, GitView } from "../../GitView";
import { gitViewRepoId } from "../../gitLanding";
import { listRead } from "../../listRead";
import { gitFailSeed } from "../../gitFailPrompt";
import { OutlineSheet } from "../../OutlineSheet";
import { SheetGuard } from "../../BootGuard";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { handleNotif } from "../../features/notifications";
import { annotate, attachForInbox, openBrowseFor, openGalleryForSend } from "../../features/images";
import { SettingsSheet } from "../settings/SettingsSheet";
import { SendSheetEntry } from "../send/SendSheetEntry";
import { featureSheets } from "../sheets";
import { openShotPick } from "../launcher/LauncherScreen";
import type { Route } from "./useRoute";
import type { Connection } from "../conn/useConnection";
import type { QueueApi } from "../queue/useQueue";
import type { Launch } from "../launch/useLaunch";
import type { SendApi } from "../send/useSend";
import type { ComposeApi, ComposeDraft } from "../compose/useCompose";
import type { TermFeed } from "../term/useTermFeed";
import type { groupByRepo } from "../../sessionFacts";

/** What the overlay table reads — this render's values, as App held them. */
export interface OverlayCtx extends Pick<Route, "overlay" | "setOverlay" | "closeSheet">,
  Pick<Connection, "connRef" | "status" | "setReconnectAsk">,
  Pick<QueueApi, "submitInput" | "holdQueueRef" | "flushOutbox" | "removeQueued" | "pendingSession">,
  Pick<ComposeDraft, "insertCompose">, Pick<TermFeed, "setOutlineJump" | "setView"> {
  active: SessionInfo | null;
  sessions: SessionInfo[];
  visibleRepos: ReturnType<typeof groupByRepo>;
  outbox: QueueApi["entries"];
  usage: UsageInfo | null;
  intents: Intent[];
  launchCore: Launch;
  sessionCant: Launch["sessionCant"];
  pickBackend: Launch["pickBackend"];
  refreshRepos: Launch["refreshRepos"];
  sendCore: SendApi;
  sendSeed: SendApi["sendSeed"];
  voice: ComposeApi["voice"];
  installed: boolean;
  canInstall: boolean;
  installEvt: MutableRefObject<any>;
  setCanInstall: (on: boolean) => void;
  /** The repo the git route entry is open on (`useGitRoute`), or null for the active one. */
  gitRepoId: string | null;
  activeRepoId: string | null;
  repos: RepoTarget[];
  /** When the host last answered for `repos` (0 = never): an empty list is "waiting" only until then. */
  reposAt: number;
  /** What this host said it can launch — the Send sheet's *model* row. */
  backends: BackendInfo[] | null;
}

/**
 * The sheet on top, or `null` for the screen underneath (docs/notes/app-architecture.md).
 * A FUNCTION App calls after its `authGate` return, not a component: App falls
 * through to the launcher or the session screen on a miss, which only a value
 * it holds before returning can tell it — and the element tree stays the one
 * App always returned.
 */
export function overlayLayer(ctx: OverlayCtx): ReactNode | null {
  const {
    overlay, setOverlay, closeSheet, connRef, status, setReconnectAsk, submitInput, holdQueueRef, flushOutbox, removeQueued,
    pendingSession, insertCompose, setOutlineJump, setView, active, sessions, visibleRepos, outbox, usage, intents,
    launchCore, sessionCant, pickBackend, refreshRepos, sendCore, sendSeed, voice, installed, canInstall, installEvt,
    setCanInstall, gitRepoId, activeRepoId, repos, reposAt, backends,
  } = ctx;
  // ── Overlays ────────────────────────────────────────────────────────
  /**
   * A sheet threw. Close it — the route is what makes this a boot loop rather
   * than a bad screen — and SAY so, naming the sheet and the error: the
   * boundary's own fallback is unmounted by this very call, and the alternative
   * is the app silently bouncing you to the launcher whenever a tap fails.
   */
  const onSheetFail = (name: string, message: string) => {
    setOverlay(null);
    showToast(`${name} failed to open — ${message}`);
  };

  /**
   * Which sheet is on top, as a TABLE.
   *
   * This was forty sequential `if (overlay === "x") return …` branches, and the
   * shape had two costs beyond its 1,450 lines. Adding a sheet meant splicing
   * into the middle of that chain, five thousand lines from `PERSISTED_OVERLAYS`
   * in `routing.ts` — the other list a new overlay has to appear in, and the one
   * that decides whether a reload lands back on it. And because each branch
   * RETURNED, anything meant to be on screen at all times had to be repeated
   * inside every branch that could be showing: a layer rendered in only some of
   * them is a layer that is missing from the rest, which is not a bug that
   * announces itself.
   *
   * A miss returns null, which falls through to the screen underneath exactly as
   * an unmatched branch used to. That is what the guarded entries rely on: an
   * overlay whose backing state is gone (a reload restored "image" with no
   * picked file) paints the screen below rather than an empty sheet.
   */
  const overlayViews: Partial<Record<NonNullable<Overlay>, () => ReactNode>> = {
    ...featureSheets(),
    ...launchCore.sheets,
    slash: () => {
      if (!(active)) return null;
        return <SlashSheet cwd={active.cwd} backends={backends} backend={ownCommandsHere(backends, backendIdOf(active)) ? backendIdOf(active) : undefined} onClose={() => setOverlay(null)}
        // A backend that does not understand `/name` has no palette to show,
        // and the repo's `.claude/commands` are not its commands either. The
        // list is replaced by the reason, never by an empty palette captioned
        // "no matches" — that would be a claim about this repo rather than
        // about the binary in the PTY.
        unsupported={ownCommandsHere(backends, backendIdOf(active)) ? undefined : sessionCant(active, "slash") ?? undefined}
        onPick={(name, runNow) => {
        // "run" was the ONE prompt-runner in the app that went straight onto
        // the socket: text and Return as two bare writes plus a `session.record`
        // to make it show up in history. On a dead tunnel all three were
        // RAM-queued and died at the next reload, so the palette closed, the
        // command never ran, and nothing anywhere said so. It is the same act
        // as typing `/cost` into the compose box, so it now takes the same
        // path: `submitInput` — durable, ackId'd, echo-checked host-side, and
        // recorded by the host rather than by a second frame that could be
        // delivered without the first.
        if (runNow) {
          setOverlay(null);
          if (submitInput(active.id, active.cwd, name, "command")) {
            showToast(connRef.current.status === "open" ? `running ${name}` : `${name} queued — it runs when the link is back`);
          }
        } else { insertCompose(name); setOverlay(null); }
      }} />;
    },

    /* The app's own configuration, and every feature's rows through
       `featureSettingsRows` (core/settings). What it takes as props is what
       only App holds today. */
    settings: () => (
      <SettingsSheet
        pickBackend={pickBackend} voice={voice}
        install={{ installed, canInstall, evt: installEvt, taken: () => setCanInstall(false) }}
        reconnect={{ holdRef: holdQueueRef, setReconnectAsk, flush: flushOutbox }}
        redial={() => connRef.current.reconnect()}
        pickShotRepo={openShotPick}
      />
    ),

    git: () => {
      // `?repo=` as the URL holds it: the one a reload or an update resume came back on.
      const focus = parseFocus();
      const gitId = gitViewRepoId(gitRepoId, focus, activeRepoId, repos);
      if (!gitId) return <GitNoRepo focus={focus} list={listRead({ rows: repos, readAt: reposAt })} session={!!active} onClose={() => setOverlay(null)} />;
      const gitRepo = repos.find((r) => r.id === gitId);
        return <GitView repoId={gitId}
          // A failed push/pull's log, as a seed for a new session in this repo:
          // the Send sheet opens on it and sends nothing. Back lands here again.
          onAskAgent={gitRepo ? (f) => sendCore.openSend(gitFailSeed(f, gitRepo)) : undefined}
          stored={gitRepo?.gitFailed} failures={gitRepo?.gitFailures} onDone={handleNotif}
          onBrowse={() => openBrowseFor(gitId, "git")}
          // The repo and the tapped failure are the git route ENTRY's (`gitLanding.ts`): the close
          // is a Back onto an entry that holds neither; covering it with Send or the file tree,
          // and Back to it again, keeps both.
          onClose={() => { setOverlay(null); refreshRepos(); }} />;
    },

    outline: () => {
      if (!(active)) return null;
        return <OutlineSheet
        sessionId={active.id}
        title={active.title}
        onJump={(n) => {
          track("action:outline.jump");
          // The outline points INTO the reader (a terminal grid has no turn to
          // scroll to), so a jump from the CLI switches the view as well.
          setOutlineJump({ n, key: Date.now() });
          setView(true);
          setOverlay(null);
        }}
        onClose={() => setOverlay(null)} />;
    },

    // The one send surface (`core/send`). A miss returns null and falls
    // through to the screen underneath, like every entry here.
    send: () => (sendSeed ? (
      <SendSheetEntry send={sendCore} sessions={sessions} pendingSession={pendingSession} visibleRepos={visibleRepos}
        outbox={outbox} online={status === "open"} usage={usage} intents={intents} removeQueued={removeQueued}
        backends={backends} launch={launchCore.launch}
        closeSheet={closeSheet}
        onAttach={(files, repo) => attachForInbox(repo, files)}
        onAnnotate={(files, repo) => annotate(repo, files, "send")}
        onBrowseRepoFiles={openGalleryForSend} />
    ) : null),
  };

  // One layer, one return. Anything that must survive an overlay belongs
  // AROUND this, never inside a branch of it.
  //
  // Wrapped in `SheetGuard` because which sheet is open is part of the ROUTE
  // and half of them are restored on boot: an uncaught throw in here is not a
  // broken screen, it is an app that will not start until somebody finds the
  // hard reset. The guard un-routes on the catch and says what happened here,
  // rather than one frame of text nobody reads.
  const overlayNode = overlay ? overlayViews[overlay]?.() ?? null : null;
  if (overlayNode) return (
    <SheetGuard key={overlay ?? ""} name={overlay ?? ""} onFail={onSheetFail}>{overlayNode}</SheetGuard>
  );
  return null;
}
