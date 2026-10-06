/**
 * What is in the session header and the burger's menu: the toolbar's order,
 * visibility, pins and most-used ranking, the header's one-tap commands, and
 * whether the menu is open. README.md says what it owns.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { HeaderCmdsSheet } from "./HeaderCmdsSheet";
import { ToolbarSheet } from "./ToolbarSheet";
import { bootToolbarSync } from "./actions";

export { useHeaderCmds, useHeaderSplit, useToolbarCfg, useToolbarOpen, useUsedOrder } from "./store";
export { closeToolbarMenu, setToolbarOpen, useUsedOrderSnapshot } from "./actions";

export const manifest: FeatureManifest = {
  id: "toolbarCfg",
  sheets: [
    { id: "toolbar", persisted: true, render: () => createElement(ToolbarSheet) },
    { id: "hdrcmd", persisted: false, render: () => createElement(HeaderCmdsSheet) },
  ],
  boot: () => bootToolbarSync(),
};
