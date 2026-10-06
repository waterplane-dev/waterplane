/**
 * What a row CANNOT do, and why — as a sentence, never as a shape you can aim a
 * thumb at.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * This app's rule was already "a disabled action always carries a reason"
 * (`activityRows.ts`: `disabledReason`, not a boolean). The reason was carried
 * in a `title` attribute — which on the device this app is FOR is invisible:
 * there is no hover on a phone and no cursor to change shape. So what a person
 * actually saw was a control with the same border, the same icon, the same size
 * and the same label as the live one beside it, differing by `opacity: .4`.
 * Reported, exactly: *"Are these buttons clickable or not. I don't like
 * different shades of buttons to indicate that it should be clicked or not. It
 * looks not clickable but I think I can."*
 *
 * Opacity is a signal you have to already know how to read, and reading it
 * wrong costs a tap into nothing on the screen people open after something has
 * already gone wrong once.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * A verb that cannot run is NOT RENDERED AS A CONTROL. It becomes a line of
 * muted text saying what is unavailable and why. The reason survives — it is
 * now the only thing shown, and it is shown without being asked for.
 *
 * Verbs giving the SAME reason collapse into one line: three greyed buttons on
 * a launch that is no longer waiting were three copies of one fact about the
 * row, not three facts about its buttons.
 *
 * Do not restyle `.act-cant` back into something button-shaped, and do not add
 * a `disabled` branch to the button components that use this. The pair is the
 * point: pressable things look pressable, everything else is prose.
 */
import { CircleSlash } from "lucide-react";

/** One unavailable verb: what it was called, and why it is not on the row. */
export interface Cant {
  label: string;
  reason: string;
}

export function Unavailable({ cants, className }: { cants: readonly Cant[]; className?: string }) {
  if (!cants.length) return null;
  const byReason = new Map<string, string[]>();
  for (const c of cants) byReason.set(c.reason, [...(byReason.get(c.reason) ?? []), c.label]);
  return (
    <div className={`act-cants${className ? ` ${className}` : ""}`}>
      {[...byReason].map(([reason, labels]) => (
        <span key={reason} className="act-cant">
          <CircleSlash size={11} /> no {labels.join(", ")} — {reason}
        </span>
      ))}
    </div>
  );
}

/** The same fact where there is no room for a line of its own — inside a target
 *  row, beside the thing it is about. */
export function CantInline({ children }: { children: React.ReactNode }) {
  return <span className="act-cant act-cant-inline"><CircleSlash size={11} /> {children}</span>;
}
