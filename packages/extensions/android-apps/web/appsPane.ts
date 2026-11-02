/**
 * How the Apps screen opens next. Set by the door (`index.ts`: the launcher line, core's `appsDoor`
 * callers), read once, then back to the default.
 *
 * - The launcher's `apps · 2 waiting` COUNTED builds waiting to install — a count on a control is a
 *   filter, so that tap opens exactly those two.
 * - The Build sheet's APK run opens on that repo's app ("get it on this phone"): the card that says
 *   whether its builds reach this phone and install by themselves.
 */
export type AppsPane = "apps" | "log";

/** The cut the apps list opens on: everything, the builds waiting to install, or one repo's apps. */
export type AppsCut = { kind: "all" } | { kind: "waiting" } | { kind: "repo"; repo: string };

let next: AppsCut | null = null;

/** The door's cut (`appsDoor`, the launcher line): the sheet reads it once as it opens. */
export function setNextCut(cut: AppsCut): void { next = cut; }

export function takeAppsCut(): AppsCut {
  const c = next ?? { kind: "all" };
  next = null;
  return c;
}
