/**
 * Scrolling the TUI back, when tmux is the substrate.
 *
 * The phone's pan becomes SGR mouse-wheel bytes (`web/Terminal.tsx`), on the
 * assumption that whatever is on the other end consumes them. Measured, nothing
 * does:
 *
 *   - the claude CLI enables NO mouse tracking. Spawned in a pty it emits
 *     `?25h/l`, `?2004h` (bracketed paste), `?1004h` (focus) and `?2031h`
 *     (theme notify) — no `?1000h`, no `?1006h`. Wheel bytes written to its
 *     stdin are parsed as an unknown escape sequence and dropped.
 *   - `.waterplane/tmux.conf` sets `mouse off`, whose comment said "pass mouse to
 *     claude" — the premise above.
 *
 * So the bytes went to a pty and died there, and because a tmux CLIENT puts the
 * OUTER terminal into the alternate buffer (`?1049h`), xterm's own scrollback
 * fallback (`term.scrollLines`, taken only in the normal buffer) never ran
 * either. Under tmux — every session's substrate — panning up did nothing at
 * all, in every session.
 *
 * tmux itself is the one thing here that HAS the history: `history-limit` is
 * 100000 lines. This translates the wheel into its copy-mode scroll commands.
 *
 * Deliberately not `set -g mouse on` instead: that also hands tmux click and
 * drag (pane select, selection start), which on a phone means a tap on the
 * screen starts selecting text in a pane the user cannot see the borders of.
 *
 * The hazard this module owns is the OTHER half: a pane in copy-mode does not
 * pass keystrokes to claude, it interprets them as copy-mode commands. Anything
 * that types must leave copy-mode first — hence `exitCopyMode`, and hence
 * `inCopyMode` being asked after every scroll rather than assumed (`copy-mode
 * -e` exits by itself when the scroll reaches the bottom).
 *
 * ── Both premises above went stale, and the gesture died with them ──────────
 *
 * Measured on claude 2.1.267 (2026-09-19), on every live pane of this desktop:
 *
 *     alt=1  mouse_any_flag=1  mouse_sgr_flag=1  history_size=0
 *
 * So the CLI now (a) asks for the mouse itself (`?1003h` + `?1006h`) and (b)
 * runs in the ALTERNATE screen. Each half breaks one premise:
 *
 *   - the wheel is no longer undeliverable: the pane wants those exact bytes.
 *   - a pane in the alternate screen has NO history (`history_size=0` above —
 *     tmux swaps the grid, `history-limit` describes the one it swapped out),
 *     so `copy-mode` + `scroll-up` moves nothing at all.
 *
 * i.e. this module's translation turned a gesture the CLI would have handled
 * into a tmux command that could not. Panning up did nothing, in every session,
 * which is the same symptom this file was written to fix — from the other end.
 * Hence `paneWantsMouse`: where the pane asks for the mouse, the bytes are
 * PASSED THROUGH (`sessions/drive.ts` writes them to the tmux client, which forwards
 * them to the pane verbatim — measured, with `mouse off` still set); the
 * translation stays for a pane that does not, which is still every shell and
 * every older CLI.
 *
 * Read the pane, never the version: "does this program want the mouse" is the
 * fact the routing turns on, and it is one tmux query away. A version check
 * would be a guess about a binary that moves weekly.
 */
import { execFile, execFileSync } from "node:child_process";

/** One SGR wheel report: `ESC [ < 64 ; col ; row M` (64 = up, 65 = down). */
const WHEEL_ONE = /\x1b\[<(64|65);\d+;\d+M/y;

/**
 * A pan, as the client sends it: N identical wheel reports in ONE write
 * (`sendWheel` collapses a flick into a single `session.input`).
 *
 * Strict on purpose. A mixed or padded write is left to the ordinary path: a
 * scroll is a convenience and mis-reading one costs a keystroke into a live
 * TUI, which is the expensive direction.
 */
export function parseWheel(data: string): { dir: "up" | "down"; n: number } | null {
  if (!data.startsWith("\x1b[<")) return null;
  let at = 0, n = 0, dir: "up" | "down" | null = null;
  for (;;) {
    WHEEL_ONE.lastIndex = at;
    const m = WHEEL_ONE.exec(data);
    if (!m || m.index !== at) break;
    const d = m[1] === "64" ? "up" : "down";
    if (dir && d !== dir) return null;   // a flick that reversed mid-write: not ours
    dir = d;
    n++;
    at = WHEEL_ONE.lastIndex;
  }
  if (!dir || at !== data.length) return null;
  return { dir, n };
}

/** Is the pane in a mode (copy-mode, view-mode)? Sync: one cheap tmux query. */
export function inCopyMode(server: string, target: string): boolean {
  try {
    const out = execFileSync("tmux", ["-L", server, "display-message", "-p", "-t", target, "#{pane_in_mode}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() === "1";
  } catch { return false; }
}

/**
 * The tmux format that answers "does the program in this pane want the mouse?".
 *
 * Three flags, because the modes are three: `?1000` (button), `?1002`/`?1003`
 * (any-motion) and the standard one. Any of them means wheel reports are
 * something the pane asked for.
 */
export const MOUSE_FLAGS_FMT = "#{mouse_any_flag}#{mouse_button_flag}#{mouse_standard_flag}";

/**
 * The pure half of the reading, so the rule is testable without a tmux server.
 *
 * Anything that is not a flag set to 1 — an empty string from a pane that went
 * away, an error, a format tmux does not know — reads as "no", which routes to
 * the translation this module has always done. Degrading to the old behaviour
 * is the cheap direction: a scroll that does nothing costs a gesture, and
 * bytes written into a pane that never asked for them cost a keystroke.
 */
export function wantsMouse(report: string): boolean {
  return report.trim().includes("1");
}

/** Ask tmux what the pane's own program has turned on. Sync: one cheap query,
 *  on the scroll path only (the typing path never asks). */
export function paneWantsMouse(server: string, target: string): boolean {
  try {
    const out = execFileSync("tmux", ["-L", server, "display-message", "-p", "-t", target, MOUSE_FLAGS_FMT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return wantsMouse(out);
  } catch { return false; }
}

/**
 * Leave copy-mode, so the next keystroke reaches claude and not the pager.
 *
 * Sync, and called on the typing path: it runs only when the session is BELIEVED
 * to be in copy-mode (a flag the scroll path sets), so the common send pays
 * nothing, and a stale belief costs one failed tmux call we ignore.
 */
export function exitCopyMode(server: string, target: string): void {
  try {
    execFileSync("tmux", ["-L", server, "send-keys", "-t", target, "-X", "cancel"], { stdio: "ignore" });
  } catch { /* not in a mode any more — that is the state we wanted */ }
}

/**
 * Scroll the pane's history by `n` lines and report whether it is STILL in
 * copy-mode afterwards.
 *
 * `copy-mode -e` is what makes a downward pan end the mode by itself at the
 * bottom, which is the only way this stays invisible: the user pans back down
 * and types, with nothing to dismiss.
 */
export function scroll(server: string, target: string, dir: "up" | "down", n: number): Promise<boolean> {
  const tmux = (args: string[]) => new Promise<void>((res) => {
    execFile("tmux", ["-L", server, ...args], () => res());
  });
  return (async () => {
    // Entering while already in copy-mode is a no-op, so it needs no query.
    // A downward pan never ENTERS one: there is nothing below the live screen.
    if (dir === "up") await tmux(["copy-mode", "-e", "-t", target]);
    await tmux(["send-keys", "-t", target, "-X", "-N", String(n), dir === "up" ? "scroll-up" : "scroll-down"]);
    return inCopyMode(server, target);
  })();
}
