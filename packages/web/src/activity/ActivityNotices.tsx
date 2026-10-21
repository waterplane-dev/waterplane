import { CloudOff, Filter, X } from "lucide-react";
import { track } from "../usage";
import type { ActivityModel } from "./useActivityModel";
import { Button, Hint } from "../kit";

/** The lines above the list: the caller's shortlist, the headline, the offline and chatter notes. */
export function ActivityNotices({ m, online }: { m: ActivityModel; online: boolean }) {
  const { focus, setFocus, focusMissing, headline, headlineCut, setFilter, hideDebris, debrisCount } = m;
  return (
    <>
      {focus ? (
        <Hint className="act-focus">
          <Filter size={12} /> showing {focus.label}
          {focusMissing > 0
            ? ` — ${focusMissing} of them ${focusMissing === 1 ? "has" : "have"} moved on since and ${focusMissing === 1 ? "is" : "are"} under “all”`
            : ""}
          .
          <Button onClick={() => { track("action:activity.focus.clear"); setFocus(null); }}>
            <X size={14} /> show everything
          </Button>
        </Hint>
      ) : null}
      {headline ? (
        <Hint tone={online ? undefined : "warn"}>
          {headline}
          {headlineCut ? (
            <button className="link-btn" onClick={() => { track(`action:activity.headline.${headlineCut}`); setFilter(headlineCut); }}>
              show {headline.startsWith("1 ") ? "it" : "them"}
            </button>
          ) : null}
        </Hint>
      ) : null}
      {!online ? (
        <Hint tone="warn">
          <CloudOff size={12} /> no connection — rows the desktop owns are last known, and each one says when.
          Nothing here expires while the link is down.
        </Hint>
      ) : null}
      {hideDebris && debrisCount > 0 ? (
        <Hint>
          {debrisCount} one-word {debrisCount === 1 ? "reply is" : "replies are"} hidden — nothing was deleted, tap “hide chatter” again to see them.
        </Hint>
      ) : null}
    </>
  );
}
