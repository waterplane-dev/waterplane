/**
 * Setup & health — the frame (whole-app journey spec D7a; the bodies and the place: `setupHealth.ts`).
 * One head, the two scope tabs, This repo's section row, then the body the place names. Every old
 * door (`setup`, `repohealth`, `setupcheck`, `skills`) and the `health` id render this, each on its
 * own landing; a tab or section tap changes the place, never the overlay, so Back leaves the screen
 * from any section (T17: Back lands Home).
 */
import type { ReactNode } from "react";
import { Activity } from "lucide-react";
import { SheetHead } from "./Sheet";
import { FilterChip } from "./kit/FilterChip";
import { Hint } from "./kit";
import { useStore } from "./sdk";
import type { Overlay } from "./routing";
import { HEALTH_SECTION, TAB, TITLE } from "./sheetNames";
import { REPO_SECTIONS, healthBody, healthPlace, leaveHealth, ownerOf, parkedPlace, placeFor, switchHealth, type HealthPlace } from "./setupHealth";

export function SetupHealthSheet({ self, landing, onClose }: {
  /** The overlay this frame is drawn for (its own id, or one of the merged ids). */
  self: Overlay;
  /** Where a door that set no place lands. */
  landing: HealthPlace;
  /** The opening overlay's own close (its stores cleared, its drill steps honoured). */
  onClose: () => void;
}) {
  const stored = useStore(healthPlace);
  const place = placeFor(stored, self, landing, parkedPlace(self));
  const body = healthBody(ownerOf(place));
  const go = (to: HealthPlace) => switchHealth(self, place, to);
  // onClose first: the frame's arrow reads `healthPlace` to decide step-back or close, and leaving clears it.
  const close = () => { onClose(); leaveHealth(self); };
  return (
    <div className="sheet health-sheet">
      <SheetHead title={TITLE.health} icon={<Activity size={16} />} onClose={close} />
      <div className="fchips" role="group" aria-label={TITLE.health} style={{ padding: "0 calc(var(--gutter) - 3px)", flexShrink: 0 }}>
        {(["repo", "desktop"] as const).map((t) => (
          <FilterChip key={t} on={place.tab === t} clears={false}
            onClick={() => go({ tab: t, section: t === "repo" ? (place.tab === "repo" ? place.section : "checks") : "checks" })}>
            {TAB.health[t]}
          </FilterChip>
        ))}
      </div>
      {place.tab === "repo" && (
        <div className="fchips health-sections" role="group" aria-label={TAB.health.repo} style={{ padding: "0 calc(var(--gutter) - 3px)", flexShrink: 0 }}>
          {REPO_SECTIONS.map((s) => (
            <FilterChip key={s} on={place.section === s} clears={false} onClick={() => go({ tab: "repo", section: s })}>
              {HEALTH_SECTION[s]}
            </FilterChip>
          ))}
        </div>
      )}
      {body ? body.render(place) : <div className="sheet-scroll"><Hint>This part of {TITLE.health} is not in this build.</Hint></div>}
    </div>
  );
}

/**
 * A body's own frame when it is drawn inside Setup & health: its content and its footer, no head
 * (the frame has the one head). Outside the frame the body keeps its `Sheet`.
 */
export function EmbeddedBody({ footer, children }: { footer?: ReactNode; children: ReactNode }) {
  return <>{children}{footer ? <div className="sheet-actions">{footer}</div> : null}</>;
}
