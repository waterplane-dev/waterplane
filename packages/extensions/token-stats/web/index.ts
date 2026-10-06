/**
 * The token statistics extension's web half: the `tokens` sheet. Imports only `@waterplane/sdk`, `@waterplane/kit`,
 * `@waterplane/shared`, react, lucide-react and its own folder (docs/notes/token-stats-architecture.md).
 *
 * The sheet keeps its CORE id `tokens`, persisted — an adopted core sheet (`webshape`'s
 * ADOPTED_CORE_SHEETS): `#o=tokens` deep links, reload restore and the four doors that open it by
 * that id keep working, and its usage counters (`overlay:tokens`) stay one series.
 */
import { createElement } from "react";
import type { FeatureManifest } from "@waterplane/sdk";
import { TokensSheet } from "./TokensSheet.tsx";

export const manifest: FeatureManifest = {
  id: "token-stats",
  sheets: [{ id: "tokens", persisted: true, render: () => createElement(TokensSheet) }],
};
