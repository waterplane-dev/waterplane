/**
 * Every writer of the toolbar-configuration stores.
 */
import { useEffect } from "react";
import { core } from "../../sdk";
import { loadHeaderCmds, resetHeaderCmds, saveHeaderCmds, type HeaderCmd } from "../../headerCmds";
import { onSettingsChange } from "../../settings";
import { LS, lsSet, lsSetJson } from "../../storage";
import { loadToolbarCfg, orderedToolbarItems, usedToolbarRank, type ToolbarCfg } from "../../toolbar";
import { closesMenu, draggedOnto, movedBy, toggled } from "./logic";
import { headerCmds, toolbarCfg, toolbarOpen, usedOrder, useToolbarCfg } from "./store";

export function saveToolbarCfg(next: ToolbarCfg): void {
  toolbarCfg.set(next);
  lsSetJson(LS.toolbar, next);
}

/** Pin/unpin a toolbar action into the session header (survives a collapse). */
export function toggleToolbarPin(id: string): void {
  const cfg = toolbarCfg.get();
  core().say.track("action:toolbar.pin");
  saveToolbarCfg({ ...cfg, pinned: toggled(cfg.pinned ?? [], id) });
}

export function toggleToolbarItem(id: string): void {
  const cfg = toolbarCfg.get();
  saveToolbarCfg({ ...cfg, hidden: toggled(cfg.hidden, id) });
}

export function moveToolbarItem(id: string, dir: -1 | 1): void {
  const cfg = toolbarCfg.get();
  const order = movedBy(orderedToolbarItems(cfg).map((t) => t.id), id, dir);
  if (order) saveToolbarCfg({ ...cfg, order });
}

/** Live drag-reorder: drop the dragged item into the slot currently under the
 *  pointer. Saves on every move so the list reflows as you drag. */
export function dragToolbarItem(dragId: string, overId: string | null | undefined): void {
  const cfg = toolbarCfg.get();
  const order = draggedOnto(orderedToolbarItems(cfg).map((t) => t.id), dragId, overId);
  if (order) saveToolbarCfg({ ...cfg, order });
}

export function setToolbarSort(sort: "manual" | "used"): void {
  const next = { ...toolbarCfg.get(), sort };
  saveToolbarCfg(next);
  if (sort === "used") usedOrder.set(usedToolbarRank(next));
}

/** The burger itself: open or shut the menu, persisted. */
export function setToolbarOpen(open: boolean): void {
  toolbarOpen.set(open);
  lsSet(LS.toolbarOpen, open ? "1" : "0");
}

/**
 * Shut the burger's menu behind a choice. Persisted through the same key the
 * burger itself writes, so "open" and "closed" stay ONE fact with one writer
 * — a menu that re-opened on the next session because the close never
 * reached storage is a menu that ignores the last thing you told it.
 */
export function closeToolbarMenu(id?: string): void {
  if (!closesMenu(id)) return;
  toolbarOpen.set(false);
  lsSet(LS.toolbarOpen, "0");
}

export function writeHeaderCmds(next: HeaderCmd[]): void {
  headerCmds.set(next);
  saveHeaderCmds(next);
}

export function resetHeaderCmdsToDefault(): void {
  headerCmds.set(resetHeaderCmds());
}

/**
 * Re-snapshot the most-used toolbar order. Deliberately NOT reactive to
 * individual taps — only to mode/session changes and a slow tick: taken on
 * mount, on session switch, when the mode is turned on, and once a minute.
 * A hook, because the session switch is App's (`activeId`).
 */
export function useUsedOrderSnapshot(activeId: string | null): void {
  // Subscribed, so a sort or order change re-runs the snapshot effect.
  const cfg = useToolbarCfg();
  useEffect(() => {
    const now = toolbarCfg.get();
    if (now.sort !== "used") return;
    usedOrder.set(usedToolbarRank(now));
    const t = setInterval(() => usedOrder.set(usedToolbarRank(toolbarCfg.get())), 60000);
    return () => clearInterval(t);
  }, [cfg.sort, cfg.order, activeId]);
}

/**
 * The READ half of sync (`settings.ts`) for both synced keys: each is held in
 * a store seeded at load, so a copy adopted from another device would
 * otherwise sit in localStorage until the next reload.
 */
export function bootToolbarSync(): () => void {
  return onSettingsChange((key) => {
    if (key === LS.toolbar) toolbarCfg.set(loadToolbarCfg());
    else if (key === LS.headerCmds) headerCmds.set(loadHeaderCmds());
  }, [LS.toolbar, LS.headerCmds]);
}
