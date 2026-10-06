/**
 * The terminal's background and foreground, per theme — the one statement of
 * them both ends read.
 *
 * The phone paints its xterm.js grid with these (`web/termTheme.ts`, which adds
 * the light theme's sixteen ANSI colours on top). The host answers the tmux
 * client's OSC 10/11 colour queries with them (`host/termqueries.ts`), and
 * tmux hands the same answer to the CLI when IT asks for the background — so
 * the colour the CLI picks its own contrast against is the colour the phone
 * actually draws behind it, whether or not a phone is attached.
 */
export type TermThemeName = "dark" | "light";

export interface TermColors { background: string; foreground: string }

export const TERM_COLORS: Readonly<Record<TermThemeName, Readonly<TermColors>>> = {
  dark: { background: "#0b0d10", foreground: "#d6dce5" },
  light: { background: "#fcfcfd", foreground: "#1c2430" },
};
