/**
 * The frame every full-screen sheet draws, written once.
 *
 * Thirty-three files were hand-rolling the same four lines — `div.sheet`, a
 * `div.sheet-head`, a back button holding a `ChevronLeft`, and a `span.brand`
 * with the title in it. Forty-six copies in all, because several sheets have
 * more than one head. That is not merely repetition: it is thirty-three
 * independent chances to get the CLOSE affordance subtly wrong on the one
 * screen where a phone has no other way out, and the reason `.sheet-head`'s CSS
 * carries three separate comments about buttons pushed off the right edge is
 * that the markup they were written against is copied, not shared.
 *
 * The layout rules stay in `styles.css` where they are — this owns the
 * structure, not the appearance. Everything the head can hold is still a slot:
 * `icon` before the title, `actions` after the spacer, and `head` for the rare
 * sheet that needs a whole second row (a breadcrumb, a filter strip).
 */
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

/** Matches the size the sheets were passing by hand. */
const BACK_ICON = 24;

export interface SheetProps {
  /** Shown in `.brand`. A string in almost every case; a node where the title
   *  itself carries markup (a repo name that must ellipsize on its own). */
  title: ReactNode;
  /** Drawn before the title, inside `.brand`, so it rides with the text when
   *  the head wraps. */
  icon?: ReactNode;
  /** Back/close. Every sheet has one — on a phone it is often the only way out,
   *  which is why it is required rather than optional. */
  onClose: () => void;
  /**
   * Head controls, after the flexible spacer. They land in the trailing slot
   * `.sheet-head`'s wrap rule reserves, so a long title pushes them onto a
   * second row instead of off the screen.
   */
  actions?: ReactNode;
  /** An extra row under the head — breadcrumbs, filters, a tab strip. */
  head?: ReactNode;
  /** Pinned action bar at the bottom (`.sheet-actions`). */
  footer?: ReactNode;
  /** Extra classes on the root, for the few sheets with their own modifier. */
  className?: string;
  /**
   * The body FILLS what is left under the head, edge to edge, and never scrolls (`.sheet-full-body`:
   * no padding, `overflow: hidden`, a positioned box with a definite height) — for a canvas that
   * sizes itself to its box, such as a live video view. The bottom safe area is padded so nothing
   * sits under the gesture bar. The head (and its back arrow) stays: Back closes it like any sheet.
   */
  full?: boolean;
  children?: ReactNode;
}

export function Sheet({ title, icon, onClose, actions, head, footer, className, full, children }: SheetProps) {
  const root = ["sheet", full ? "sheet-full" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={root}>
      <SheetHead title={title} icon={icon} onClose={onClose}>{actions}</SheetHead>
      {head}
      {full ? <div className="sheet-full-body">{children}</div> : children}
      {footer ? <div className="sheet-actions">{footer}</div> : null}
    </div>
  );
}

/**
 * Just the head.
 *
 * Existing sheets keep their own `div.sheet` — several have a second head, a
 * scroll container of their own, or a footer that is not `.sheet-actions` — so
 * the part worth sharing is extracted on its own rather than by rewriting
 * thirty-three render trees to fit one frame. `Sheet` is built from this, so a
 * new sheet gets both and the two can never drift.
 *
 * `children` are the trailing controls. They are preceded by the flexible
 * spacer only when there are some, which is what keeps a title-only head from
 * growing an invisible stretch element.
 */
export function SheetHead({ title, icon, onClose, brandClass, children }: {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  /** Extra classes on `.brand` — `mono` for the heads whose title is a PATH. */
  brandClass?: string;
  children?: ReactNode;
}) {
  return (
    <div className="sheet-head">
      <button className="back" onClick={onClose} aria-label="back"><ChevronLeft size={BACK_ICON} /></button>
      <span className={brandClass ? `brand ${brandClass}` : "brand"}>{icon}{icon ? " " : null}{title}</span>
      {children ? <><span className="spacer" />{children}</> : null}
    </div>
  );
}
