/**
 * The pad: target-less notes, as a sheet — see README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { NotePadSheet } from "./NotePadSheet";

export { openPadAt } from "./actions";

export const manifest: FeatureManifest = {
  id: "pad",
  sheets: [{ id: "pad", persisted: false, render: () => createElement(NotePadSheet) }],
};
