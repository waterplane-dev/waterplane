import { useEffect, useRef } from "react";
import type { RepoTarget } from "@waterplane/shared";
import type { Launch } from "../launch/useLaunch";

/** How often the launcher re-reads the repos while a push or pull runs. */
const GIT_BUSY_POLL_MS = 10_000;

/**
 * Keep the repo row's git spinner honest (`RepoTarget.gitRunning`): while the
 * desktop is pushing or pulling somewhere, re-read on a slow beat so the
 * spinner stops when the job does — and once on leaving the git sheet, which is
 * where a push is started.
 */
export function useGitBusyRefresh(ctx: { refreshRepos: Launch["refreshRepos"]; activeId: string | null; repos: RepoTarget[]; overlay: string | null }) {
  const { refreshRepos, activeId, repos, overlay } = ctx;
  const gitBusy = repos.some((r) => r.gitRunning);
  useEffect(() => {
    if (activeId || !gitBusy) return;
    const t = setInterval(refreshRepos, GIT_BUSY_POLL_MS);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- armed by the busy flag only; `refreshRepos` is not guaranteed stable
  }, [activeId, gitBusy]);
  const prevOverlay = useRef(overlay);
  useEffect(() => {
    if (prevOverlay.current === "git" && overlay !== "git") refreshRepos();
    prevOverlay.current = overlay;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-list on the git sheet closing only; `refreshRepos` is not guaranteed stable
  }, [overlay]);
}
