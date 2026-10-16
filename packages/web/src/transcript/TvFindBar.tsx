import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { track } from "../usage";
import type { TvModel } from "./useTranscriptView";

  /**
   * The reader's controls are TOOLBAR actions now (`toolbar.ts`), so what is
   * left here is only what a button cannot be: the find FIELD once it is open,
   * and its hit counter, both derived from the rendered document. The strip
   * draws in flow at the top of the reader and only while a find is open, so a
   * reader with nothing being searched spends no row at all. The "n new" jump
   * that used to sit here is gone: the reader already LANDS on the
   * "new since you left" divider, so the button only spent a row repeating it.
   */
export function TvFindBar({ m }: { m: TvModel }) {
  const { q, setQ, findOpen, setFindOpen, hitIdx, setHitIdx, hitCount, jump } = m;
  const findOn = findOpen || !!q;
  if (!findOn) return null;
  return (
    /* `tr-bar-find`: an OPEN find field, with a query filtering what is on
       screen — typing room keeps it, since hiding a live search box whose query
       is still narrowing the document would be a screen lying about what it is
       showing. */
    <div className="tr-bar tr-bar-find">
      <div className="tr-find">
        <Search size={13} />
        <input
          autoFocus
          value={q}
          placeholder="find in conversation"
          onChange={(e) => { if (!q && e.target.value) track("action:read.find"); setQ(e.target.value); setHitIdx(0); }}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
        <button className="key" title="close find" onClick={() => { setQ(""); setFindOpen(false); }}><X size={13} /></button>
      </div>
      {q && (
        <span className="tr-hits">
          <button className="key" onClick={() => jump(-1)} disabled={!hitCount}><ChevronUp size={13} /></button>
          <span className="row-sub">{hitCount ? `${hitIdx + 1}/${hitCount}` : "0"}</span>
          <button className="key" onClick={() => jump(1)} disabled={!hitCount}><ChevronDown size={13} /></button>
        </span>
      )}
    </div>
  );
}
