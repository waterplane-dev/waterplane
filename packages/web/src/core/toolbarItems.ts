/**
 * Feature-drawn session-toolbar items. App's `renderToolbarItem` asks here in
 * its `default:` arm, before drawing the generic button: `undefined` means no
 * feature declares the id and App's own button runs; anything else (including
 * `null`, "not shown now") is the feature's answer. A throw hides that item
 * only (`featureRun.ts`). Reads the registry, like `dispatch.ts` and `sheets.ts`.
 */
import type { ReactNode } from "react";
import { FEATURES } from "../features/registry.ts";
import type { ToolbarItemDef } from "../sdk/types.ts";
import { core } from "./api.ts";
import { createToolbarItemTable } from "./featureRun.ts";

const TABLE = createToolbarItemTable(FEATURES, core);

export function featureToolbarItem(id: string, ctx: Parameters<ToolbarItemDef["render"]>[1]): ReactNode | null | undefined {
  return TABLE.item(id, ctx);
}
