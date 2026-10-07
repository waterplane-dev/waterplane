import { useEffect } from "react";
import type { RepoTarget, SessionInfo } from "@waterplane/shared";
import { TAB_ATTACH_EVENT, TAB_CLOSE_EVENT, noteSessionTabs, tabLabel } from "../../sessionTabs";
import { sessionStatus } from "../../sessionFacts";
import type { BackendList } from "../../backendCaps";
import type { TermFeed } from "../term/useTermFeed";
import type { SessionVerbs } from "./useSessionVerbs";

interface UseTabStripBridgeCtx {
  tabsOn: boolean;
  sessions: SessionInfo[];
  sessionRepoName: (s: SessionInfo) => string;
  activeId: string | null;
  repos: RepoTarget[];
  attach: TermFeed["attach"];
  closeSession: SessionVerbs["closeSession"];
  backends: BackendList;
}

/**
 * The session-tab strip's two seams to App: what it draws, published, and its
 * two taps, heard (docs/notes/app-architecture.md). Two of App's effects,
 * verbatim and in their order.
 */
export function useTabStripBridge(ctx: UseTabStripBridgeCtx) {
  const { tabsOn, sessions, sessionRepoName, activeId, repos, attach, closeSession, backends } = ctx;
  /**
   * **The session-tab strip, published.**
   *
   * The third always-on bar is mounted beside `App` (`main.tsx`) for the reason
   * the two above it are, so it can read neither this component's session list
   * nor its setters. `sessionTabs.ts` is the seam: this is the ONE writer, and
   * it publishes what is already on screen — no second source of "which
   * sessions exist", and no listener of its own watching for removals (the
   * store prunes its open counts off this same call).
   *
   * The label is `tabLabel`'s decision, not this component's: the host's ≤3-word
   * `tabTitle` when it has derived one, the session's own title otherwise.
   */
  useEffect(() => {
    if (!tabsOn) return;
    noteSessionTabs(
      sessions.map((s) => {
        const repo = sessionRepoName(s);
        return {
          id: s.id,
          label: tabLabel(s, repo),
          repo,
          // The strip holds no opinion of its own about what a session is doing
          // — this is the same call the row badge, the repo roll-up and the
          // status filter make (`sessionFacts.tsx`).
          status: sessionStatus(s, backends),
          createdAt: s.createdAt,
          ...(s.companionOf ? { companionOf: s.companionOf } : {}),
        };
      }),
      activeId,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `sessionRepoName` is a per-render closure; re-run is driven by sessions, activeId, repos and tabsOn
  }, [sessions, activeId, repos, tabsOn]);
  /**
   * What a tab's tap does. Two verbs, and they are the launcher's own — the
   * strip decides nothing: `attach` is the same function a session row calls,
   * and the × ends in `closeSession`, which asks the host whether the session
   * is safe to close and keeps the conversation either way.
   *
   * The confirmation happens in the STRIP (`Confirm.tsx`, never
   * `window.confirm`), before this event is ever fired — a 22 px target beside
   * a label a thumb is aiming at may not end a running CLI process on its own.
   */
  useEffect(() => {
    const idOf = (e: Event) => (e as CustomEvent<{ id?: string }>).detail?.id ?? "";
    const open = (e: Event) => {
      const s = sessions.find((x) => x.id === idOf(e));
      if (s) attach(s);
    };
    const close = (e: Event) => {
      const s = sessions.find((x) => x.id === idOf(e));
      if (s) closeSession(s);
    };
    // No dependency array on purpose: both handlers close over `sessions` and
    // over two functions rebuilt every render, and a stale `sessions` here is a
    // tap that opens nothing on the session list's first change.
    window.addEventListener(TAB_ATTACH_EVENT, open);
    window.addEventListener(TAB_CLOSE_EVENT, close);
    return () => {
      window.removeEventListener(TAB_ATTACH_EVENT, open);
      window.removeEventListener(TAB_CLOSE_EVENT, close);
    };
  });
}
