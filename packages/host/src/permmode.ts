/**
 * The permission mode and the ultracode switch, read off the claude TUI's
 * RENDERED screen (`screenlog.ts`'s `gridText()`).
 *
 * The CLI draws its mode on the row under the composer box, and it moves with
 * a shift+tab typed anywhere — at the desk, from the phone, by a box's "Yes,
 * and switch to auto mode". So the screen is the one place that knows the mode
 * NOW; `SessionInfo.permissionMode` is only what the session was LAUNCHED with.
 *
 * Measured on claude 2.1.293 (`packages/host/test/fixtures/permmode/`, real
 * `capture-pane` grids at 100, 46 and 28 columns):
 *
 *   ⏵⏵ accept edits on (shift+tab to cycle)        acceptEdits
 *   ⏸ plan mode on (shift+tab to cycle)            plan
 *   ⏵⏵ auto mode on (shift+tab to cycle)           auto
 *   ⏵⏵ bypass permissions on (shift+tab to cycle)  bypassPermissions
 *   ⏵⏵ don't ask on (shift+tab to cycle)           dontAsk
 *   ⏸ manual mode on                               default
 *
 * The default mode HAS a label on this binary ("manual") wherever auto mode
 * is available. An older binary, or an account without auto mode, draws NO
 * label and its idle footer says `? for shortcuts` — so "no label" reads as
 * `default` only beside that positive evidence. A footer with no label and no
 * such hint is a transient message, a slash-command menu or a half-drawn
 * frame, and that is "cannot tell", never `default`.
 *
 * The cycle from the measured runs: auto → manual → accept edits → plan → auto;
 * `bypassPermissions` sits between plan and auto only when launched with it,
 * and `dontAsk` is reachable only as the launch mode (the first shift+tab
 * leaves it for good).
 *
 * Structural, like `echo.ts`'s composer anchor: the label is read ONLY on the
 * rows under the newest composer frame (a full-width rule, a `❯` row adjacent
 * under it, the rule that closes it), never anywhere on the screen. A choice
 * box replaces the composer, so a box on screen reads as null — which is the
 * honest answer, since the box may itself be about to change the mode.
 *
 * Degrades to null, never to a wrong mode.
 */
import type { PermissionMode } from "@waterplane/shared";

/** A full-width rule with nothing in it: the composer's closing border. Same
 *  shape as `echo.ts`'s `COMPOSER_RULE_RE`, held here so a reader of the
 *  footer cannot drift with a change made for delivery. */
const PLAIN_RULE_RE = /^[─━]{20,}$/;

/**
 * The composer's OPENING border, which may carry a label at its right end:
 * `──────── ultracode ─` (2.1.293, ultracode on). `echo.ts`'s composer anchor
 * does not accept this shape — this one must, or turning ultracode on would
 * blind the mode reader.
 */
const TOP_RULE_RE = /^[─━]{4,}(?:\s+(\S(?:.*\S)?)\s+[─━]{1,4})?$/;

/** The composer's input row: `❯` first. A `❯` drawn by a picker or a choice
 *  box never has a rule directly above it, which is what keeps them out. */
const CURSOR_RE = /^❯(?:[\s ]|$)/;

/** A composer taller than this is not one we can place. */
const MAX_COMPOSER_ROWS = 30;
/** The footer under the composer: a status line or two plus the mode row.
 *  More rows than this is something else drawn under the box (a slash
 *  menu, a stale frame) — no reading. */
const MAX_FOOTER_ROWS = 6;

/**
 * The mode row: a mode glyph, the words, ` on`, then the hint / separator /
 * the end. Anchored at the row start so a status line that merely SAYS
 * "plan mode on" in its text is not a mode.
 */
const MODE_ROW_RE = /^\s*(?:⏵⏵|⏵|⏸)\s+(accept edits|plan mode|auto mode|bypass permissions|don['’]t ask|manual mode) on(?=$|\s|\W)/;

const MODE_OF: Record<string, PermissionMode> = {
  "accept edits": "acceptEdits",
  "plan mode": "plan",
  "auto mode": "auto",
  "bypass permissions": "bypassPermissions",
  "don't ask": "dontAsk",
  "don’t ask": "dontAsk",
  "manual mode": "default",
};

/** The idle footer's key hint — positive evidence that a label-less footer is
 *  the default mode's, on a binary that does not label it. */
const SHORTCUTS_HINT_RE = /\?\s*for shortcuts/;

/** Where the newest composer frame sits on a grid, and what its borders say. */
export interface ComposerFrame {
  /** Row index of the opening rule. */
  top: number;
  /** Row index of the closing rule. */
  bottom: number;
  /** The opening rule's label (`ultracode`), absent when the rule is plain. */
  label?: string;
}

/**
 * The newest (lowest) composer frame on a rendered grid, or null.
 *
 * Scanned from the bottom: a plain rule, the rows above it up to the next
 * rule (no blank row — a composer has no gaps), the first of them a `❯` row,
 * and the rule above THAT one a composer top. The lowest such frame is the
 * live one; a past prompt in the transcript has a blank row above it, never a
 * rule, so it can never close a frame.
 */
export function composerFrame(rows: readonly string[]): ComposerFrame | null {
  for (let b = rows.length - 1; b > 0; b--) {
    if (!PLAIN_RULE_RE.test(rows[b].trim())) continue;
    let t = b - 1;
    while (t >= 0 && b - t <= MAX_COMPOSER_ROWS + 1) {
      const row = rows[t].trim();
      if (!row) { t = -1; break; }
      if (TOP_RULE_RE.test(row)) break;
      t--;
    }
    if (t < 0 || b - t < 2 || b - t > MAX_COMPOSER_ROWS + 1) continue;
    if (!CURSOR_RE.test(rows[t + 1].trimStart())) continue;
    const m = TOP_RULE_RE.exec(rows[t].trim());
    return { top: t, bottom: b, ...(m?.[1] ? { label: m[1] } : {}) };
  }
  return null;
}

/**
 * The permission mode the footer shows, or null when it cannot be told.
 *
 * `screen` is the RENDERED grid (rows joined by `\n`), never a stripped byte
 * tail: a repaint splices escapes through the words.
 */
export function readPermMode(screen: string): PermissionMode | null {
  const rows = screen.split("\n");
  const frame = composerFrame(rows);
  if (!frame) return null;
  const footer = rows.slice(frame.bottom + 1).filter((r) => r.trim());
  if (footer.length > MAX_FOOTER_ROWS) return null;
  const seen = new Set<PermissionMode>();
  for (const row of footer) {
    const m = MODE_ROW_RE.exec(row);
    if (m) seen.add(MODE_OF[m[1]]);
  }
  if (seen.size === 1) return [...seen][0];
  if (seen.size > 1) return null;   // two mode rows: a torn frame, not a mode
  return footer.some((r) => SHORTCUTS_HINT_RE.test(r)) ? "default" : null;
}

/** The words a person reads for a mode — the CLI's own label, not the enum. */
export function permModeWords(mode: PermissionMode): string {
  switch (mode) {
    case "default": return "manual";
    case "acceptEdits": return "accept edits";
    case "plan": return "plan";
    case "auto": return "auto";
    case "bypassPermissions": return "bypass permissions";
    case "dontAsk": return "don't ask";
  }
}

// ── ultracode ────────────────────────────────────────────────────────────────

/** `/effort ultracode on` (or the effort picker's Tab, then `s`) prints this
 *  under the command. The wrapped form at a narrow width leaves `(this` on the
 *  same row; a row ending at `on` is accepted only when the next row opens
 *  with it. The model picker's `· Ultracode on (/effort)` and the effort
 *  picker's `Ultracode  on` are mid-row, so the row anchor keeps them out. */
const UC_ON_RE = /^\s*(?:⎿\s+)?Ultracode on(?:\s+\(this\b|\s*$)/;
const UC_ON_WRAP_RE = /^\s*\(this\b/;
/** `Ultracode off. Effort stays high.` */
const UC_OFF_RE = /^\s*(?:⎿\s+)?Ultracode off(?:\.|\s*$)/;
/** The CLI refusing to turn it on — it is therefore not on. */
const UC_REFUSED_RE = /^\s*(?:⎿\s+)?Ultracode (?:needs dynamic workflows|isn['’]t available on)\b/;

/** What one screen says about ultracode, before any memory is applied. */
export interface UltracodeReading {
  /**
   * The composer's opening rule: `label` when it names ultracode (2.1.293
   * draws `──── ultracode ─` for as long as it is on), `plain` when the rule is
   * bare, null when no composer is on screen or it carries another label.
   */
  border: "label" | "plain" | null;
  /** The NEWEST confirmation or refusal line on screen: on, off, or none. */
  line: boolean | null;
}

export function readUltracode(screen: string): UltracodeReading {
  const rows = screen.split("\n");
  const frame = composerFrame(rows);
  const border: UltracodeReading["border"] = !frame ? null
    : frame.label === undefined ? "plain"
    : /\bultracode\b/i.test(frame.label) ? "label" : null;
  let line: boolean | null = null;
  const end = frame ? frame.top : rows.length;
  for (let i = end - 1; i >= 0 && line === null; i--) {
    const row = rows[i];
    if (UC_OFF_RE.test(row) || UC_REFUSED_RE.test(row)) line = false;
    else if (UC_ON_RE.test(row)) {
      const wrapped = /Ultracode on\s*$/.test(row);
      if (!wrapped || UC_ON_WRAP_RE.test(rows[i + 1] ?? "")) line = true;
    }
  }
  return { border, line };
}

/**
 * Ultracode as the CLI last showed it, or null for "this screen says nothing".
 *
 * `labelSeen` is whether this session's composer has EVER worn the label: on
 * a binary that draws it, a bare rule is then the CLI saying "off" — the
 * strongest evidence there is, because it is drawn from the live state rather
 * than printed once and scrolled away. On a binary that never drew one, a bare
 * rule says nothing, and the newest printed line decides.
 */
export function ultracodeVerdict(r: UltracodeReading, labelSeen: boolean): boolean | null {
  if (r.border === "label") return true;
  if (r.border === "plain" && labelSeen) return false;
  return r.line;
}
