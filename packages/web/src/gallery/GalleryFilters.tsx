import { Fragment } from "react";
import { Loader2 } from "lucide-react";
import { FilterChip } from "../kit/FilterChip";
import { KINDS, SINCE, type Scope } from "./galleryTypes";
import type { GalleryModel } from "./useGallery";

/** WHERE to look (the app's segmented control, one tab lit) and WHAT to keep (slim toggles). */
export function GalleryFilters({ m }: { m: GalleryModel }) {
  const { scope, loading, singleRepo, changeScope, kind, setKind, since, setSince, newSecs, onNewCut, setOnNewCut } = m;
  const { initialNew } = m.props;
  /** A tab. `busy` keeps the tapped tab lit (and spinning) while its listing is on the wire,
   *  instead of releasing back to plain. */
  const tab = (s: Scope, label: string) => (
    <button className={`seg${scope === s ? " on" : ""}${scope === s && loading ? " busy" : ""}`}
      aria-pressed={scope === s} onClick={() => changeScope(s)}>
      {label}{scope === s && loading ? <Loader2 size={13} className="spin" /> : null}
    </button>
  );
  const toggle = (on: boolean, label: string, onTap: () => void, title?: string) => (
    <FilterChip on={on} busy={on && loading} title={title} onClick={onTap}>{label}</FilterChip>
  );
  const clearTime = () => { setSince(undefined); setOnNewCut(false); };
  return (
    <>
      {/* WHERE to look: four places, exactly one of them on. Opened from the overview there is
          only "all repos", and a one-tab control says nothing the search box does not. */}
      {singleRepo && (
        <div className="segmented gallery-scope">
          {tab("inbox", "inbox")}
          {tab("outbox", "outbox")}
          {tab("repo", "this repo")}
          {tab("all", "all repos")}
        </div>
      )}

      {/* WHAT to keep: toggles, none lit = everything. No "all" chip, and no second one for
          time: two chips spelled "all" in one row answered two different questions. */}
      <div className="fchips gallery-filters">
        {KINDS.map((k) => (
          <Fragment key={k.value}>{toggle(kind === k.value, k.label, () => setKind(kind === k.value ? "all" : k.value))}</Fragment>
        ))}
        {scope !== "inbox" && <>
          <span className="fchips-gap" aria-hidden />
          {/* The badge's own cut, named. It exists only while it is the answer
              to a question somebody asked by tapping a number — every other
              chip clears it, and reopening without a badge never shows it. */}
          {newSecs !== undefined && toggle(onNewCut, `${initialNew!.count} new`,
            () => { if (onNewCut) clearTime(); else { setSince(newSecs); setOnNewCut(true); } },
            `the ${initialNew!.count} file${initialNew!.count > 1 ? "s" : ""} added since you last opened this outbox — the badge you tapped`)}
          {SINCE.map((s) => (
            <Fragment key={s.label}>{toggle(!onNewCut && since === s.secs, s.label,
              () => { if (!onNewCut && since === s.secs) clearTime(); else { setSince(s.secs); setOnNewCut(false); } },
              `only files from the last ${s.long}`)}</Fragment>
          ))}
        </>}
      </div>
    </>
  );
}
