/**
 * The share feature's state: what another app shared, while the person picks
 * where it goes.
 */
import type { SharedItems } from "../../shellShare";
import { createStore } from "../../sdk";

/** In memory only: the copies live in the shell's cache for a day, and a
 *  reload is an answer of "not now". */
export const shared = createStore<SharedItems | null>(null);
