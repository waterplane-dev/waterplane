/**
 * A SHELL session's links and one-time codes, read off the rendered screen.
 *
 * `login.ts`'s sibling for the sessions that are not claude: a plain login
 * shell (`backends/shell.ts`, `caps.turns === false`) in which somebody runs
 * `gh auth login`, `gcloud auth login --no-launch-browser`, `npm login` … Each
 * prints a URL to open and, often, a short code to type into the page it opens
 * — and on a phone the URL is a dozen wrapped grid rows nobody can tap. So the
 * host lifts them off the grid (`@waterplane/shared`'s `findUrls`, which
 * rejoins a hard-wrapped link) and `sessions/links.ts` publishes them as
 * `SessionInfo.links`, which is what turns them into buttons.
 *
 * The rules, and why each is shaped the way it is:
 *
 *  - Every `https://` URL counts — a shell is not one CLI's flow, so there is
 *    no authorize-shaped path to insist on. A URL the TUI painted over
 *    (`truncated`) is dropped: half a link is a wrong answer, not a partial one.
 *    `http://` only for this desktop (`localhost`, 127.0.0.1, [::1]), flagged
 *    `local` so the phone says in words that it points at the desk. Newest
 *    last, one entry per URL, at most `MAX_SCREEN_LINKS`.
 *  - A code is ONLY ever a property of a link, within `CODE_ROWS` rows of it —
 *    a code-shaped token with no link near it is nothing (a ticket id, a
 *    branch). Device-flow shapes (`ABCD-1234`, `WDJB-MJHT`) count on their own;
 *    anything else (6–12 of `[A-Z0-9-]`) only right after a code label. Never a
 *    pure-hex run of 7+ (a commit SHA), never a token right after `$`, `pid` or
 *    `port` (a variable, a process, a listener). Each code attaches to the
 *    NEAREST link only.
 *  - A link read across SEVERAL rows (a box's flush run, the terminal's own
 *    hard wrap) is a guess about geometry until the PTY's bytes hold it as one
 *    string (`provenJoin`) — git's `remote:` and a bare `$` prompt both pass
 *    every geometric test. Unproven, the first row's URL stands only when that
 *    row is shorter than the pane; otherwise nothing.
 *  - Labelled codes are never an errno (`ECONNREFUSED`, `ENOENT-1`) and always
 *    carry a digit or a dash; a device shape always carries a letter
 *    (`0900-1700` is a time range).
 *  - `awaitingCode`: the last line on screen is a prompt for an authorization
 *    code ("…the authorization code:", "Paste … code …:"), i.e. the CLI is
 *    sitting on its input.
 *
 * The label and prompt patterns are built from split halves, the precaution
 * `login.ts` and `limit.ts` state: a detector that matches printed English
 * fires on a session merely DISPLAYING that English — and this repo greps its
 * own source often enough for that to be an event, not a hypothesis.
 *
 * Degrades to null on any throw: a reader that cannot read publishes no links,
 * never a wrong one.
 */
import { findUrls } from "@waterplane/shared";
import type { ShellLink } from "@waterplane/shared";
import { stripAnsi } from "./prompt.js";

/** Most screen links published at once; the newest win. */
export const MAX_SCREEN_LINKS = 3;
/** How far (in grid rows, either side of the URL's rows) a code may sit from its link. */
export const CODE_ROWS = 6;

/** What the screen says about one link. `source`/`at` are the publisher's (`sessions/links.ts`). */
export type ScreenLink = Omit<ShellLink, "source" | "at">;

export interface ShellLinksRead {
  links: ScreenLink[];
  /** The last line on screen is a prompt for an authorization code. */
  awaitingCode: boolean;
}

const LOCAL_HTTP_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/?#]|$)/i;

/** `XXXX-XXXX` device codes (gh, Microsoft, Google's device flow). */
const DEVICE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
/** `WDJB-MJHT`-style, letters only — subsumed by the above, named for the record. */
const DEVICE_ALPHA_RE = /^[A-Z]{4}-[A-Z]{4}$/;
/** A token a code LABEL vouches for. */
const LABELLED_RE = /^(?=[A-Z0-9-]*[A-Z0-9])[A-Z0-9-]{6,12}$/;
const HEX_RE = /^[0-9a-f]{7,}$/i;
/** An errno name (`ECONNREFUSED`, `ENOENT-1`) — what `code:` labels in a Node or npm error dump. */
const ERRNO_RE = /^E[A-Z]{3,}/;
/** A device code has a letter in it; `0900-1700` is a time range. */
const HAS_LETTER_RE = /[A-Z]/;

const C = "co" + "de";
/** "code:", "code is", "enter the code", "one-time code" — case-insensitive, built in halves. */
const LABEL_RE = new RegExp(
  String.raw`(?:\b${C}\s*:|\b${C}\s+is\b|\benter\s+the\s+${C}\b|\bone[-\s]time\s+${C}\b)\s*:?\s*`,
  "gi",
);
/** The code prompt at the end of the screen's last line: "…authorization code:", "paste … code …:". */
const AWAIT_RE = new RegExp(
  String.raw`(?:\bauthori[sz]ation\s+${C}\b|\bpaste\b[^\n]{0,40}\b${C}\b|\benter\b[^\n]{0,40}\b${C}\b)[^\n]{0,40}[:>❯][ \t]*$`,
  "i",
);
/** The word before a token that makes it a variable, a process or a listener. */
const NOT_A_CODE_BEFORE = /(?:\$|\b(?:pid|port)\s*[:=#]?)\s*$/i;

/** Punctuation a sentence wraps a token in. */
const strip = (w: string): string => w.replace(/^[("'`[<]+|[)"'`\]>.,;:!?]+$/g, "");

interface Candidate { row: number; code: string; labelled: boolean }

/** `ABCD-1234` / `WDJB-MJHT`, with at least one letter. */
const isDeviceShape = (code: string): boolean => (DEVICE_RE.test(code) || DEVICE_ALPHA_RE.test(code)) && HAS_LETTER_RE.test(code);

/**
 * What a label alone cannot vouch for. `code: 'ECONNREFUSED'` and `Error code:
 * ENOENT-1` are an error dump's errno beside whatever URL the stack printed,
 * and a one-time code always carries a digit or a dash — a labelled all-letter
 * word (`code: PENDING`) is prose. A device shape stands on its own rule.
 */
function labelledOk(code: string): boolean {
  if (isDeviceShape(code)) return true;
  if (ERRNO_RE.test(code)) return false;
  return /[0-9-]/.test(code);
}

function okToken(code: string, before: string): boolean {
  if (HEX_RE.test(code)) return false;
  if (NOT_A_CODE_BEFORE.test(before)) return false;
  return true;
}

/** Every code-shaped token on screen, with the row it is on. */
function candidates(rows: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    // Labelled: the token right after a label — on the same row, or the first
    // word of the next non-blank row when the label ends its own.
    LABEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LABEL_RE.exec(row))) {
      const rest = row.slice(m.index + m[0].length);
      let word = rest.trim().split(/\s+/)[0] ?? "";
      let at = r;
      if (!word || /^\(.*\)?$/.test(rest.trim())) {
        for (let n = r + 1; n < rows.length && n <= r + 2; n++) {
          const next = rows[n].trim();
          if (!next) continue;
          word = next.split(/\s+/)[0]; at = n; break;
        }
      }
      const code = strip(word);
      if (LABELLED_RE.test(code) && okToken(code, "") && labelledOk(code)) out.push({ row: at, code, labelled: true });
      if (m[0].length === 0) LABEL_RE.lastIndex++;
    }
    // Device-flow shapes stand on their own.
    for (const w of row.matchAll(/\S+/g)) {
      const code = strip(w[0]);
      if (!isDeviceShape(code)) continue;
      if (!okToken(code, row.slice(0, w.index))) continue;
      if (!out.some((c) => c.row === r && c.code === code)) out.push({ row: r, code, labelled: false });
    }
  }
  return out;
}

/** A whole row of URL characters, no whitespace, no scheme of its own. */
const URL_ROW_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * The TERMINAL's own hard wrap of an indented URL. `findUrls` rejoins a run
 * whose rows share the first row's inset — a box the CLI drew — but a shell
 * prints `    https://…` and the terminal continues it at column 0, so the
 * inset differs and the link came back cut (gcloud's, measured in
 * `e2e-shell.mjs`). With the pane's width known that wrap is provable: the
 * row the URL ends on is exactly `cols` wide, and the next one is URL
 * characters only. Keep joining while each joined row is full too.
 */
function hardWrapped(rows: string[], url: string, end: number, cols: number): { url: string; end: number } {
  while (rows[end]?.length === cols && url.endsWith(rows[end].slice(rows[end].lastIndexOf(" ") + 1))) {
    const next = rows[end + 1];
    if (!next || !URL_ROW_RE.test(next) || /https?:\/\//.test(next)) break;
    url += next;
    end++;
  }
  return { url, end };
}

/** One URL character — what a link that goes on is made of. */
const URL_CHAR_RE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
/** Punctuation a sentence closes a link with — dropped by `findUrls` (`TRAILING`). */
const TRAILING_RE = /[.,;:!?)\]}'"]+$/;
const TRAIL_CH_RE = /[.,;:!?)\]}'"]/;

/**
 * The PTY's bytes as proof text: every cursor move a line break (a repaint
 * that positions row by row never proves two rows are one string), then every
 * other escape and CR dropped. A program's own wrapped line arrives as one
 * unbroken run — tmux passes it through, and repaints a wrapped row the same
 * way — while two printed lines always have a newline between them.
 */
export function proofText(raw: string): string {
  return stripAnsi(raw.replace(/\x1b\[[0-9;]*[HfABEFdST]/g, "\n"));
}

/** `url` occurs in `text` and ENDS there: what follows (past a sentence's closing punctuation) is not a URL character. */
export function endsIn(text: string, url: string): boolean {
  for (let i = text.indexOf(url); i >= 0; i = text.indexOf(url, i + 1)) {
    let j = i + url.length;
    while (j < text.length && TRAIL_CH_RE.test(text[j]!)) j++;
    if (j >= text.length || !URL_CHAR_RE.test(text[j]!)) return true;
  }
  return false;
}

/**
 * A link read across SEVERAL rows is only as good as the bytes behind it. Two
 * geometric guesses glue a neighbour on: `findUrls`'s flush run takes git's
 * `remote:` under `…/pull/new/x` (one short row, same inset), and `hardWrapped`
 * takes a bare `$` prompt under a URL that happened to fill the row. So the
 * longest join of rows `line..end` whose text the program actually printed as
 * ONE string that ends there wins — the first row alone included — and none
 * proven is none (the caller decides about the first row).
 */
function provenJoin(rows: string[], line: number, end: number, full: string, proof: string): { url: string; end: number } | null {
  const first = /https?:\/\/\S*$/i.exec(rows[line] ?? "")?.[0];
  if (!first) return endsIn(proof, full) ? { url: full, end } : null;
  const pieces = [first, ...rows.slice(line + 1, end + 1).map((r) => r.trimStart())];
  for (let k = pieces.length; k >= 1; k--) {
    const cand = k === pieces.length ? full : pieces.slice(0, k).join("").replace(TRAILING_RE, "");
    if (cand.length > 8 && endsIn(proof, cand)) return { url: cand, end: line + k - 1 };
  }
  return null;
}

/**
 * Read a RENDERED screen (headless VT replay, rows joined by `\n`) for links,
 * their codes, and whether the CLI is waiting for a code. `cols` (the pane's
 * width) lets a URL the terminal itself hard-wrapped be rejoined
 * (`hardWrapped`). `raw` is the PTY's recent byte tail: a link joined across
 * rows is kept only when those bytes hold it as one string (`provenJoin`);
 * unproven, the first row's URL stands only when that row is SHORTER than the
 * pane — the URL visibly ended there — and otherwise the link is dropped. No
 * `raw` = nothing proven. Null when the read throws.
 */
export function detectShellLinks(screen: string, cols?: number, raw?: string): ShellLinksRead | null {
  try {
    const rows = screen.split("\n").map((r) => r.replace(/\s+$/, ""));
    const found: (ScreenLink & { line: number; end: number })[] = [];
    let proof: string | null = null;
    for (const h of findUrls(rows)) {
      if (h.truncated) continue;
      let { url, end } = cols ? hardWrapped(rows, h.url, h.line + h.lines - 1, cols) : { url: h.url, end: h.line + h.lines - 1 };
      if (end > h.line) {
        proof ??= proofText(raw ?? "");
        const pick = provenJoin(rows, h.line, end, url, proof);
        const first = /https?:\/\/\S*$/i.exec(rows[h.line] ?? "")?.[0]?.replace(TRAILING_RE, "");
        if (pick) ({ url, end } = pick);
        else if (cols && rows[h.line]!.length < cols && first) { url = first; end = h.line; }
        else continue;
      }
      const local = LOCAL_HTTP_RE.test(url);
      if (!local && !/^https:\/\//i.test(url)) continue;
      if (found.some((f) => f.url === url)) continue;
      found.push({ url, line: h.line, end, ...(local ? { local: true } : {}) });
    }
    found.sort((a, b) => a.line - b.line);
    const links = found.slice(-MAX_SCREEN_LINKS);
    // Each code goes to its nearest link; each link keeps its nearest code,
    // a labelled one winning a tie.
    const best = new Map<number, { dist: number; c: Candidate }>();
    if (links.length) {
      for (const c of candidates(rows)) {
        let pick = -1, dist = Infinity;
        links.forEach((l, i) => {
          const d = c.row < l.line ? l.line - c.row : c.row > l.end ? c.row - l.end : 0;
          if (d <= CODE_ROWS && d < dist) { dist = d; pick = i; }
        });
        if (pick < 0) continue;
        const cur = best.get(pick);
        if (!cur || dist < cur.dist || (dist === cur.dist && c.labelled && !cur.c.labelled)) best.set(pick, { dist, c });
      }
    }
    const last = [...rows].reverse().find((r) => r.trim()) ?? "";
    return {
      links: links.map((l, i) => {
        const code = best.get(i)?.c.code;
        return { url: l.url, line: l.line, ...(code ? { code } : {}), ...(l.local ? { local: true } : {}) };
      }),
      awaitingCode: AWAIT_RE.test(last),
    };
  } catch {
    return null;
  }
}
