/**
 * The tmux client's terminal queries, answered HERE — so a session behaves the
 * same whether or not a phone is attached.
 *
 * The PTY the host holds runs a tmux CLIENT, and a client starting up asks its
 * outer terminal who it is (measured, tmux 3.6b, with the host's own
 * generated tmux.conf): DA1 `ESC[c`, DA2 `ESC[>c`, XTVERSION `ESC[>q`, the
 * OSC 10/11 foreground/background colours, the colour scheme `ESC[?996n` and
 * the text area in pixels and in cells (`ESC[14t`, `ESC[18t`; asked again on
 * every resize). Nothing answered ⇒ for ~5.15 s tmux holds a lone Esc typed
 * into the window (it could be the start of a reply), then gives up and
 * repaints the whole pane. A phone's xterm.js answered SOME of them as session
 * input, which made the timing depend on whether anybody was watching —
 * scheduled, backlog, fan-out and resumed sessions run with the phone off.
 *
 * So the host answers all eight, the moment it sees them, by writing the reply
 * to the PTY — and STRIPS them from the stream before any consumer (scrollback,
 * the screen recorder, echo/settle, the phones), so no xterm.js ever answers a
 * second time: a reply nobody asked for would be typed into the pane. Every
 * other byte goes through untouched.
 *
 * The values are what an xterm.js would say, from facts the host owns:
 *  - DA1 `ESC[?1;2c` and DA2 `ESC[>0;276;0c` — xterm.js 6's own answers.
 *  - XTVERSION `ESC P>|xterm.js(6.0.0) ESC\` — xterm.js does not answer this
 *    one; the name is the phone's terminal, so tmux files no feature it lacks.
 *  - OSC 10/11 — `shared/termpalette.ts`'s DARK theme, 16 bits per channel,
 *    with the terminator the query used. The theme a phone picked is a
 *    per-DEVICE preference that never reaches the host (`shared/settings.ts`),
 *    and a session nobody watches has no device at all, so dark it is — the
 *    app's default and the system default when the OS will not say.
 *  - `?996n` → `ESC[?997;1n` (1 = dark), agreeing with the colours.
 *  - 18t → `ESC[8;<rows>;<cols>t` off the PTY's REAL geometry, read at the
 *    moment of asking; 14t → `ESC[4;<h>;<w>t` as cells × a nominal cell of
 *    `CELL_PX` (a ~15px monospace face). Nothing here draws pixels; tmux only
 *    uses it to scale images, and a fixed cell is honest about that.
 *
 * Answered in the ORDER asked: measured, a 14t reply written before the 18t
 * reply tmux asked for first is not consumed and the 18t reply leaks into the
 * pane as typed text.
 *
 * What is NOT intercepted: a program inside the pane asking (the claude CLI
 * asks OSC 11 for its background) talks to tmux, and tmux answers it from what
 * it learned here — measured, the pane now gets `rgb:0b0b/0d0d/1010` where it
 * used to get nothing before tmux's timeout. Those queries never reach the
 * client's output. A pane program that WRAPS a query in tmux passthrough does
 * reach it, byte-identical to tmux's own; it is answered like one, and the
 * reply lands in tmux's input exactly where a phone's reply always landed.
 *
 * A chunk may end part-way into a query: the possible prefix (≤ 9 bytes) is
 * held for the next chunk and released by `flush()` if none comes (the caller's
 * short timer), so a held tail is never stranded.
 */
import { TERM_COLORS, type TermColors } from "@waterplane/shared";

/** Nominal pixel cell for the 14t answer. */
export const CELL_PX = { w: 9, h: 18 } as const;

/** What an answer is made of, read at the moment the query is answered. */
export interface QueryFacts {
  cols(): number;
  rows(): number;
  colors?(): TermColors;
}

const ESC = "\x1b";
const ST = `${ESC}\\`;

type Kind = "da1" | "da2" | "xtversion" | "fg" | "bg" | "scheme" | "px" | "cells";

/** Every byte-exact query this answers, with its kind. Parameterless forms and
 *  the explicit `0` forms both appear in the wild; the OSCs come with either
 *  terminator and the reply mirrors it. */
const FORMS: ReadonlyArray<readonly [string, Kind]> = [
  [`${ESC}[c`, "da1"], [`${ESC}[0c`, "da1"],
  [`${ESC}[>c`, "da2"], [`${ESC}[>0c`, "da2"],
  [`${ESC}[>q`, "xtversion"], [`${ESC}[>0q`, "xtversion"],
  [`${ESC}]10;?${ST}`, "fg"], [`${ESC}]10;?\x07`, "fg"],
  [`${ESC}]11;?${ST}`, "bg"], [`${ESC}]11;?\x07`, "bg"],
  [`${ESC}[?996n`, "scheme"],
  [`${ESC}[14t`, "px"],
  [`${ESC}[18t`, "cells"],
];

/** `#rrggbb` → `rgb:rrrr/gggg/bbbb`, the X11 form xterm.js answers with. */
export function x11Rgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const [r, g, b] = m ? [m[1], m[2], m[3]] : ["00", "00", "00"];
  const ch = (h: string) => (h + h).toLowerCase();
  return `rgb:${ch(r)}/${ch(g)}/${ch(b)}`;
}

function answer(kind: Kind, form: string, facts: QueryFacts): string {
  const term = form.endsWith("\x07") ? "\x07" : ST;
  const colors = facts.colors?.() ?? TERM_COLORS.dark;
  switch (kind) {
    case "da1": return `${ESC}[?1;2c`;
    case "da2": return `${ESC}[>0;276;0c`;
    case "xtversion": return `${ESC}P>|xterm.js(6.0.0)${ST}`;
    case "fg": return `${ESC}]10;${x11Rgb(colors.foreground)}${term}`;
    case "bg": return `${ESC}]11;${x11Rgb(colors.background)}${term}`;
    case "scheme": return `${ESC}[?997;${colors === TERM_COLORS.light ? 2 : 1}n`;
    case "px": return `${ESC}[4;${facts.rows() * CELL_PX.h};${facts.cols() * CELL_PX.w}t`;
    case "cells": return `${ESC}[8;${facts.rows()};${facts.cols()}t`;
  }
}

/** Is `s` (starting at an ESC) a strict prefix of some query — i.e. could the
 *  next chunk complete it? */
function couldBecomeQuery(s: string): boolean {
  return FORMS.some(([f]) => f.length > s.length && f.startsWith(s));
}

export interface Fed {
  /** The stream with every query removed — what every consumer reads. */
  out: string;
  /** The answers, concatenated in the order asked — written to the PTY. */
  replies: string;
}

export class TermQueryResponder {
  private held = "";
  constructor(private readonly facts: QueryFacts) {}

  /** True while a possible query prefix waits for the next chunk. */
  holding(): boolean { return this.held.length > 0; }

  /** Release a held tail that no chunk completed. */
  flush(): string { const h = this.held; this.held = ""; return h; }

  feed(chunk: string): Fed {
    const s = this.held + chunk;
    this.held = "";
    if (!s.includes(ESC)) return { out: s, replies: "" };
    let out = "";
    let replies = "";
    let from = 0;
    let i = s.indexOf(ESC);
    while (i !== -1) {
      const hit = FORMS.find(([f]) => s.startsWith(f, i));
      if (hit) {
        out += s.slice(from, i);
        replies += answer(hit[1], hit[0], this.facts);
        from = i + hit[0].length;
        i = s.indexOf(ESC, from);
        continue;
      }
      // At the very end and possibly a query cut in half: hold it.
      const rest = s.slice(i);
      if (rest.length < 10 && couldBecomeQuery(rest)) {
        out += s.slice(from, i);
        this.held = rest;
        return { out, replies };
      }
      i = s.indexOf(ESC, i + 1);
    }
    out += s.slice(from);
    return { out, replies };
  }
}

/** How long a possible query prefix may wait for the chunk that completes it. */
export const HOLD_MS = 25;

/** The slice of node-pty's `IPty` this needs. */
export interface QueryPty {
  readonly cols: number;
  readonly rows: number;
  onData(cb: (chunk: string) => void): unknown;
  write(data: string): void;
}

/**
 * Put the responder IN FRONT of a PTY's data handler: `onChunk` sees the
 * stream with every query removed, and the replies go straight back into the
 * PTY. The ONE place a tmux client's output enters the host (`sessions.ts`'s
 * `register`), so no consumer can see a query and none can be skipped.
 */
export function answerTermQueries(proc: QueryPty, onChunk: (chunk: string) => void, facts?: Partial<QueryFacts>): { dispose(): void } {
  const responder = new TermQueryResponder({ cols: () => proc.cols, rows: () => proc.rows, ...facts });
  let timer: ReturnType<typeof setTimeout> | null = null;
  proc.onData((raw) => {
    if (timer) { clearTimeout(timer); timer = null; }
    const { out, replies } = responder.feed(raw);
    if (replies) { try { proc.write(replies); } catch { /* exited */ } }
    if (out) onChunk(out);
    if (responder.holding()) {
      timer = setTimeout(() => { timer = null; const t = responder.flush(); if (t) onChunk(t); }, HOLD_MS);
    }
  });
  // Disposed on exit: only the timer goes (a chunk node-pty hands over after
  // the exit event is still delivered, as it always was).
  return { dispose() { if (timer) { clearTimeout(timer); timer = null; } } };
}
