import { useSyncExternalStore } from "react";
import { Copy, TriangleAlert, X } from "lucide-react";
import { Button } from "../../kit/Button";
import { dismissLoss, getLosses, lossSentence, subscribeLosses, type LossNotice } from "../../lossNotice";
import { lsGet } from "../../storage";
import { showToast } from "../../toast";

async function copyKept(n: LossNotice): Promise<void> {
  const text = n.keptSlot ? lsGet(n.keptSlot) ?? "" : "";
  if (!text) { showToast("nothing kept aside to copy"); return; }
  try { await navigator.clipboard.writeText(text); showToast("kept text copied"); }
  catch { showToast("could not copy it from here"); }
}

/**
 * **Typed words this phone could not keep, as a line on the composer.**
 * Stays until dismissed (a toast is gone before anyone looks, and these words
 * are the last copy). One line per store; a store that works again clears its
 * own line. `lossNotice.ts` holds the facts, this only draws them.
 */
export function LossLine() {
  const notices = useSyncExternalStore(subscribeLosses, getLosses, getLosses);
  if (!notices.length) return null;
  return (
    <>
      {notices.map((n) => (
        <div key={n.id} className="compose-aim compose-loss" role="status">
          <span className="compose-aim-what"><TriangleAlert size={12} /> {lossSentence(n)}</span>
          {n.kind === "unreadable" && n.keptSlot && (
            <Button onClick={() => { void copyKept(n); }}><Copy size={12} /> Copy kept text</Button>
          )}
          <Button onClick={() => dismissLoss(n.id)} aria-label="Dismiss"><X size={12} /> Dismiss</Button>
        </div>
      ))}
    </>
  );
}
