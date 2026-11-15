/**
 * Agent efficiency series — a BARREL over `agentseries/`: per-day/week readings
 * off the per-session points (`series.ts`), a before/after with its
 * day-shuffle band (`compare.ts`), and the markers drawn beside them
 * (`markers.ts`). Pure; every reading degrades to `{ absent }`; nothing judges.
 */
export * from "./agentseries/types.js";
export * from "./agentseries/series.js";
export * from "./agentseries/compare.js";
export * from "./agentseries/markers.js";
export * from "./agentseries/setupcost.js";
export * from "./agentseries/pattern.js";
export * from "./agentseries/bymodel.js";
export * from "./agentseries/share.js";
export * from "./agentseries/shareparse.js";
