/**
 * The clipboard feature's state.
 *
 * `dump` is what the Terminal-text sheet shows and where it came from; `clipSeed`
 * is what the To-desktop-clipboard sheet opens staged with (the compose draft at
 * the moment of the tap). Both are written ONLY by `actions.ts` — the clip
 * sheet's edits live in the sheet's own state, seeded from `clipSeed` on mount.
 *
 * The compose draft, the live grid and inserting into compose are App's, read
 * through `core().compose`.
 */
import { createStore } from "../../sdk";

export type DumpSource = "grid" | "transcript";
/** Which source filled the dump — the live grid, or the reader's document when
 *  no terminal is mounted. The sheet title says which one you are looking at,
 *  so an unexpected shape is explained rather than surprising. */
export const dump = createStore<{ text: string; source: DumpSource }>({ text: "", source: "grid" });
/** Text the clip sheet opens staged with. */
export const clipSeed = createStore("");

export type DecideSource = "picked" | "screen" | "transcript";
/** What the decisions sheet reads its items from: the rows picked on the
 *  terminal, the whole screen, or the tail of the cached conversation. Written
 *  only by `openDecisions`. */
export const decide = createStore<{ lines: string[]; from: DecideSource }>({ lines: [], from: "screen" });
/** Answers typed in the decisions sheet, by the item's text — typed words are
 *  the last copy, so closing the sheet must not delete them; reopening on the
 *  same items brings them back. In memory only: the items are a screen. */
export const decideAnswers = createStore<Record<string, string>>({});
