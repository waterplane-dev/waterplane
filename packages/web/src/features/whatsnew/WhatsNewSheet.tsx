/**
 * "What's new": one release's new things, each with its state on this phone
 * and desktop and ONE door to the exact place. Not a changelog and not a second
 * Automation list — it links to them. Nothing here changes anything; every
 * verb opens a screen.
 */
import { useEffect, useState } from "react";
import {
  ArrowDownUp, Bell, BellRing, CalendarClock, CircleAlert, Flame, HardDrive, Hammer, Smartphone, Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useCore } from "../../sdk";
import { Sheet, Button, Explain, FilterChip, RowTitle, RowSub } from "../../kit";
import { SHEET } from "../../sheetNames";
import { openDoor, markSeen } from "./actions";
import { fallbackNote, pickRelease, RELEASES, rowView, type NewThing } from "./logic";
import { useDesktopVersion, useHubFacts } from "./store";

const ICON = 16;

/** Each row wears its own feature's icon. */
const ICONS: Record<NewThing["icon"], LucideIcon> = {
  bell: Bell, push: BellRing, failed: CircleAlert, automation: CalendarClock, buildclock: Hammer,
  downloads: HardDrive, burn: Flame, taps: Smartphone, sync: ArrowDownUp,
};

/** The sheet keeps the current release and the one before it. */
const SHOWN = RELEASES.slice(0, 2);

export function WhatsNewSheet() {
  const c = useCore();
  const desktop = useDesktopVersion();
  const [pick, setPick] = useState<string | null>(null);
  const rel = (pick && SHOWN.find((r) => r.version === pick)) || pickRelease(SHOWN, desktop);
  const { facts, feed } = useHubFacts();
  // Opening the sheet by any door is being told: the launcher row does not come back for this version.
  useEffect(() => { if (desktop) markSeen(desktop); }, [desktop]);

  const note = pick ? null : fallbackNote(SHOWN, desktop);
  return (
    <Sheet title={rel && !note ? `${SHEET.whatsnew} · ${rel.version}` : SHEET.whatsnew} icon={<Sparkles size={18} />} onClose={() => c.nav.close("whatsnew")}>
      <div className="sheet-scroll">
        {SHOWN.length > 1 && (
          <div className="fchips wrap">
            {SHOWN.map((r) => (
              <FilterChip key={r.version} on={rel?.version === r.version} clears={false} onClick={() => setPick(r.version)}>
                {r.version}
              </FilterChip>
            ))}
          </div>
        )}
        {note && <RowSub as="div">{note}</RowSub>}
        {rel?.things.map((t) => {
          const v = rowView(t, facts);
          const Icon = ICONS[t.icon];
          return (
            <div key={t.id} className="wn-row">
              <div className="wn-head">
                <Icon size={ICON} />
                <RowTitle>{t.title}</RowTitle>
                {v.text && <span className="wn-state">{v.text}</span>}
              </div>
              <RowSub as="div">{t.line}</RowSub>
              {v.door && v.verb && (
                <div className="wn-acts"><Button onClick={() => openDoor(v.door!, feed)}>{v.verb}</Button></div>
              )}
            </div>
          );
        })}
        <Explain of="where this comes from" label="Where this comes from">
          The rows are written by hand for each release. Each state line is read from this phone and
          the desktop as they are now, and is left out while it has not been read yet. Every verb opens
          a screen; nothing here changes a setting. To find this again: Updates › what's new, or search
          Settings for "what's new".
        </Explain>
      </div>
    </Sheet>
  );
}
