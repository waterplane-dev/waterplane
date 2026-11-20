/**
 * One door: a control a person taps, the place it is on, and the screen it opens (whole-app journey
 * spec D1, D10). The registry is data, never wiring: nothing here opens anything. It is read by
 * `tools/appdoors.test.mjs` (the label says the title: equal, or its start at a word boundary, a
 * leading count ignored) and by `tools/wherefind.mjs` (the README's "Where do I find" table, P17).
 */
import type { Overlay } from "../routing.ts";
import type { TITLE } from "../sheetNames.ts";

/** Where the control is drawn. `sheet:<overlay id>` is a door inside another screen. */
export type DoorFrom =
  | "home" | "home menu" | "repo row" | "repo menu" | "status strip"
  | "session header" | "toolbar menu" | "composer" | "send menu"
  | "settings" | "search" | "notification" | "welcome"
  | `sheet:${string}`;

export interface Door {
  /** The words on the control, as drawn ("3 blocked" may stand for any count: write "N blocked"). */
  label: string;
  from: DoorFrom;
  /** The overlay it opens (an alias is fine: it lands on the merged screen's tab). */
  to: Overlay;
  /** The landing screen's title: a value of `sheetNames.ts` `TITLE`, never a literal of its own. */
  title: (typeof TITLE)[keyof typeof TITLE];
  /** The tab (and section) it lands on, as drawn — for the merged screens. */
  tab?: string;
  /** The task a person has in mind, for the README table ("Commit and push"). */
  task?: string;
  /** Taps from Home to the landing screen, the opener included. */
  taps?: number;
}

/** An overlay id that has no door on purpose, with the reason (a transient viewer, a consent sheet). */
export type NoDoor = Partial<Record<Exclude<Overlay, null>, string>>;

/** What each area file exports. */
export interface DoorArea { doors: readonly Door[]; noDoor?: NoDoor }
