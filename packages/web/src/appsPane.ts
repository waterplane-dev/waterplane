/**
 * Which pane the apps screen opens on next. Set by a control that COUNTED
 * ready builds (the launcher's `apps · 2 ready`) — a count on a control is a
 * filter, so that tap opens exactly those two. Read once, then back to the
 * default. Its own module so the launcher need not import the sheet.
 */
export type AppsPane = "ready" | "apps" | "setup" | "log";

let next: AppsPane | null = null;

export function openAppsOnReady(): void { next = "ready"; }

export function takeAppsPane(): AppsPane {
  const p = next ?? "apps";
  next = null;
  return p;
}
