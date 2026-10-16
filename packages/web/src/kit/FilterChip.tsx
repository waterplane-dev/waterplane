import type { ReactNode } from "react";
import { Loader2, X } from "lucide-react";

/**
 * A filter toggle: a 30 px pill inside a 44 px touch box (ux §5's fingertip, without the fat
 * button look). Lit is TINTED, never the solid accent fill — that stays for a sheet's one primary
 * verb, and a filter row with three solid fills read as three primary verbs.
 *
 * `clears` (default true): a lit chip carries a ×, because a tap on it takes the cut away (the
 * kit's `toggleChip` rule). Pass false for a row where one chip is always lit (a choice, not a
 * cut) — there a × would promise a "none" that does not exist.
 */
export function FilterChip({ on, busy = false, clears = true, title, onClick, children }: {
  on: boolean;
  /** This chip's listing is on the wire: it keeps its light and spins instead of the ×. */
  busy?: boolean;
  clears?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={`fchip${on ? " on" : ""}`} aria-pressed={on} title={title} onClick={onClick}>
      <span className="fchip-pill">
        {children}
        {on && busy ? <Loader2 size={12} className="spin fchip-x" /> : on && clears ? <X size={13} className="fchip-x" aria-hidden /> : null}
      </span>
    </button>
  );
}
