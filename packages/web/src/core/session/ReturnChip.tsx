/**
 * "back to <sheet>" — the one-tap return a sheet registered when it sent the person to a shell
 * (`launch.focusShell`'s `back`; rules in `core/launch/shellTab.ts`). Drawn on THAT shell's screen
 * only, under the header, and it stays there across trips: the sheet's shell button and this chip
 * are the two halves of one toggle. The × drops it and says how it comes back.
 */
import type { ReactNode } from "react";
import { Undo2, X } from "lucide-react";
import { useStore } from "../../sdk/store.ts";
import { showToast } from "../../toast";
import { track } from "../../usage";
import { returnShownOn, returnWords } from "../launch/shellTab.ts";
import { dropReturn, returnTo } from "../launch/shellReturn.ts";

export function ReturnChip({ activeId }: { activeId: string }): ReactNode {
  const r = useStore(returnTo);
  if (!r || !returnShownOn(r, activeId)) return null;
  const words = returnWords(r.to.label);
  return (
    <div className="filter-bar return-bar">
      <button className="return-go" title={`open the ${r.to.label} again — this shell stays open`}
        onClick={() => { track("action:shell.return"); r.to.open(); }}>
        <Undo2 size={14} /> <span className="filter-bar-txt">{words}</span>
      </button>
      <button className="filter-bar-clear" aria-label={`hide ${words}`} title={`hide ${words}`}
        onClick={() => { dropReturn(); showToast(`Hidden. The shell button on the ${r.to.label} brings it back.`); }}>
        <X size={13} />
      </button>
    </div>
  );
}
