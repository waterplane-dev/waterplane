/**
 * The webview's `@waterplane/kit`: the chart barrel the token-stats cards are drawn with, plus the
 * two non-chart pieces those cards import from the full kit — `until` (pure, `web/src/format.ts`)
 * and `Explain` (a `?` that opens its words in place). The full kit also carries `Sheet`,
 * `useRemoteResource`, the prompt composer and the rest, which reach `storage.ts`, `api.ts` and the
 * socket — none of which exist in a VS Code webview — so only what is listed here is lent.
 */
export * from "../../../web/src/kit/chart/index.ts";
export { until } from "../../../web/src/format.ts";
export { Explain } from "../../../web/src/Explain.tsx";
// Type only — `useRemoteResource` itself stays out (it reaches the socket); the cards name its states.
export type { ResourceState } from "../../../web/src/useRemoteResource.ts";
