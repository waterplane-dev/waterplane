import type { TabId, ToExtension } from "../src/protocol";

const NAMES: Partial<Record<TabId, string>> = { session: "Session", "always-on": "Always-on context", all: "All sessions" };

/**
 * The three always-on screens each name the other two: what every turn carries is read per repo
 * (Always-on context), per conversation (Session) and across the machine (All sessions). Navigation
 * only — it opens a tab, it measures nothing.
 */
export function TabLinks({ tabs, post }: { tabs: TabId[]; post: (m: ToExtension) => void }) {
  return (
    <div className="view-sub tab-links">
      See also:{" "}
      {tabs.map((tab, i) => (
        <span key={tab}>
          {i > 0 && " · "}
          <button type="button" className="link-btn" onClick={() => post({ t: "openPanel", tab })}>{NAMES[tab]}</button>
        </span>
      ))}
    </div>
  );
}
