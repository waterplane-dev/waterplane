import { ChevronDown, ChevronUp, Search, Sparkles, X } from "lucide-react";
import { track } from "../usage";
import type { TvModel } from "./useTranscriptView";

  /**
   * The reader's controls are TOOLBAR actions now (`toolbar.ts`), so what is
   * left here is only what a button cannot be: the find FIELD once it is open,
   * its hit counter, and the unread jump — all of them derived from the
   * rendered document. The strip draws in flow at the top of the reader and
   * only when it has something to say, so a reader with nothing being searched
   * and nothing unread spends no row at all.
   */
export function TvFindBar({ m }: { m: TvModel }) {
  const { q, setQ, findOpen, setFindOpen, unread, hitIdx, setHitIdx, hitCount, jump, goNew } = m;
  const findOn = findOpen || !!q;
  if (!(findOn || (unread > 0 && !q))) return null;
  return (
    /* `tr-bar-find` marks the one state of this strip that is not a readout:
       an OPEN find field, with a query filtering what is on screen. Typing room
       hides the rest of it (the unread jump), and hiding a live search box
       whose query is still narrowing the document would be a screen lying about
       what it is showing. */
    <div className={`tr-bar${findOn ? " tr-bar-find" : ""}`}>
      {findOn && (
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
      )}
      {q && (
        <span className="tr-hits">
          <button className="key" onClick={() => jump(-1)} disabled={!hitCount}><ChevronUp size={13} /></button>
          <span className="row-sub">{hitCount ? `${hitIdx + 1}/${hitCount}` : "0"}</span>
          <button className="key" onClick={() => jump(1)} disabled={!hitCount}><ChevronDown size={13} /></button>
        </span>
      )}
      {unread > 0 && !q && (
        <button className="key tr-newbtn" title="jump to the first turn you haven't seen" onClick={goNew}>
          <Sparkles size={13} /> {unread} new
        </button>
      )}
    </div>
  );
}
