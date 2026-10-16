/**
 * Token statistics and the `/usage` reading behind every usage readout — see
 * README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { calibrateWeek } from "./actions";
import { billing, readings, usage } from "./store";
import { readingsOf } from "./logic";
import { BillingSettings } from "./BillingSettings";
import { TokenSettings } from "./TokenSettings";

export { useUsage, useWeekIncl, useWeekUsdPerPct } from "./store";
export { useBilling, useUsageFace } from "./store";
export { clearTokensOn, openTokensOn, readingsNow, tokensOpenOn, tokensOpenOnNow, useTokensOpenOn, useUsageReadings } from "./store";
export type { UsageFace, ClaudeFigures } from "./logic";
export { claudeDoorBeside, claudeFigures, claudeSegmentFigures, figuresHot, headerReadings, hiddenNote, infoFigures, launcherReadings, tokensOpenSource } from "./logic";

export const manifest: FeatureManifest = {
  id: "tokens",
  messages: {
    "usage.status": (msg) => { usage.set(msg.usage); readings.set(readingsOf(msg.readings, msg.usage)); calibrateWeek(msg.usage); },
    // A fresh hello starts the account face over: a host that does not say (an older one) must not
    // inherit the last desktop's api face. A capable host sends billing.status right after.
    welcome: () => { billing.set(null); readings.set([]); },
    "billing.status": (msg) => billing.set({ profile: msg.profile, source: msg.source }),
  },
  settings: [
    // Tools, above the door rack.
    { group: "tools", order: -20, render: () => createElement(TokenSettings) },
    // Sessions, right after the usage budget (limits, order 10): which account this is, and its dollar periods.
    { group: "sessions", order: 11, render: () => createElement(BillingSettings) },
  ],
};
