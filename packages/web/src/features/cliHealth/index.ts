/**
 * The CLI integration's health board and its unprompted launcher mark — see
 * README.md.
 */
import { createElement } from "react";
import { keepStores, type FeatureManifest } from "../../sdk";
import { onCliHealth } from "./actions";
import { filter } from "./store";
import { HealthBoardSheet } from "./HealthBoardSheet";
import { CliHealthSettings } from "./CliHealthSettings";

export { openCliHealth, requestCliHealth } from "./actions";
export { CliHealthChip } from "./CliHealthChip";
export { useCliRollup } from "./store";

export const manifest: FeatureManifest = {
  id: "cliHealth",
  sheets: [{
    id: "clihealth", persisted: true,
    render: () => createElement(HealthBoardSheet),
    // The chip's filter is a focus, not a route: cleared when the sheet closes.
    onLeave: () => filter.set(null),
    keep: keepStores(filter),
  }],
  messages: {
    clihealth: (msg) => onCliHealth(msg),
  },
  settings: [
    // Tools: the first door in the rack.
    { group: "tools", order: -10, render: () => createElement(CliHealthSettings) },
  ],
};
