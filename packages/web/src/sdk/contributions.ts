/**
 * What an extension adds to the launcher and the session header: a session view (a segment beside
 * `[Claude | Shell]`) and a launcher line with its optional count. Cut out of `types.ts` by subject;
 * `types.ts` and `index.ts` re-export every name here, so a feature imports them as before.
 */
import type { Availability, ContributionIcon, CoreApi } from "./types.ts";

/**
 * A view of a session that is not its terminal (the first: the live desktop), drawn as a segment in
 * the session header beside `[Claude | Shell]` — only once it was opened from the session's ☰ menu
 * (core draws that menu line), and its tab carries an × that takes it down again
 * (`core/session/headerViews.ts`). With no companion shell, the session's own tab is
 * drawn lit before it (`[Claude | Desktop]`, `[Shell | Desktop]`); with no view contributed at all
 * the header is exactly what it was. A view is not a session: no PTY, no tab of its own.
 */
export interface SessionViewDef {
  id: string;
  /** The segment's word. Short: it shares the title row. */
  label: string;
  icon: ContributionIcon;
  /** Lower first, then registry order. Default 0. */
  order?: number;
  /** Absent = always available. */
  available?(core: CoreApi): Availability;
  /** The tap, when available: usually `core.nav.open` of the extension's own (full) sheet. */
  open(core: CoreApi, ctx: { sessionId: string }): void;
}

/** A button in the launcher's header row ("Desktop", one tap from home). No live thumbnail: a
 *  readout there would spend bandwidth on a screen nobody opened. */
export interface LauncherItemDef {
  id: string;
  /** The button's word, beside its icon. One word — two at most ("android apps"); the rest is `title`. */
  label: string;
  icon: ContributionIcon;
  /** Lower first, then registry order. Default 0. */
  order?: number;
  /** Absent = always available. */
  available?(core: CoreApi): Availability;
  open(core: CoreApi): void;
  /**
   * A HOOK, called once per render by the core's launcher components: what is waiting behind this
   * item (the vault's asks). n > 0 draws a counted badge on the menu line AND lifts the item out of
   * the hidden menu into the header row beside the bell, so waiting work is never two taps from
   * being seen. A count is a filter: `open` must land on exactly what `n` counts. Absent, null or
   * n <= 0 = the plain menu line.
   */
  useCount?(): LauncherItemCount | null;
  /**
   * The tap while `useCount` says n > 0 (the menu line and the header key alike): lands on EXACTLY
   * what n counts — the vault's waiting cards, not its home. Absent = `open`, which must then land on
   * them itself. Ignored without `useCount`.
   */
  openCount?(core: CoreApi): void;
  /**
   * `false`: never lifted into the header — the ☰ line badge and the ☰ total only, for a count that
   * can sit for days (builds waiting). Absent = lifted (the vault's asks). Ignored without `useCount`.
   */
  headerKey?: boolean;
  /**
   * The line's resting explain text (long press, the `?` chip) while nothing is counted: what the
   * screen behind it is for, when the label alone does not say. Absent = "open <label>".
   */
  title?: string;
}

/** What `LauncherItemDef.useCount` says is waiting. `title` is the long reading; the badge is the number. */
export interface LauncherItemCount { n: number; title: string }
