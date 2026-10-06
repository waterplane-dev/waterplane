import { ZoomIn, ZoomOut } from "lucide-react";

/**
 * The smaller/bigger text pair — the terminal corner, the scrollback sheet and
 * the git review each draw it, and they were three hand-rolled copies of one
 * rule.
 *
 * The rule: the END of the ladder drops the button and says the word in its
 * place (`Unavailable.tsx` — never a dimmed one), because a control that
 * disappears without saying so is the thing that rule exists to stop. The
 * other button is the way back, and the end word says that too.
 *
 * A FRAGMENT, not a group: the terminal corner puts other buttons in the same
 * row, and the wrapper's placement (anchored right, fixed, floating) is each
 * caller's own layout question.
 */
export function ZoomPair({ smaller, bigger, onZoom, what = "", subject = "the text", smallerHint = "", biggerHint = "", endClassName = "row-sub", iconSize = 14 }: {
  /** The next step each way, or null at that end of the ladder. */
  smaller: number | null;
  bigger: number | null;
  onZoom(v: number): void;
  /** Qualifier in the labels: "console" → "smaller console text". */
  what?: string;
  /** Who the end word is about: "the console is as small as it goes". */
  subject?: string;
  /** Tail of each button's title, after "smaller text". */
  smallerHint?: string;
  biggerHint?: string;
  endClassName?: string;
  iconSize?: number;
}) {
  const end = smaller == null ? "smallest" : bigger == null ? "biggest" : "";
  const txt = what ? `${what} text` : "text";
  return (
    <>
      {smaller != null && (
        <button className="key" aria-label={`smaller ${txt}`}
          title={`smaller ${txt}${smallerHint}`}
          onClick={() => onZoom(smaller)}><ZoomOut size={iconSize} /></button>
      )}
      {end && (
        <span className={endClassName} aria-live="polite"
          title={`${subject} is as ${end === "smallest" ? "small" : "big"} as it goes — the other button is the way back`}>
          {end}
        </span>
      )}
      {bigger != null && (
        <button className="key" aria-label={`bigger ${txt}`}
          title={`bigger ${txt}${biggerHint}`}
          onClick={() => onZoom(bigger)}><ZoomIn size={iconSize} /></button>
      )}
    </>
  );
}
