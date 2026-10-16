/**
 * **Repo colour, as this device holds it** — the store half of
 * `shared/repocolor.ts`.
 *
 * `link.ts`'s shape, small: one value, ONE writer (`saveRepoColors`), and a
 * subscription for the two surfaces that draw repo colour outside `App`'s own
 * render — the tab strip, which is mounted beside `App` in `main.tsx` and
 * cannot see its state, and the colour sheet itself.
 *
 * The value is pushed into `format.ts` on every change rather than read through
 * a hook at each call site. There are ~30 `repoAccentStyle(...)` call sites and
 * every one of them is a `style=` in the middle of a list render; making each
 * subscribe to a settings store would be thirty subscriptions to answer one
 * question that changes about twice a year. What a component needs the hook for
 * is the RE-RENDER, not the value.
 *
 * SYNCED (`LS.repoColors` is on the allow-list), so the write goes up by itself
 * through `settings.ts`'s patched `setItem` and an adopted copy arrives through
 * `onSettingsChange` — `App` calls `adoptRepoColors()` there. Nothing in this
 * file talks to the host.
 */
import { useEffect, useState } from "react";
import { cleanRepoColors, NO_REPO_COLORS, type RepoColors } from "@waterplane/shared";
import { setRepoColorCfg } from "./format";
import { LS, lsJson, lsSetJson } from "./storage";

const read = (): RepoColors => cleanRepoColors(lsJson<unknown>(LS.repoColors, {}));

let cfg: RepoColors = NO_REPO_COLORS;
const listeners = new Set<(c: RepoColors) => void>();

function apply(next: RepoColors): void {
  cfg = next;
  setRepoColorCfg(next);
  for (const fn of listeners) fn(next);
}

/** What every `repoHue` in the app is currently answering with. */
export const repoColors = (): RepoColors => cfg;

/**
 * The one writer. Persists (which syncs), re-points `format.ts`, and tells the
 * subscribers — in that order, so a device that cannot write (private mode, a
 * full quota) still shows the colour it was asked for until it reloads, rather
 * than silently ignoring the tap.
 */
export function saveRepoColors(next: RepoColors): void {
  const clean = cleanRepoColors(next);
  lsSetJson(LS.repoColors, clean);
  apply(clean);
}

/** Another device's copy landed: re-read the store, tell everybody. */
export function adoptRepoColors(): void { apply(read()); }

/** Subscribe. `useLink`'s shape — the value is stable between changes, so a
 *  component using this re-renders only when a colour actually moved. */
export function useRepoColors(): RepoColors {
  const [v, setV] = useState(cfg);
  useEffect(() => {
    // Whatever landed between this component's first render and its effect —
    // an adopted copy arriving during boot is exactly that gap.
    if (v !== cfg) setV(cfg);
    const fn = (c: RepoColors) => setV(c);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only subscription; `v` is compared once to catch a copy adopted before the effect ran
  }, []);
  return v;
}

// Read at module load, before anything renders: the first paint of the launcher
// must already carry the colours this person chose, or every repo header
// changes hue one frame in.
apply(read());
