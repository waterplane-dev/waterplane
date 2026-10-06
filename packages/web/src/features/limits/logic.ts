/**
 * The limits feature's pure half: the toolbar toggle's cycle and the words
 * every tap here toasts. Moved verbatim out of `App.tsx` (`renderToolbarItem`'s
 * `limit` arm and `overlayViews.limits`), pinned by `logic.test.mjs`.
 */
import type { LimitResumeMode } from "@waterplane/shared";

/** The per-session override's cycle: inherit (the global) → on → off → inherit. */
export function nextOverride(override: boolean | null | undefined): boolean | null {
  return override == null ? true : override ? false : null;
}

/** The toolbar toggle's receipt, naming what `inherit` currently means. */
export function overrideToast(next: boolean | null, globalAuto: boolean): string {
  return `auto-continue: ${next == null ? `inherit (${globalAuto ? "on" : "off"})` : next ? "on for this session" : "off for this session"}`;
}

/** Where the session's effective value comes from, for the toggle's title. */
export function overrideSource(override: boolean | null | undefined, globalAuto: boolean): string {
  return override == null ? `global (${globalAuto ? "on" : "off"})` : "session override";
}

/** The receipt for a change of the resume queue's release mode. */
export function modeToast(mode: LimitResumeMode): string {
  return mode === "one" ? "resuming one session at a time"
    : mode === "repo" ? "resuming one session per repo at a time"
    : "resuming every queued session once the limit lifts";
}
