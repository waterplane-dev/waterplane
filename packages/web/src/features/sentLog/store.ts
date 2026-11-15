/**
 * The sent-command audit log: what the app typed into sessions, and when.
 *
 * Two stores, each with ONE writer: `entries` is written only by this
 * feature's `sent.log` / `sent.new` handlers, `scope` only by `openSentLog`
 * and the toolbar command's `openSentForActive` (both in `actions.ts`).
 */
import type { SentCommand, StoreLoss } from "@waterplane/shared";
import { createStore } from "../../sdk";

/** The log as the host last sent it, newest first. */
export const entries = createStore<SentCommand[]>([]);

/** When set, the sheet is filtered to this session; null = all. */
export const scope = createStore<string | null>(null);

/** `sent.json` lost and not dismissed (`sent.log.loss`): an empty or short list may be the loss.
 *  Written only by the `sent.log` handler — each whole-list frame restates it. */
export const sentLoss = createStore<StoreLoss | null>(null);
