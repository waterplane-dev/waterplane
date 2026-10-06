/**
 * The terminal grid as it was when the scrollback sheet opened. ONE writer:
 * `openScrollback` in `actions.ts`. Moved out of `App.tsx`'s `scrollbackLive`.
 *
 * Captured BEFORE the sheet unmounts the terminal, which is the only moment the
 * grid can still be read.
 */
import { createStore } from "../../sdk";

export const liveGrid = createStore<string[]>([]);
