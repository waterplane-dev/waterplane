/**
 * The page's side of the Android shell's names, in ONE place.
 *
 * The UI updates over the air and the APK does not, so a new bundle routinely
 * runs inside a shell that still answers to the names of an earlier identity
 * (and an old bundle inside a new shell). Every bridge name therefore has a
 * current spelling (`Shell*` / `shell*`, the contract with `packages/app`) and
 * a legacy spelling per past identity, derived from `LEGACY` so the table is
 * never retyped. Nothing outside this file spells either.
 *
 *  - Capacitor plugin  `Shell<Name>`        legacy `<Slug><Name>`
 *  - JS interface      `ShellAndroidInterface`, legacy `<Slug>ShellAndroidInterface`
 *  - window callback   `shell<Name>`        legacy `<slug>Shell<Name>` (or `<slug><Name>`)
 */
import { LEGACY } from "@waterplane/shared";

const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Win = { Capacitor?: { Plugins?: Record<string, unknown> } } & Record<string, unknown>;
const root = () => globalThis as unknown as Win;

/** The native plugin `Shell<name>` (or a legacy shell's spelling), or undefined. */
export function nativePlugin<T>(name: string): T | undefined {
  const plugins = root().Capacitor?.Plugins;
  if (!plugins) return undefined;
  const hit = plugins[`Shell${name}`] ?? LEGACY.map((l) => plugins[`${up(l.slug)}${name}`]).find(Boolean);
  return hit as T | undefined;
}

/** The `addJavascriptInterface` object, under whichever name this shell gave it. */
export function shellInterface<T>(): T | undefined {
  const w = root();
  const hit = w.ShellAndroidInterface ?? LEGACY.map((l) => w[`${up(l.slug)}ShellAndroidInterface`]).find(Boolean);
  return hit as T | undefined;
}

/**
 * Define `window.shell<name>` AND every legacy spelling, so a shell of any age
 * finds it. `legacyInfix` is "Shell" for `<slug>ShellNudge`, "" for `<slug>Back`.
 * Returns the remover.
 */
export function defineShellGlobal(name: string, fn: (...a: never[]) => unknown, legacyInfix = "Shell"): () => void {
  const w = root();
  const names = [`shell${name}`, ...LEGACY.map((l) => `${l.slug}${legacyInfix}${name}`)];
  for (const n of names) w[n] = fn;
  return () => { for (const n of names) delete w[n]; };
}
