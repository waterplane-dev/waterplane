/**
 * Toolbar item `limit`: this session's auto-continue override, tap to cycle
 * inherit → on → off. Moved verbatim out of App's `renderToolbarItem`; renders
 * nothing where App's arm returned null (no limit state on the session).
 */
import { Hourglass } from "lucide-react";
import type { SessionInfo } from "@waterplane/shared";
import { hhmm } from "../../format";
import { useLimitAuto } from "./store";
import { cycleSessionOverride } from "./actions";
import { nextOverride, overrideSource } from "./logic";

const ICON = 16;

export function LimitToggle({ active, label, dismiss }: { active: SessionInfo | null; label: boolean; dismiss: () => void }) {
  const limitAuto = useLimitAuto();
  if (!active?.limit) return null;
  const lim = active.limit;
  const next = nextOverride(lim.autoContinueOverride);
  const state = lim.autoContinue ? "on" : "off";
  const src = overrideSource(lim.autoContinueOverride, limitAuto);
  return (
    <button
      data-hint="toolbar:limit"
      className={`key ${lim.blocked ? "limit" : lim.autoContinue ? "active" : ""}`}
      title={`auto-continue after a usage-limit reset: ${state} · ${src}${lim.blocked ? `\ncurrently limit-blocked${lim.nextAttemptAt ? ` — continue fires ~${hhmm(lim.nextAttemptAt)}` : ""}` : ""}\ntap to cycle: inherit → on → off`}
      onClick={() => { dismiss(); cycleSessionOverride(active.id, next); }}
    >
      <Hourglass size={ICON} />{label && <> {lim.blocked ? (lim.nextAttemptAt ? `limit · ${hhmm(lim.nextAttemptAt)}` : "limit") : `auto-cont ${state}${lim.autoContinueOverride != null ? "*" : ""}`}</>}
    </button>
  );
}
