/**
 * Token statistics and the `/usage` reading behind every usage readout — see
 * README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { calibrateWeek } from "./actions";
import { usage } from "./store";
import { TokenSettings } from "./TokenSettings";

export { useUsage, useWeekIncl, useWeekUsdPerPct } from "./store";

export const manifest: FeatureManifest = {
  id: "tokens",
  messages: {
    "usage.status": (msg) => { usage.set(msg.usage); calibrateWeek(msg.usage); },
  },
  settings: [
    // Tools, above the door rack.
    { group: "tools", order: -20, render: () => createElement(TokenSettings) },
  ],
};
