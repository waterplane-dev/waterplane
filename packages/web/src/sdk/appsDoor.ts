/**
 * `FeatureManifest.appsDoor`: how core opens the screen an extension owns for this phone's own apps,
 * without importing the extension or naming its sheet id (docs/notes/android-apps-architecture.md §5).
 * Core reads it only through `useAppsDoor()`/`appsDoor()` (`extensions.ts`), which answer null while
 * no extension declaring one is switched on — then the caller takes its OFF state: omit the control
 * (an omitted prop is `undefined`, never a no-op function), or say why in words; never a grey control.
 */
import type { CoreApi } from "./types.ts";

/** Which apps the door opens on: all, the ones waiting to install (a count is a filter), or one repo's. */
export type AppsDoorCut = { kind: "all" } | { kind: "waiting" } | { kind: "repo"; repo: string };

export interface AppsDoor {
  open(core: CoreApi, cut: AppsDoorCut): void;
}
