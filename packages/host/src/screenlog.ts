/**
 * What a session's terminal has SHOWN, recorded as it happens.
 *
 * ## Why this cannot be read back
 *
 * The obvious implementation is to keep the PTY bytes (the daemon already does)
 * and replay them through a headless VT when somebody asks. That is what
 * `render.ts` is for, and for one SCREEN it is exactly right. It cannot answer
 * "what scrolled off", because measured on claude 2.1.267, on every live pane
 * of this desktop:
 *
 *     history_size=0   alternate_on=1
 *
 * The CLI draws in the ALTERNATE screen buffer, which by definition has no
 * scrollback: a line that leaves the top of the grid is overwritten, not
 * pushed anywhere. So a replay of the whole ring reads back one screen —
 * measured, 31 lines for a session that had been running for hours — and tmux,
 * which is the substrate here, has nothing either (`capture-pane -S -` returns
 * the same 31 rows, because the pane's history belongs to the NORMAL buffer
 * the CLI is not using).
 *
 * That is the answer to "can the server just replay it": no, and no amount of
 * buffer is the fix. Every line that ever scrolled away was only ever visible
 * for as long as it was on the grid. It has to be written down THEN.
 *
 * ## Why the host and not the phone
 *
 * The phone already does this (`web/screenlog.ts`): after each repaint settles
 * it diffs the visible grid against the last one and keeps what fell off the
 * top. Same rule, same pure function — `@waterplane/shared`'s `absorbScreen`, which
 * is why it is in `shared` — but the phone is the wrong machine for it, and the
 * report says how it reads: "a copy-paste result of random moments that
 * duplicate lines and misses some as well."
 *
 * Both halves of that are the phone's vantage point, not the rule:
 *
 *  - **Missing lines.** The phone only sees a session while it is ON SCREEN and
 *    the app is in the foreground. Everything painted while it was closed,
 *    backgrounded, or looking at another session never passed through it.
 *  - **Duplicated blocks.** A jump too large to anchor reads as a full repaint,
 *    and the outgoing screen is then archived WHOLE — correct, because dropping
 *    it would lose content, but it means the same conversation lands twice when
 *    you come back. Gaps CAUSE those jumps, so the missing lines and the
 *    duplicated ones are the same defect seen twice.
 *
 * The daemon has neither problem: it is the process the bytes arrive at, it is
 * watching every session at once, and it never stops. Same rule, no gaps, so
 * far fewer unanchorable jumps.
 *
 * ## Cost
 *
 * One live headless VT per session, fed incrementally. That is cheaper than it
 * sounds and much cheaper than the alternative: `checkPrompt` already buys a
 * FULL replay of the ring about twice a second while a box is up, and this
 * parses each byte once, as it arrives. The grid is read on a debounce after
 * the writes settle, never per chunk — a spinner repainting at 10 Hz must cost
 * one read, not ten.
 *
 * Memory is bounded per session (`SCREENLOG_MAX_LINES` archived lines, the VT
 * itself given no scrollback of its own — there would be nothing in it).
 */
import xtermHeadless from "@xterm/headless";
import { absorbScreen, newScreenLog, screenLogLines, SCREENLOG_MAX_LINES, type ScreenLogState } from "@waterplane/shared";
import { cellRows, type RenderRow } from "./render.js";

const { Terminal } = xtermHeadless;

/**
 * Quiet time before the grid is read.
 *
 * The phone uses 400 ms for the same job and for the same reason: a grid read
 * mid-repaint is a half-drawn screen, and `absorbScreen` would archive the torn
 * half as content. Long enough to sit past one repaint, short enough that a
 * fast scroll is still sampled often enough to anchor.
 */
const SETTLE_MS = 400;

/**
 * A CEILING on the quiet window, for the same reason `checkPrompt` has one: a
 * TUI that repaints continuously (a spinner, a streaming answer) never goes
 * quiet, and a pure debounce would then never read the grid at all — which is
 * exactly the stretch where the most content is scrolling past.
 */
const MAX_STALE_MS = 1200;

export class SessionScreenLog {
  private term: InstanceType<typeof Terminal>;
  private state: ScreenLogState = newScreenLog();
  private timer: NodeJS.Timeout | null = null;
  private dueAt = 0;
  private lastReadAt = 0;
  private dirty = false;
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols: Math.max(20, cols || 80),
      rows: Math.max(4, rows || 24),
      // No scrollback on purpose: the CLI is in the alternate buffer, where
      // nothing is ever pushed into one. Asking for 5000 rows would reserve
      // memory per session for a buffer that stays empty.
      scrollback: 0,
      allowProposedApi: true,
    });
  }

  /** Feed the same bytes the phone's terminal gets. */
  write(data: string): void {
    if (this.disposed || !data) return;
    this.term.write(data);
    this.dirty = true;
    // Earliest-wins, with a ceiling — `sessions.armPromptCheck`'s rule, and it
    // is here for the same failure: a later chunk may pull the read forward but
    // must never push a pending one back, or constant output starves it.
    const ceiling = this.lastReadAt + MAX_STALE_MS - Date.now();
    this.arm(Math.max(0, Math.min(SETTLE_MS, ceiling)));
  }

  /**
   * **The grid as it stands, read straight off the live VT.**
   *
   * The recorder already holds a headless terminal fed with every byte, so the
   * CURRENT screen costs a buffer read — no replay, no diff, no state change.
   * That is what makes it usable on the per-frame paths (`checkTurnWatch`),
   * where a `renderCapture()` of the whole ring would not be.
   *
   * It exists because the raw byte tail is NOT text. A TUI repaint is
   * interleaved with cursor moves and charset escapes, so a phrase plainly on
   * screen arrives as `C\x1b(Bo\x1b(Bm\x1b(Bp…` spliced through a second,
   * overlapping repaint — measured on claude 2.1.267 during a `/compact`, where
   * "Compacting conversation…" was on screen for two minutes and matched
   * nothing in the bytes. The grid has one copy of each character, in order.
   */
  gridText(rows = 0): string {
    if (this.disposed) return "";
    try {
      const buf = this.term.buffer.active;
      const take = rows > 0 ? Math.min(rows, this.term.rows) : this.term.rows;
      const from = buf.viewportY + this.term.rows - take;
      const out: string[] = [];
      for (let i = from; i < buf.viewportY + this.term.rows; i++) {
        const line = buf.getLine(i);
        out.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
      }
      return out.join("\n");
    } catch { return ""; }   // a read that throws costs one sample, never the session
  }

  /**
   * The same grid WITH attributes (`render.ts`'s `RenderRow`), last `rows` rows.
   *
   * Why the readers that decide a delivery ask this rather than a replay of the
   * byte ring: the ring carries no record of a resize. A phone's keyboard
   * opening and closing reshapes the pane all session long — measured on one
   * session: scroll regions `1;13r` through `1;45r` in a single ring — and a
   * replay into ONE fixed 50-row VT applies every one of those repaints to the
   * wrong grid. The live composer came back with its closing rule overdrawn by
   * the mode row (`──⏵⏵ auto mode on …───`), read as text someone had typed,
   * and every send to that session was refused as "the input box already holds
   * text" while the real box was empty. This VT is resized in step
   * (`drive.ts`'s `resize`), so its grid is the pane's.
   */
  gridCells(rows = 0): RenderRow[] {
    if (this.disposed) return [];
    try {
      const top = this.term.buffer.active.viewportY;
      const take = rows > 0 ? Math.min(rows, this.term.rows) : this.term.rows;
      return cellRows(this.term, top + this.term.rows - take, top + this.term.rows);
    } catch { return []; }
  }

  /** Is the program drawing in the ALTERNATE screen? Only there is the grid
   *  the whole truth — a normal-buffer program (a shell) has scrollback this
   *  VT does not keep, and its readers still need the replay. */
  alternate(): boolean {
    if (this.disposed) return false;
    try { return this.term.buffer.active.type === "alternate"; } catch { return false; }
  }

  /** A SIGWINCH reshapes the grid, so the VT has to follow or every line wraps
   *  at the wrong column and nothing anchors against what came before. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try { this.term.resize(Math.max(20, cols || 80), Math.max(4, rows || 24)); } catch { /* best-effort */ }
  }

  /** Everything readable, oldest first: what scrolled away, then what is on
   *  screen. Reads the grid first, so a caller never sees a stale tail. */
  lines(): string[] {
    this.absorb();
    return screenLogLines(this.state);
  }

  /** Has anything beyond the visible grid been recorded? The difference
   *  between "here is the history" and "here is the screen, there is no
   *  history yet" — two different sentences on the phone. */
  hasHistory(): boolean {
    return this.state.archived.length > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.term.dispose(); } catch { /* already gone */ }
  }

  private arm(delayMs: number): void {
    const due = Date.now() + delayMs;
    if (this.timer && this.dueAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => { this.timer = null; this.absorb(); }, delayMs);
    this.timer.unref?.();
  }

  /** Read the grid and fold it in. Idempotent: `absorbScreen` returns the SAME
   *  state when nothing moved, so a read that races a caller costs nothing. */
  private absorb(): void {
    if (this.disposed || !this.dirty) return;
    this.dirty = false;
    this.lastReadAt = Date.now();
    try {
      const buf = this.term.buffer.active;
      const grid: string[] = [];
      for (let i = buf.viewportY; i < buf.viewportY + this.term.rows; i++) {
        const line = buf.getLine(i);
        grid.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
      }
      this.state = absorbScreen(this.state, grid, SCREENLOG_MAX_LINES);
    } catch { /* a read that throws costs one sample, never the session */ }
  }
}
