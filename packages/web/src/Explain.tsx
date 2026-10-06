/**
 * An explanation on demand: a `?` that opens its sentence in place.
 *
 * `HintChip` answers "what IS this?" from the hint catalog, one card per
 * subject. This is for the sentences that are about THIS screen's state
 * (*auto is on: these start when…*, what a bulk verb costs) — dynamic words
 * the catalog cannot hold. They used to be drawn always, and a one-row
 * backlog opened on half a screen of prose before its first row. The words
 * are unchanged; only their default is closed.
 *
 * Not for a REFUSAL: a verb that is missing says why in text, always
 * (`Unavailable.tsx`). This is for what a working control means.
 */
import { useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";

export function Explain({ of, label, children }: {
  /** What it explains, for the screen reader. */
  of: string;
  /** Optional short words beside the `?`, for when the icon alone would say nothing. */
  label?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`hint-chip explain-chip${open ? " open" : ""}`}
        aria-expanded={open} aria-label={`what ${of} means`}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        <CircleHelp size={13} aria-hidden />{label ? <span className="explain-label">{label}</span> : null}
      </button>
      {open && <div className="explain-body">{children}</div>}
    </>
  );
}
