/**
 * The line under a chart before a finger is on it — ONE wording for every chart that answers a
 * drag with a text line beneath it (the context sheet, the limit windows, the repo-health tiles).
 *
 * It was spelled three ways on screens read one after another ("touch the chart for the reading
 * under your finger", "drag across the curve for a day's reading", "drag across the chart to read
 * a value"), which reads as three gestures for one. Pure and import-free, so the repo-health words
 * re-export it under `node --test` and an extension reaches it through `@waterplane/kit`.
 */
export const SCRUB_HINT = "drag across the chart to read a value";
