import { contextPct, fmtUsd } from "@waterplane/shared";
import type { SessionSummary, TabId, ToExtension } from "../src/protocol";
import { fmtAge, isLive, isRunning } from "../src/data/running";
import { useNow } from "./HealthView";

const TITLES: Record<TabId, string> = {
  session: "Session", all: "All sessions", "always-on": "Always-on context", health: "Repo health", prompts: "Optimisation prompts",
};
const base = (f: string): string => f.split(/[\\/]/).filter(Boolean).pop() ?? f;

/**
 * The top of the panel: where you are (folder · view) and what this view is about. The panel has no
 * tab bar and no session list — the tree in the activity bar is its navigation — so the header is
 * the one place that says which session the numbers below belong to.
 */
export function ViewHead({ tab, folder, row, following, post }: {
  tab: TabId;
  folder: string;
  /** The selected session's row, for the Session view's title; null when not listed yet. */
  row: SessionSummary | null;
  following: boolean;
  post: (m: ToExtension) => void;
}) {
  const now = useNow(tab === "session" && !!row, 15_000);
  const crumb = folder ? `${base(folder)} · ${TITLES[tab]}` : TITLES[tab];
  if (tab !== "session") {
    return (
      <header className="view-head">
        <div className="view-crumb">{crumb}</div>
        <h1>{TITLES[tab]}</h1>
        {tab === "all" && (
          <div className="view-sub"><button type="button" className="link-btn" onClick={() => post({ t: "rescan" })}>Re-read every log now</button></div>
        )}
      </header>
    );
  }
  const running = row ? isRunning(row.open, row.mtime, now) : false;
  const live = row ? isLive(row.mtime, running, now) : false;
  const pct = row && row.lastTok != null ? contextPct(row.lastTok, row.windowTok) : null;
  const title = row ? (row.lastPrompt || (row.prompts ? "(empty prompt)" : "(no prompt yet)")) : TITLES.session;
  return (
    <header className="view-head">
      <div className="view-crumb">{crumb}</div>
      <h1 title={title}>{title}</h1>
      {row && (
        <div className="view-sub">
          {row.costUsd != null ? `${fmtUsd(row.costUsd)} list price` : row.costNote ?? "no price"}
          {" · "}{pct != null ? `${Math.round(pct)}% context` : row.lastTok == null ? "no context yet" : "window unknown"}
          {" · "}{row.prompts} {row.prompts === 1 ? "prompt" : "prompts"}
          {" · "}{fmtAge(now - row.mtime)}
          {live && <> · <span className="live">{running ? "running" : "live"}</span></>}
        </div>
      )}
      <div className="view-sub">
        {following
          ? "Following the newest session. Pick another one in the sidebar to pin it."
          : <>Pinned to this session. <button type="button" className="link-btn" onClick={() => post({ t: "pickSession", folder, id: null })}>Follow the newest</button></>}
      </div>
    </header>
  );
}
