/** The chart pieces the token screens share: geometry (`statsPlot`), the one token-composition strip
 *  and its validated palette, the measured-width hook and the one scrub hint (its words, and
 *  `ScrubHint`, those words as drawn: muted in the readout's slot). Re-exported by
 *  `kit/index.ts`. Core files import the module directly (`./kit/chart/TokenComposition`), never
 *  this barrel. */
export * from "./statsPlot.ts";
export { KindBar, CacheVerdict, SLOT, SERIES, MODEL_SLOT } from "./TokenComposition";
export { useBoxWidth } from "./useBoxWidth.ts";
export { SCRUB_HINT } from "./chartWords.ts";
export { ScrubHint } from "./ScrubHint";
