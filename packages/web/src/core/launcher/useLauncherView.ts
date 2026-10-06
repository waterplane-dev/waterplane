import { useCallback, useMemo, useState } from "react";
import type { RepoTarget } from "@waterplane/shared";
import { isCreateOp, type OutboxStatus } from "../../outbox";
import { loadHiddenRepos } from "../../localState";
import { baseName } from "../../format";
import { groupByRepo } from "../../sessionFacts";
import { LS, lsSetJson } from "../../storage";
import type { useBacklog } from "../../features/backlog";
import type { QueueApi } from "../queue/useQueue";

export interface LauncherViewCtx {
  repos: RepoTarget[];
  focusRepo: string | null;
  outbox: QueueApi["entries"];
  bl: ReturnType<typeof useBacklog>;
}

/**
 * The launcher's cuts of the repo list — hidden repos, the focused repo's
 * paths, what is visible, which directories have an open in flight — and the
 * backlog rows they leave (docs/notes/app-architecture.md). State and memos
 * only, no effect: where App calls it has no order to keep.
 */
export function useLauncherView(ctx: LauncherViewCtx) {
  const { repos, focusRepo, outbox, bl } = ctx;
  const [hiddenRepoIds, setHiddenRepoIds] = useState<Set<string>>(loadHiddenRepos);
  const visibleRepos = useMemo(() => groupByRepo(repos.filter((r) => !hiddenRepoIds.has(r.id) && (!focusRepo || r.repoName === focusRepo))), [repos, hiddenRepoIds, focusRepo]);
  const hiddenRepos = useMemo(() => groupByRepo(repos.filter((r) => hiddenRepoIds.has(r.id) && (!focusRepo || r.repoName === focusRepo))), [repos, hiddenRepoIds, focusRepo]);
  const hiddenRepoPaths = useMemo(() => new Set(hiddenRepos.map((r) => r.worktreePath)), [hiddenRepos]);
  /**
   * Which directories have an OPEN already in flight, from the send queue's own
   * `session.create` entries.
   *
   * A tap on "+" with the link up changed NOTHING on screen: the create is
   * durable, so navigation rides on `op.ack`, and on a flapping tunnel that ack
   * is a 20 s receipt window away and possibly several attempts out. The button
   * therefore read as dead in exactly the state where it is least dead. That is
   * what the pending session screen fixed — the tap now lands on a real screen
   * immediately — so the in-flight open is a COUNT here, drawn as a chip beside
   * the repo name, and never as a spinner where the "+" was: a spinner on the
   * one control that starts work says the control is unavailable, and a second
   * session queued behind the first (its own prompt, its own screen, both
   * posted when the link is back) is a thing people legitimately want. One at a
   * time per repo is `serialSessions`' job, not this button's.
   */
  const openingCwds = useMemo(() => {
    const m = new Map<string, { status: OutboxStatus; n: number }>();
    for (const e of outbox) {
      if (!isCreateOp(e) || !e.cwd || e.status === "failed") continue;
      const prev = m.get(e.cwd);
      // `pending` (on the wire) outranks `queued` (waiting for the link) — the
      // row should say the more advanced of the two.
      m.set(e.cwd, { status: prev?.status === "pending" ? "pending" : e.status, n: (prev?.n ?? 0) + 1 });
    }
    return m;
  }, [outbox]);
  // Worktree paths belonging to the focused repo (null = no focus). The baseName
  // fallback in cwdInFocus keeps sessions in a not-yet-discovered worktree visible.
  const focusPaths = useMemo(
    () => (focusRepo ? new Set(repos.filter((r) => r.repoName === focusRepo).map((r) => r.worktreePath)) : null),
    [repos, focusRepo],
  );
  const cwdInFocus = (cwd: string) => !focusPaths || focusPaths.has(cwd) || baseName(cwd) === focusRepo;
  /** The launcher's visibility rule (`core.world.cwdVisible`) — STABLE across
   *  renders, so a feature can memo on it (the backlog's cuts did not hit). */
  const cwdVisible = useCallback(
    (cwd: string) => !hiddenRepoPaths.has(cwd) && (!focusPaths || focusPaths.has(cwd) || baseName(cwd) === focusRepo),
    [hiddenRepoPaths, focusPaths, focusRepo],
  );
  const visibleBacklogItems = useMemo(
    () => bl.items.filter((it) => !hiddenRepoPaths.has(it.repoDir) && cwdInFocus(it.repoDir)),
    [bl.items, hiddenRepoPaths, focusPaths], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function toggleHideRepo(id: string) {
    setHiddenRepoIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      lsSetJson(LS.hiddenRepos, [...n]);
      return n;
    });
  }
  return {
    hiddenRepoIds, setHiddenRepoIds, toggleHideRepo, visibleRepos, hiddenRepos, hiddenRepoPaths, openingCwds, focusPaths,
    cwdInFocus, cwdVisible, visibleBacklogItems,
  };
}
