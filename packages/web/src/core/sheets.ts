/**
 * Feature sheets, as entries in App's `overlayViews` table.
 *
 * Which sheet is on top stays a TABLE (`overlayViews`) with one lookup and no
 * branch per feature: `featureSheets()` produces entries of exactly its shape,
 * and App spreads them in FIRST, so while a sheet is still also drawn by App
 * App's copy wins and moving one is deleting it there. A `null` render falls
 * through to the screen underneath, the same as any other entry.
 */
import { createElement, type ReactNode } from "react";
import type { Overlay } from "../routing.ts";
import { FEATURES } from "../features/registry.ts";
import type { SheetId } from "../sdk/types.ts";
import { core } from "./api.ts";
import { ExtBoundary } from "./ExtBoundary.tsx";
import { createSheetTable } from "./featureRun.ts";

const TABLE = createSheetTable(FEATURES);

// An extension's sheet is drawn inside its own boundary — and `render` must run INSIDE it, as a
// component (a throw during the parent's `s.render(core())` would never reach the boundary). The inner
// component is built ONCE per sheet, here, so its identity is stable across renders (no remount).
// Cost: an extension sheet is always an element, so a `null` render no longer falls through.
const EXT_SHEETS = new Map<SheetId, () => ReactNode>();
for (const [id, s] of TABLE.sheets) {
  const ext = /^feature:([^/]+)\//.exec(id);
  if (!ext) continue;
  const Inner = () => s.render(core());
  EXT_SHEETS.set(id, () => createElement(ExtBoundary, { feature: ext[1]!, what: "its sheet", children: createElement(Inner) }));
}

export function featureSheets(): Partial<Record<SheetId, () => ReactNode>> {
  const out: Partial<Record<SheetId, () => ReactNode>> = {};
  for (const [id, s] of TABLE.sheets) out[id] = EXT_SHEETS.get(id) ?? (() => s.render(core()));
  return out;
}

/** The overlay changed from `prev` to `next`: the sheet that stopped being on
 *  top gets its `onLeave`. */
export function runSheetLeave(prev: Overlay, next: Overlay): void {
  TABLE.leave(prev, next);
}
