import { Activity } from "lucide-react";
import { SheetHead } from "./Sheet";
import { FilterChip } from "./kit/FilterChip";
import { NetHealthSheet, type NetHealthFocus } from "./NetHealthSheet";
import { SpeedTestSheet } from "./SpeedTestSheet";
import { connectionTab } from "./connTest";
import { useStore } from "./sdk";
import { TAB, TITLE } from "./sheetNames";
import type { ConnectionTab } from "./routing";

const TABS: readonly ConnectionTab[] = ["health", "speed"];

type HealthProps = Omit<Parameters<typeof NetHealthSheet>[0], "embedded">;

/**
 * Connection: ONE screen for how the phone reaches the desktop (journey spec D7b). It replaces two
 * sibling sheets ("Connection health" and "Connection & speed test", each with a button to the other)
 * with two tabs: `Health` (the strip's readings, the stuck sends, the route, the data moved) and
 * `Speed test` (the connection test and the throughput test). Both bodies are the old sheets drawn
 * without their own frame, so nothing they say or do changed. A door picks the tab through
 * `connectionTab` (`connTest.ts`) before it opens the screen; the strip's focus still scrolls to its
 * section on the Health tab.
 */
export function ConnectionSheet({ onClose, ...health }: HealthProps & { focus?: NetHealthFocus }) {
  const tab = useStore(connectionTab);
  return (
    <div className="sheet">
      <SheetHead title={TITLE.connection} icon={<Activity size={16} />} onClose={onClose} />
      <div className="fchips" aria-label="Connection" style={{ padding: "0 calc(var(--gutter) - 3px)", flexShrink: 0 }}>
        {TABS.map((t) => (
          <FilterChip key={t} on={tab === t} clears={false} onClick={() => connectionTab.set(t)}>{TAB.connection[t]}</FilterChip>
        ))}
      </div>
      {tab === "health"
        ? <NetHealthSheet {...health} onClose={onClose} embedded />
        : <SpeedTestSheet onClose={onClose} embedded />}
    </div>
  );
}
