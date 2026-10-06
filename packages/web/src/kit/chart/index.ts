/** The chart pieces the token screens share: geometry (`statsPlot`), the one token-composition strip
 *  and its validated palette, and the measured-width hook. Re-exported by `kit/index.ts`. Core files
 *  import the module directly (`./kit/chart/TokenComposition`), never this barrel. */
export * from "./statsPlot.ts";
export { KindBar, CacheVerdict, SLOT, SERIES, MODEL_SLOT } from "./TokenComposition";
export { useBoxWidth } from "./useBoxWidth.ts";
