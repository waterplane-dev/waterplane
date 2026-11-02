/**
 * Whether an extension is switched ON, and where its downloaded assets live — for an
 * extension whose web half must do nothing at all while the person has it off (the OCR
 * reader: an optional extension, off by default, whose engine is megabytes).
 *
 * The id is the extension's ONE id: the folder under `packages/extensions/`, its
 * `waterplane-plugin.json` `id` and its web `FeatureManifest.id` are the same string, so a
 * web half asks about itself with its own manifest id.
 *
 * The plugin list is the host's (`plugin.list`, `features/plugins`' store). sdk/ never imports
 * a feature, so `core/extensionPoints.ts` BINDS that store here once (`bindPluginList`) and this
 * module mirrors it. Unbound, not yet listed, or not in the list ⇒ OFF: an optional extension
 * that cannot show it is on stays off — never a guess that it is. The bound store starts from the
 * host's LAST list as this phone cached it (`features/plugins/logic.ts`, per host), so a cold
 * start with the tunnel down reads what the desktop last said rather than "off"; a desktop this
 * phone was never told about still reads off.
 */
import { logTag } from "@waterplane/shared";
import { useMemo, useSyncExternalStore } from "react";
import type { PluginView } from "@waterplane/shared";
import { core } from "../core/api.ts";
import { createStore, type Store } from "./store.ts";
import type { AppsDoorCut } from "./appsDoor.ts";
import type { FeatureManifest, ImageTextReader } from "./types.ts";

/** What "is it on" reads of a listed plugin — all a cached list keeps (`features/plugins/logic.ts`). */
export type PluginOn = { manifest: { id: string } } & Pick<PluginView, "enabled" | "state">;

/** The mirror; its ONE writer is the binding below. */
const list = createStore<readonly PluginOn[] | null>(null);
/** True once the LIVE list has landed (the mirror may hold the cache's until then). */
const liveSeen = createStore(false);
let unbind: (() => void) | null = null;

/** `core/extensionPoints.ts`'s, once: the host's plugin list this module reads, and (optionally) the
 *  flag that its live list has landed. Without the flag the list is treated as live. */
export function bindPluginList(source: Pick<Store<readonly PluginOn[] | null>, "get" | "subscribe">, live?: Pick<Store<boolean>, "get" | "subscribe">): void {
  unbind?.();
  list.set(source.get());
  liveSeen.set(live ? live.get() : true);
  const offs = [source.subscribe(() => list.set(source.get()))];
  if (live) offs.push(live.subscribe(() => liveSeen.set(live.get())));
  unbind = () => offs.forEach((o) => o());
}

/** Pure: on iff the host listed `id`, its switch is on and it is active. */
export function enabledIn(plugins: readonly PluginOn[] | null, id: string): boolean {
  const p = plugins?.find((x) => x.manifest.id === id);
  return !!p && p.enabled && p.state === "active";
}

/** Pure: the first manifest contributing `imageText` whose extension is on; null when none
 *  (`core/extensionPoints.ts`'s `imageTextReader()` over the registry). */
export function pickImageTextReader(features: readonly FeatureManifest[], enabled: (id: string) => boolean): ImageTextReader | null {
  for (const f of features) if (f.imageText && enabled(f.id)) return f.imageText;
  return null;
}

let features: () => readonly FeatureManifest[] = () => [];

/** Pure: the first manifest declaring `appsDoor` whose extension is on, with its id; null when none. */
export function pickAppsDoor(fs: readonly FeatureManifest[], enabled: (id: string) => boolean): { feature: string; door: NonNullable<FeatureManifest["appsDoor"]> } | null {
  for (const f of fs) if (f.appsDoor && enabled(f.id)) return { feature: f.id, door: f.appsDoor };
  return null;
}

/** The door core opens that screen through, bound to the core: `open(cut)`. */
export interface OpenAppsDoor {
  open(cut: AppsDoorCut): void;
}

function bindDoor(p: ReturnType<typeof pickAppsDoor>): OpenAppsDoor | null {
  if (!p) return null;
  return {
    open: (cut) => {
      const c = core();
      try { p.door.open(c, cut); } catch (e) {
        console.error(`${logTag} feature ${p.feature} failed opening its door`, e);
        c.say.toast(`${p.feature} could not open that screen`);
      }
    },
  };
}

/** The same as a hook: re-renders when the extension is switched on or off. */
export function useAppsDoor(): OpenAppsDoor | null {
  const l = usePluginList();
  return useMemo(() => bindDoor(pickAppsDoor(features(), (id) => enabledIn(l, id))), [l]);
}

/** `core/extensionPoints.ts`'s, once: the registry `imageTextReader()` picks from. Bound, not
 *  imported — the annotator reads this module, and the registry imports the annotator. */
export function bindImageTextFeatures(source: () => readonly FeatureManifest[]): void {
  features = source;
}

/** The phone-side reader for the words inside an annotator mark, or null — with none, the annotator
 *  behaves exactly as before (typed words only). Core's, not in the SDK index. */
export function imageTextReader(): ImageTextReader | null {
  return pickImageTextReader(features(), isExtensionEnabled);
}

/** The same as a hook: re-renders when an extension is switched on or off. */
export function useImageTextReader(): ImageTextReader | null {
  const l = usePluginList();
  return useMemo(() => pickImageTextReader(features(), (id) => enabledIn(l, id)), [l]);
}

/** Whether extension `id` is switched on right now: the host's last word (this phone's cached copy
 *  until the live list lands); false for a host that never listed it to this phone. */
export function isExtensionEnabled(id: string): boolean {
  return enabledIn(list.get(), id);
}

/** Call `cb(on)` whenever extension `id` is switched on or off (not on every list change). Fires
 *  once at once with the current state, and once more when the first LIVE list lands even if it
 *  changed nothing: the first call may have read a cached "on" the desktop no longer says, or failed
 *  on it. Returns the unsubscribe. For an extension's `boot` — downloading its engine when the person
 *  ENABLES it is not a render's job. */
export function watchExtensionEnabled(id: string, cb: (on: boolean) => void): () => void {
  let last = isExtensionEnabled(id);
  let told = false; // a change already delivered the live value
  cb(last);
  const offList = list.subscribe(() => {
    const now = isExtensionEnabled(id);
    if (now !== last) { last = now; told = true; cb(now); }
  });
  const offLive = liveSeen.subscribe(() => {
    if (!liveSeen.get()) return;
    if (!told) cb(last = isExtensionEnabled(id));
    told = false;
  });
  return () => { offList(); offLive(); };
}

/** The host's plugin list as last mirrored, re-rendering on change — core's, not in the SDK index.
 *  Core's contribution tables read `hideWhen` per render; their components call this so a switch
 *  flipped on the desktop redraws the lines it hides. */
export function usePluginList(): readonly PluginOn[] | null {
  return useSyncExternalStore(list.subscribe, list.get, list.get);
}

/** The same, re-rendering when the host's list changes. */
export function useExtensionEnabled(id: string): boolean {
  return useSyncExternalStore(list.subscribe, () => isExtensionEnabled(id), () => isExtensionEnabled(id));
}

/**
 * The Cache Storage name holding extension `id`'s downloaded assets. Spelled once more in
 * `public/sw.js` (`EXT_CACHE_PREFIX`), which cannot import; `extensions.test.mjs` holds the
 * two together. The service worker's per-build purge spares every cache with this prefix.
 */
export const EXT_CACHE_PREFIX = "wp-ext-";
export const extAssetCacheName = (id: string): string => `${EXT_CACHE_PREFIX}${id}`;

/**
 * The same-origin URL the service worker answers CACHE-ONLY from `extAssetCacheName(id)` (404
 * when absent; never the network). The extension stores each authenticated download
 * (`/api/plugin/<id>/asset/<file>`) under exactly this URL. `file` is flat:
 * `[A-Za-z0-9][A-Za-z0-9._-]*`, no slash.
 */
export const extAssetUrl = (id: string, file: string): string => `/ext-asset/${encodeURIComponent(id)}/${encodeURIComponent(file)}`;
