/**
 * The visible half of the hint system: "what IS this number?", as a control.
 *
 * `hints.ts` already answers that question for every button in the app — a
 * long press opens the card. Long press is invisible, though, and that is a
 * fair trade on a toolbar (an icon you cannot guess is an icon you will
 * probe) and a bad one on a screen of statistics, where the reader has no
 * reason to suspect there is anything to hold down. A percentile, a re-touch
 * rate and an escape-hatch density are terms, not glyphs: the question they
 * raise is what the words MEAN, and nothing on the row says an answer exists.
 *
 * So this is the `?` chip `hints.ts`'s `showHint` was written for. It is the
 * same card, from the same catalog, with the same text — one explanation per
 * subject, reachable two ways, never a second copy of the words.
 *
 * `data-hint` is on the button as well as the handler, for two reasons: the
 * long press keeps working on the chip itself, and `scripts/e2e-hints.mjs`
 * scans that attribute to hold every id in the UI against the catalog. A chip
 * whose id has no definition renders NOTHING rather than a dead tap — the
 * repo's rule that a thing which cannot act is absent, never dimmed — and
 * `repoHealthHints.test.mjs` fails if a series the tool emits has no entry, so
 * "absent" cannot quietly become "most of them".
 */
import { CircleHelp } from "lucide-react";
import { HINTS, showHint } from "./hints";
import { track } from "./usage";

export function HintChip({ id, of }: {
  /** A key in the hint catalog. */
  id: string;
  /** What it explains, for the screen reader — the chip itself has no text. */
  of: string;
}) {
  if (!HINTS[id]) return null;
  return (
    <button
      type="button"
      className="hint-chip"
      data-hint={id}
      aria-label={`what ${of} means`}
      onClick={(e) => {
        // The row under a chip is often itself tappable (a tile with a send
        // button, a chart that scrubs on drag). Asking what something is must
        // not also do it.
        e.stopPropagation();
        track("action:repohealth.help");
        showHint(id);
      }}
    >
      <CircleHelp size={13} aria-hidden />
    </button>
  );
}
