/**
 * The geometry a PTY may be given — and the floor under it.
 *
 * A client reports the size of the grid it is showing, and the host passes it
 * to the PTY as a SIGWINCH. Both ends used to accept anything above two rows,
 * which is how a session ended up three rows tall for forty minutes: the
 * phone's terminal container was laid out with (almost) no height — a sheet
 * open over it, a reader view, a WebView mid-layout — so `FitAddon` measured a
 * full-width, no-height box and reported `54x3`. Nothing about that report is
 * wrong as arithmetic; it is simply not a viewport.
 *
 * The consequence is not cosmetic. The claude TUI cannot draw its composer box
 * in three rows, so text typed into that session appears NOWHERE on the
 * rendered screen — and the rendered screen is the only thing `deliver.ts` has
 * to confirm a delivery with. Every send became `unconfirmed`, every `absent`
 * verdict authorised a re-send that also could not be read back, and the
 * composer quietly stacked five copies of the same prompt. Twenty-eight
 * consecutive echo misses, all of them a layout bug wearing a delivery bug's
 * clothes.
 *
 * So: a geometry that cannot hold the CLI's composer is not accepted as one.
 * The host clamps (a PTY bigger than the viewport is a scrolled view, which is
 * survivable; one too small to read back is not), and the client does not
 * report a fit it took off a collapsed container at all — it waits for the
 * layout it is actually showing. One number, stated once, so the two ends
 * cannot disagree about what "too small to drive" means.
 */

/** Narrowest grid the CLI's box drawing survives at all. */
export const MIN_PTY_COLS = 20;

/**
 * Fewest rows the claude TUI can draw a composer in and still be readable
 * back: the box's two borders, a row of text inside it, the status line and
 * the mode line, plus enough above it that the echo probe has something to
 * match against. Well under any real phone in portrait (≈24-40 rows), so this
 * floor only ever catches a measurement nobody was looking at.
 */
export const MIN_PTY_ROWS = 12;

/** A terminal size, as the PTY will be told it. */
export type PtySize = { cols: number; rows: number };

/**
 * Is this a grid a person is actually looking at?
 *
 * The question the CLIENT asks before reporting a fit. A collapsed container
 * answers no, and a report withheld costs nothing — the next layout change
 * fires another one, and `session.attach` re-states the geometry on reconnect.
 */
export const drawableViewport = (cols: number, rows: number): boolean =>
  Number.isFinite(cols) && Number.isFinite(rows) &&
  Math.floor(cols) >= MIN_PTY_COLS && Math.floor(rows) >= MIN_PTY_ROWS;

/**
 * The size to actually give a PTY, whatever was asked for.
 *
 * The question the HOST asks, and it clamps rather than refuses: a client that
 * reports a too-small grid is still a client with a session open, and leaving
 * the PTY at whatever it was is what the floor is for. Non-numbers fall back to
 * the floor too — an absent geometry is not a small one.
 */
export function ptySize(cols: unknown, rows: unknown): PtySize {
  const n = (v: unknown, min: number): number => {
    const x = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0;
    return Math.max(min, x);
  };
  return { cols: n(cols, MIN_PTY_COLS), rows: n(rows, MIN_PTY_ROWS) };
}
