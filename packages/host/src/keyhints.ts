/**
 * The shortcuts claude's TUI tells a person to press, read off the RENDERED
 * screen (`screenlog.ts`'s `gridText()`), for the phone's key row
 * (`SessionInfo.keyHints`, `shared/keyhint.ts`).
 *
 * Measured on claude 2.1.293 (`test/fixtures/permmode/`):
 *
 *   ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents       footer
 *   Enter to set as default · s to use this session only · Esc to cancel   /model
 *   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel   /effort
 *
 * Where it reads, and nowhere else:
 *
 * - With a composer on screen: the footer under the NEWEST composer frame
 *   (`permmode.ts`'s `composerFrame`, the same ≤6-row footer). The transcript
 *   above it is never read — a turn that QUOTES a hint is not the CLI offering
 *   one.
 * - With no composer (a picker or a box replaced it): the screen's last
 *   non-blank rows, where every picker draws its key line.
 *
 * A hint is a ` · `-separated segment of one of those rows: `<key> to|for
 * <verb>`, the key at the segment start or just inside a `(`. Only keys the
 * phone's row lacks count (`keyHintBytes`). A bare letter is accepted only in
 * a row that carries at least one other hint — the shape of a key line, never
 * of a sentence that happens to start "a to …". A verb cut by the grid's
 * width (`…`) is dropped rather than shown half-read.
 *
 * A key line WRAPPED by a narrow grid (the CLI wraps a picker's line rather
 * than eliding it: `… · s to use this` / `session only · Esc to cancel`)
 * would read as a half verb with no `…` — so the last hint on a row is
 * dropped when the next scanned row starts with words that are not a hint.
 *
 * The footer scan includes the person's own status line (`[CAVEMAN]` in the
 * fixtures): a status line that prints `x to … · y to …` becomes chips. Kept
 * on purpose — the footer cannot tell whose row it is, and such a line is
 * offering those keys.
 *
 * Degrades to an empty list, never to a key the screen did not name.
 */
import { KEY_HINT_MAX, keyHintBytes, type KeyHint } from "@waterplane/shared";
import { composerFrame } from "./permmode.js";

/** Rows under the composer that can still be its footer (`permmode.ts`'s). */
const MAX_FOOTER_ROWS = 6;
/** Rows from the bottom a picker's key line can sit in. */
const PICKER_ROWS = 3;

const SEGMENT_SPLIT = /\s+·\s+/;
/** Any `key to|for verb` — used to count a row's hints, whatever the key. */
const ANY_HINT_RE = /(?:^|\()\s*(\S+)\s+(?:to|for)\s+[a-z]/i;
/** The key, then the verb up to the segment's end or the closing `)`. */
const HINT_RE = /(?:^|\()\s*(shift\+tab|ctrl\+[a-z]|[a-z0-9])\s+(?:to|for)\s+([a-z][^()]*?)\s*(?:\)|$)/i;

/** Words that continue the row above: a lower-case start that is not itself
 *  a hint (`session only · Esc to cancel`). */
function continuesAbove(row: string): boolean {
  const first = row.trim().split(SEGMENT_SPLIT)[0];
  return /^[a-z]/.test(first) && !ANY_HINT_RE.test(first);
}

/** A row's hints, and whether the last one came from the row's last segment
 *  (the one a wrap would have cut). */
function rowHints(row: string): { hints: KeyHint[]; lastAtEnd: boolean } {
  const segs = row.trim().split(SEGMENT_SPLIT);
  const keyLine = segs.filter((s) => ANY_HINT_RE.test(s)).length >= 2;
  const out: KeyHint[] = [];
  let lastAtEnd = false;
  for (const [i, seg] of segs.entries()) {
    // A hint inside parentheses rides after the label it belongs to.
    const at = seg.indexOf("(");
    const m = HINT_RE.exec(at > 0 ? seg.slice(at) : seg);
    if (!m) continue;
    const raw = m[1];
    const key = raw.toLowerCase();
    const bare = key.length === 1;
    // A bare key is drawn lower case by the CLI (`s for …`); a capital is a word.
    if (bare && (raw !== key || !keyLine)) continue;
    if (!keyHintBytes(key)) continue;
    const verb = m[2].trim();
    if (!verb || verb.includes("…")) continue;
    out.push({ key, verb });
    lastAtEnd = i === segs.length - 1 && !seg.trimEnd().endsWith(")");
  }
  return { hints: out, lastAtEnd };
}

/**
 * The hinted keys on a rendered grid, newest row last, deduplicated by key,
 * at most `KEY_HINT_MAX`. `screen` is rows joined by `\n`.
 */
export function readKeyHints(screen: string): KeyHint[] {
  const rows = screen.split("\n");
  const frame = composerFrame(rows);
  let scan: string[];
  if (frame) {
    scan = rows.slice(frame.bottom + 1).filter((r) => r.trim());
    if (scan.length > MAX_FOOTER_ROWS) return [];
  } else {
    scan = rows.filter((r) => r.trim()).slice(-PICKER_ROWS);
  }
  const seen = new Set<string>();
  const out: KeyHint[] = [];
  for (const [i, row] of scan.entries()) {
    const { hints, lastAtEnd } = rowHints(row);
    if (lastAtEnd && i + 1 < scan.length && continuesAbove(scan[i + 1])) hints.pop();
    for (const h of hints) {
      if (seen.has(h.key)) continue;
      seen.add(h.key);
      out.push(h);
    }
  }
  return out.slice(0, KEY_HINT_MAX);
}
