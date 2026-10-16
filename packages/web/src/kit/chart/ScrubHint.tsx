/**
 * `SCRUB_HINT` as drawn: the words a chart's readout line holds until a finger
 * is on the chart, MUTED (`.scrub-hint`).
 *
 * The hint sits in the readout's slot, and every readout line is set in `--fg`
 * so a picked value reads at the weight of the data. Drawn as plain text, the
 * instruction came out brighter than the chart's own lines and captions — the
 * one sentence on the screen that is not a reading looked like the loudest
 * reading. So the slot keeps its weight for the value and the hint carries its
 * own colour, one component for every chart that draws it.
 */
import { SCRUB_HINT } from "./chartWords.ts";

export function ScrubHint() {
  return <span className="scrub-hint">{SCRUB_HINT}</span>;
}
