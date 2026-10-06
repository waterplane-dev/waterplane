/**
 * Host-side session search: the `search` sheet and its results — README.md.
 */
import { createElement } from "react";
import type { FeatureManifest } from "../../sdk";
import { SessionSearchSheet } from "./SessionSearchSheet";
import { onSearchResults } from "./actions";

export { openSearch } from "./actions";

export const manifest: FeatureManifest = {
  id: "search",
  sheets: [
    { id: "search", persisted: false, render: () => createElement(SessionSearchSheet) },
  ],
  messages: {
    "session.searchResults": (msg) => onSearchResults(msg.id, msg.results),
  },
};
