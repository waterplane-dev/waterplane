import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDownToLine, type LucideIcon } from "lucide-react";
import { isStowed, stow, stowVersion, subscribeStow, trayAdd, trayEntries, unstow } from "./stow";
import { track } from "./usage";

/**
 * A strip that can be folded away and brought back — one wrapper for every card
 * that stands above the prompt bar (`stow.ts` says why it is a fold, never a
 * close).
 *
 * The strip draws `<StowButton />` wherever its head has room; folded, the
 * strip is not rendered at all and its chip stands in `<StowTray />`, which the
 * session header carries at the end of its status line — a line that is on
 * screen anyway, so a folded strip costs no height of its own.
 *
 * `stowKey` is the strip's CONTENT: what it shows that a person would want to
 * read again if it changed. Folding holds for that key only, so new content
 * comes back up unasked.
 */
const FoldCtx = createContext<(() => void) | null>(null);

export function Stowable({ slot, stowKey, label, detail, icon, children }: {
  slot: string;
  stowKey: string;
  /** The chip's words — the strip's own title, as drawn. */
  label: string;
  detail?: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  useSyncExternalStore(subscribeStow, stowVersion);
  const folded = isStowed(slot, stowKey);
  const fold = useCallback(() => { track(`action:stow.${slot}`); stow(slot, stowKey); }, [slot, stowKey]);
  useEffect(() => {
    if (!folded) return;
    return trayAdd({ slot, label, detail, icon, unfold: () => { track(`action:unstow.${slot}`); unstow(slot, stowKey); } });
  }, [folded, slot, stowKey, label, detail, icon]);
  if (folded) return null;
  return <FoldCtx.Provider value={fold}>{children}</FoldCtx.Provider>;
}

/** The fold control. Renders nothing outside a `Stowable`. */
export function StowButton({ className = "approve-esc" }: { className?: string }) {
  const fold = useContext(FoldCtx);
  if (!fold) return null;
  return (
    <button className={`${className} stow-btn`} onPointerDown={(e) => e.preventDefault()} onClick={fold}
      title="fold this away — it waits as a chip in the line under the session's title" aria-label="fold away">
      <ArrowDownToLine size={12} /> fold
    </button>
  );
}

/** Every folded strip's chip; a tap unfolds it. Nothing when nothing is folded. */
export function StowTray() {
  const rows = useSyncExternalStore(subscribeStow, trayEntries);
  if (!rows.length) return null;
  return (
    <>
      {rows.map((r) => {
        const Icon = r.icon;
        return (
          <button key={r.slot} className="row-sub stow-chip"
            onPointerDown={(e) => e.preventDefault()} onClick={r.unfold}
            title={`open ${r.label} again`}>
            <Icon size={11} /> {r.label}{r.detail ? <span className="mono"> · {r.detail}</span> : null}
          </button>
        );
      })}
    </>
  );
}
