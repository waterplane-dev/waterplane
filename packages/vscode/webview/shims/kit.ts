/**
 * The webview's `@waterplane/kit`: the chart barrel the token-stats cards are drawn with, plus the
 * five non-chart pieces those cards import from the full kit — `until` (pure, `web/src/format.ts`),
 * `Button` (the one `.key` button, pure markup), `Tag` (the status chip, pure markup), `RowTitle`/`RowSub` (the row's text parts, pure markup) and
 * `Explain` (a `?` that opens its words in place). The full kit also carries `Sheet`,
 * `useRemoteResource`, the prompt composer and the rest, which reach `storage.ts`, `api.ts` and the
 * socket — none of which exist in a VS Code webview — so only what is listed here is lent.
 */
export * from "../../../web/src/kit/chart/index.ts";
export { Button } from "../../../web/src/kit/Button.tsx";
export { Tag } from "../../../web/src/kit/Tag.tsx";
export { RowTitle, RowSub } from "../../../web/src/kit/Row.tsx";
export { ago, until } from "../../../web/src/format.ts";
export { Explain } from "../../../web/src/Explain.tsx";
// The phone's read hook itself: its two socket-facing imports (`./api`, `./link`) are swapped for
// this webview's by `esbuild.mjs`, so a card's read here is the phone's read, answered by the desktop
// through the extension host (`shims/sdk.ts`).
export { useRemoteResource, type RemoteResource, type ResourceState } from "../../../web/src/useRemoteResource.ts";
export { Empty } from "../../../web/src/Empty.tsx";
export { SheetHead } from "../../../web/src/Sheet.tsx";
