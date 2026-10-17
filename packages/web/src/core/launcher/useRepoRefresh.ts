import { useEffect, type MutableRefObject } from "react";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import type { useBacklog } from "../../features/backlog";
import type { Connection } from "../conn/useConnection";
import type { Launch } from "../launch/useLaunch";
import type { TermFeed } from "../term/useTermFeed";
import { useGitBusyRefresh } from "./useGitBusyRefresh";

export interface UseRepoRefreshCtx {
  status: Connection["status"];
  refreshRepos: Launch["refreshRepos"];
  activeId: string | null;
  active: SessionInfo | null;
  wantNavRef: MutableRefObject<boolean>;
  firedIdRef: MutableRefObject<string | null>;
  bl: ReturnType<typeof useBacklog>;
  sessions: SessionInfo[];
  attach: TermFeed["attach"];
  repos: RepoTarget[];
  overlay: string | null;
}

/**
 * Re-list the repos on a connect and when the open session's turn ends, and
 * follow a manual fire to the session it used (docs/notes/app-architecture.md).
 * Three of App's effects, verbatim and in their order.
 */
export function useRepoRefresh(ctx: UseRepoRefreshCtx) {
  const { status, refreshRepos, activeId, active, wantNavRef, firedIdRef, bl, sessions, attach, repos, overlay } = ctx;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-list on a connect (status) only; `refreshRepos` is not guaranteed stable
  useEffect(() => { refreshRepos(); }, [status]);
  // Keep inbox/untracked counts fresh for the open session: refetch on open and
  // whenever its turn finishes (idle), since the agent may have created files.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-list on open/turn-end only; `refreshRepos` is not guaranteed stable
  useEffect(() => { if (activeId) refreshRepos(); }, [activeId, active?.idle]);
  // …and on coming back to the launcher (leaving a session, or the app being
  // brought to the front on it): the list is what this screen IS, so it is
  // re-read where it is looked at rather than left at the last session's turn.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-list on reaching the launcher only; `refreshRepos` is not guaranteed stable
  useEffect(() => { if (!activeId) refreshRepos(); }, [activeId]);
  useGitBusyRefresh({ refreshRepos, activeId, repos, overlay });
  useEffect(() => {
    if (activeId) return;
    const onVis = () => { if (document.visibilityState === "visible") refreshRepos(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bound while the launcher is showing; `refreshRepos` is not guaranteed stable
  }, [activeId]);
  // After a manual fire, jump to the session it used — covers queue-mode reuse,
  // which doesn't emit a session.created (that path navigates on its own).
  useEffect(() => {
    if (!wantNavRef.current || !firedIdRef.current) return;
    const it = bl.items.find((i) => i.id === firedIdRef.current);
    if (it?.status === "running" && it.sessionId) {
      const s = sessions.find((x) => x.id === it.sessionId);
      if (s) { wantNavRef.current = false; firedIdRef.current = null; attach(s); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on list changes only; the refs are read live and `attach` must not re-trigger a navigation
  }, [bl.items, sessions]);
}
