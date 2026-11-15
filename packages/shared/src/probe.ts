/**
 * The lookup probe (R-metrics-071) — a BARREL over `probe/`: the pool file and the seeded,
 * interleaved draw (`pool.ts`), the leak check (`leak.ts`), the analysis with its correctness gate
 * and repeat-noise band (`analyze.ts`), the estimate shown before the tap and the source words
 * (`estimate.ts`). DTOs: `wire/probe.ts`. Pure; a figure it cannot back is absent with a sentence.
 */
export * from "./probe/pool.js";
export * from "./probe/leak.js";
export * from "./probe/analyze.js";
export * from "./probe/estimate.js";
