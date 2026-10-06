/**
 * Feature rows in the Settings sheet: `featureSettingsRows(group, band)` is
 * called per BAND of `order` at the place in each `<SetGroup>` that band belongs
 * (head, end, or the Tools rack — `core/settings/SettingsSheet.tsx`), `order`
 * first, then registry order. Each row is keyed by its
 * feature and manifest position; a `render` that throws drops that feature's
 * rows only (`featureRun.ts`).
 *
 * Reads the REGISTRY (every manifest at once), like `dispatch.ts`, `sheets.ts`
 * and `toolbarItems.ts` — the only core modules allowed to
 * (`local/feature-boundary`). That rule is about the registry, not about
 * features: any core module may still import ONE feature's `index.ts` for a
 * named export (the Settings sheet reads `features/hostTools` that way).
 */
import { createElement, Fragment, type ReactNode } from "react";
import { FEATURES } from "../features/registry.ts";
import type { SettingsGroupId } from "../sdk/types.ts";
import { core } from "./api.ts";
import { createSettingsRowTable } from "./featureRun.ts";

const TABLE = createSettingsRowTable(FEATURES, core);

/** Rows of `group`, `order` first — cut to `from <= order < to` when a band is
 *  given (the sheet draws a group's bands at different places in it). */
export function featureSettingsRows(group: SettingsGroupId, band?: { from?: number; to?: number }): ReactNode[] {
  return TABLE.rows(group, band).map((r) => createElement(Fragment, { key: r.key }, r.node));
}
