/**
 * What the launcher takes from App: ONLY what App owns. Everything a feature
 * owns (usage, CLI health, notifications, plugins, downloads, the backlog,
 * schedules, activity marks, push) is read inside through that feature's
 * index, and the launcher-only state lives in `useLauncherModel`'s stores.
 */
import type { ReactNode } from "react";
import type { BackendInfo, ClosedSession, Intent, LaunchOpts, RecentSession, RepoTarget, SessionInfo } from "@waterplane/shared";
import type { OutboxEntry, OutboxStatus } from "../../outbox";
import type { Overlay } from "../../routing";
import type { Connection } from "../conn/useConnection";
import type { Launch } from "../launch/useLaunch";
import type { TermFeed } from "../term/useTermFeed";
import type { QueueApi } from "../queue/useQueue";
import type { SendApi } from "../send/useSend";
import type { SessionVerbs } from "../sessions/useSessionVerbs";

export interface LauncherProps {
  /** The host's lists, as App holds them (sessions already merged with pending stars). */
  sessions: SessionInfo[];
  recent: RecentSession[];
  closed: ClosedSession[];
  repos: RepoTarget[];
  /** When the repo listing last came from the host (0 = never). */
  reposAt: number;
  /** When a re-read of it last failed (0 = none). */
  reposFailAt: number;
  backends: BackendInfo[] | null;
  intents: Intent[];
  outbox: readonly OutboxEntry[];
  /** App's 30 s tick — relative labels and the clock cut move with it. */
  nowTick: number;
  /** The launch defaults (the no-approvals warning reads them). */
  launch: LaunchOpts;
  conn: Pick<Connection, "status" | "connVisible" | "send" | "liveSend" | "info">;
  route: {
    focusRepo: string | null;
    setFocusRepo: (name: string | null) => void;
    setOverlay: (o: Overlay) => void;
    /** The row last opened — highlighted, and scrolled back into view. */
    lastVisitedId: string | null;
  };
  /** The repo view App shares with the send sheet, the compose bar and the core. */
  view: {
    visibleRepos: RepoTarget[];
    hiddenRepos: RepoTarget[];
    hiddenRepoPaths: ReadonlySet<string>;
    cwdInFocus: (cwd: string) => boolean;
    toggleHideRepo: (id: string) => void;
    /** In-flight opens per directory, off the queue's own creates (`useLaunch` reads it too). */
    openingCwds: ReadonlyMap<string, { status: OutboxStatus; n: number }>;
  };
  launchCore: Pick<Launch, "openRepo" | "openShell" | "openCwd" | "reopenCant" | "sessionCan" | "refreshRepos" | "setBranchPick">;
  term: Pick<TermFeed, "attach" | "openReader">;
  queue: Pick<QueueApi, "enterOldestPending">;
  openSend: SendApi["openSend"];
  verbs: SessionVerbs;
  /** The git sheet on a repo (App holds which repo). */
  openGitFor: (repoId: string) => void;
  /** Queue bars + the two banners, drawn between the header and the list. */
  banners: ReactNode;
}
