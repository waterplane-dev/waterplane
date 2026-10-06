/**
 * The usage-limit resume queue's client half: the host-wide config, the
 * `limits` sheet and the per-session toolbar toggle. README.md says what this
 * owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { LimitQueueSheet } from "./LimitQueueSheet";
import { LimitToggle } from "./LimitToggle";
import { onLimitConfig } from "./actions";
import { LimitSettings } from "./LimitSettings";

export { useLimitAuto, useLimitCfg } from "./store";
export { setGlobalAuto } from "./actions";

export const manifest: FeatureManifest = {
  id: "limits",
  sheets: [
    { id: "limits", persisted: false, render: () => createElement(LimitQueueSheet) },
  ],
  toolbarItems: [
    { id: "limit", render: (_c, ctx) => createElement(LimitToggle, { active: ctx.active, label: ctx.label, dismiss: ctx.dismiss }) },
  ],
  messages: {
    "limit.config": (msg) => onLimitConfig(msg),
  },
  settings: [
    // Sessions, after the new-session defaults: auto-continue and the budget.
    { group: "sessions", order: 10, render: () => createElement(LimitSettings) },
  ],
};
