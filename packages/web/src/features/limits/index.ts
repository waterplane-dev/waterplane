/**
 * The usage-limit resume queue's client half: the host-wide config, the
 * `limits` sheet and the per-session toolbar toggle. README.md says what this
 * owns and which rules apply.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { LimitQueueSheet } from "./LimitQueueSheet";
import { LimitToggle } from "./LimitToggle";
import { onLimitConfig, onNetRetryConfig } from "./actions";
import { LimitSettings } from "./LimitSettings";
import { NetRetrySettings } from "./NetRetrySettings";

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
    "netretry.config": (msg) => onNetRetryConfig(msg),
  },
  settings: [
    // Sessions, after the new-session defaults: auto-continue and the budget.
    { group: "sessions", order: 10, render: () => createElement(LimitSettings) },
    // Right after it: the other thing the desktop types by itself after a turn stopped.
    { group: "sessions", order: 11, render: () => createElement(NetRetrySettings) },
  ],
};
