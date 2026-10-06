/**
 * The terminal's own palette, per theme.
 *
 * xterm.js does not read CSS custom properties — its renderer needs concrete
 * colours — so this is the one place in the app where the palette is stated in
 * JavaScript rather than in `styles.css`. The background here and `--term-bg`
 * there are the same colour on purpose: `.term-wrap` paints the padding round
 * the grid, and a one-shade mismatch draws a frame round the terminal that
 * looks like a bug.
 *
 * **Dark keeps xterm's own ANSI defaults**, exactly as it always has: only
 * background and foreground are stated. The sixteen defaults are the standard
 * bright-on-black set, they have been what this app looks like since the first
 * commit, and re-specifying them would be a redesign wearing a theme port's
 * clothes.
 *
 * **Light has to state all sixteen**, because those same defaults are a disaster
 * on a white page — default yellow is `#ffff00` and default bright-white is
 * `#ffffff`, i.e. invisible, and the CLI uses both. The set below is GitHub's
 * light ANSI palette: it exists precisely because a lot of CLI output had to be
 * made readable on white, every entry clears 4.5:1 against the background, and
 * it keeps the hue identities (red is red) that make `git diff` and the CLI's
 * own colouring mean anything.
 */
import type { ITheme } from "@xterm/xterm";
import { TERM_COLORS, termColorsFor } from "@waterplane/shared";
import type { Theme } from "./theme";
import { themeOverlay } from "./themeOverlay.ts";

// Background and foreground live in shared (`termpalette.ts`): the host answers
// the tmux client's colour queries with the same two, so what the CLI is told
// its background is and what this grid paints are one value.
const DARK: ITheme = { ...TERM_COLORS.dark };

const LIGHT: ITheme = {
  ...TERM_COLORS.light,
  cursor: TERM_COLORS.light.foreground,
  cursorAccent: TERM_COLORS.light.background,
  // A selection on white must be a wash, not a fill: xterm draws the text under
  // it unchanged, so an opaque highlight hides what was selected.
  selectionBackground: "rgba(21, 100, 204, .22)",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0550ae",
  magenta: "#6639ba",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#0969da",
  brightMagenta: "#8250df",
  brightCyan: "#1b7c83",
  brightWhite: "#24292f",
};

/** The grid's palette. A fork's `terminal` colours (`themeOverlay.ts`) replace
 *  background/foreground — the SAME pair the host tells tmux — and, in light,
 *  the cursor that is stated as those two. No overlay ⇒ the constants above. */
export function termTheme(theme: Theme): ITheme {
  const base = theme === "light" ? LIGHT : DARK;
  const tc = termColorsFor(theme, themeOverlay());
  if (tc === TERM_COLORS[theme]) return base;
  return theme === "light" ? { ...base, ...tc, cursor: tc.foreground, cursorAccent: tc.background } : { ...base, ...tc };
}
