/**
 * The pad feature's one piece of state: which note to scroll to and flash when
 * the pad opens. Not in the route, deliberately — "your words are on the pad"
 * is only an answer if it points at the note, and pointing at it is about this
 * tap, not about the screen; restoring it from a URL would re-flash a note
 * nobody just asked about. Written only by `actions.ts`.
 */
import { createStore } from "../../sdk";

export const padFocus = createStore<string | null>(null);
