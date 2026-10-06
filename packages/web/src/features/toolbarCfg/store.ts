/**
 * What is in the session header and the burger's menu, as this device has it.
 * Every store here is written only by `actions.ts`.
 *
 * - `toolbarCfg` — order, hidden, pinned and sort of the menu's items
 *   (`LS.toolbar`, synced). `toolbar.ts` still declares the items themselves.
 * - `headerCmds` — the one-tap chips beside the session title (`LS.headerCmds`,
 *   synced). With the pins they are ONE question ("what is in my header"), so
 *   one feature owns both and the header-commands sheet configures both.
 * - `usedOrder` — the most-used-first order, SNAPSHOTTED, not live: re-ranking
 *   on every tap would move buttons out from under the finger.
 * - `toolbarOpen` — the burger's menu open or shut (`LS.toolbarOpen`, per
 *   device). One fact with one writer, so a choice that shuts the menu and the
 *   burger itself cannot disagree about it.
 */
import { useMemo } from "react";
import { createStore, useStore } from "../../sdk";
import { loadHeaderCmds, splitHeaderCmds, type HeaderCmd, type HeaderCmdSplit } from "../../headerCmds";
import { LS, lsGet } from "../../storage";
import { loadToolbarCfg, type ToolbarCfg } from "../../toolbar";

export const toolbarCfg = createStore<ToolbarCfg>(loadToolbarCfg());
export const headerCmds = createStore<HeaderCmd[]>(loadHeaderCmds());
export const usedOrder = createStore<string[]>([]);
export const toolbarOpen = createStore<boolean>(lsGet(LS.toolbarOpen) === "1");

export function useToolbarCfg(): ToolbarCfg { return useStore(toolbarCfg); }
export function useHeaderCmds(): HeaderCmd[] { return useStore(headerCmds); }
export function useUsedOrder(): string[] { return useStore(usedOrder); }
export function useToolbarOpen(): boolean { return useStore(toolbarOpen); }
/** The header chips a session that can (or cannot) take a slash command is
 *  shown, and how many were withheld — the ONE `splitHeaderCmds` call both the
 *  session header and the `hdrcmd` sheet read, so the number and the cut
 *  cannot be computed apart. */
export function useHeaderSplit(canSlash: boolean): HeaderCmdSplit {
  const cmds = useStore(headerCmds);
  return useMemo(() => splitHeaderCmds(cmds, canSlash), [cmds, canSlash]);
}
