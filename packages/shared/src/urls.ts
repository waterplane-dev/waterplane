/**
 * A URL that a TERMINAL broke into pieces, put back together.
 *
 * A grid has no soft wrap. When the CLI prints a URL longer than the row — an
 * OAuth authorize link is 300+ characters — the screen holds it as five or six
 * separate rows with nothing marking them as one thing, and every consumer that
 * reads the screen as text therefore sees five or six fragments, none of which
 * is a link. That is why `/login` on the phone was a dead end: the one string
 * the whole flow turns on is on screen, in full, and cannot be tapped, copied
 * or even selected without hand-joining rows in a textarea.
 *
 * Rejoining is a guess, so it is a guess with EVIDENCE rather than a rule about
 * URL characters — "the next row also looks URL-ish" would swallow a file path
 * printed underneath a link. The evidence is the wrap itself: a row that was
 * broken by the grid is FULL, its continuation starts at the same column the
 * first row did, and every row of the run except the last has the same width.
 * A run that does not show that shape is not a wrapped URL, and we keep only
 * what was on the first row.
 *
 * Deliberately width-agnostic. The caller usually knows `cols`, but the CLI
 * also wraps inside its own box at some inset of its choosing, and a rule
 * anchored on the terminal width misses exactly the case this exists for. The
 * run's own geometry says what the wrap width was.
 */

/** Characters a URL may be made of (RFC 3986 unreserved + reserved + `%`). */
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** Where a URL starts. Only `http(s)` — the point is something tappable. */
const SCHEME = /https?:\/\//g;

/** Trailing punctuation a sentence put there, not the URL: "see https://x/y." */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** A wrapped row narrower than this is prose, not a grid break. */
const MIN_WRAP_WIDTH = 24;

export interface FoundUrl {
  /** The reassembled URL. */
  url: string;
  /** Index of the line the URL starts on (into the array passed in). */
  line: number;
  /** How many lines it spans. 1 = it fitted on its row. */
  lines: number;
  /**
   * The URL is known to go on past what was read: a glyph that is no URL
   * character was drawn INTO it with no space in front. That is the TUI
   * painting over the grid — claude's scroll indicator (`↓`/`↑`) lands two
   * columns from the right edge of a scrolled viewport, on top of whatever
   * character of the link was there — and everything from the glyph on is
   * either lost or off screen. `url` is then the longest prefix that is
   * certainly right, and is not a link anybody should open as it stands.
   */
  truncated?: boolean;
}

/** Everything after the last space on the line, from `from` — i.e. the URL as
 *  the row holds it, without whatever prose sits in front of it. */
function tailFrom(line: string, from: number): string {
  const rest = line.slice(from);
  const cut = rest.search(/\s/);
  return cut === -1 ? rest : rest.slice(0, cut);
}

/** Length of the run of URL characters `s` starts with. */
function urlPrefixLen(s: string): number {
  let n = 0;
  while (n < s.length && URL_CHARS.test(s[n])) n++;
  return n;
}

/** Leading-space count — a continuation row must start where the first one did. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Find every http(s) URL in a block of screen lines, rejoining the ones the
 * grid hard-wrapped.
 *
 * Lines are taken as rendered — trailing spaces are ignored, leading ones are
 * not (they are how a box's inset is recognised). Order is the order they
 * appear; duplicates are dropped, keeping the first.
 */
export function findUrls(lines: string[]): FoundUrl[] {
  const out: FoundUrl[] = [];
  const seen = new Set<string>();
  const rows = lines.map((l) => l.replace(/\s+$/, ""));

  for (let i = 0; i < rows.length; i++) {
    SCHEME.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SCHEME.exec(rows[i]))) {
      const at = m.index;
      const raw = tailFrom(rows[i], at);
      // A glyph that no URL is made of, with URL characters on BOTH sides of
      // it, was painted over the link. One that only closes it (`"`, `>`, `’`
      // at the end) is the prose around it, and the link ends there.
      const clean = urlPrefixLen(raw);
      const head = raw.slice(0, clean);
      let truncated = clean < raw.length - 1 && URL_CHARS.test(raw[clean + 1]);
      // A URL only wraps when it ran to the end of the row. Anything with room
      // to spare after it ended there.
      const wrapped = !truncated && at + head.length === rows[i].length;
      let url = head;
      let span = 1;
      if (wrapped) {
        // Collect the candidate run: flush-with-the-first-row, whitespace-free,
        // URL-shaped rows. Nothing is joined yet — the run has to prove it.
        const indent = indentOf(rows[i]);
        const width = rows[i].length;
        const run: string[] = [];
        // A FULL row that is URL characters up to a painted-over glyph: the
        // run goes on under it, and only its clean prefix can be kept.
        let overpainted: string | null = null;
        for (let j = i + 1; j < rows.length; j++) {
          const r = rows[j];
          if (indentOf(r) !== indent) break;
          const body = r.slice(indent);
          if (!body) break;
          // A row that STARTS something is not the continuation of something:
          // a second link printed underneath the first is the one shape that
          // otherwise passes every geometric test (it is flush, whitespace-free
          // and URL-charactered) and would silently be glued onto its neighbour.
          if (/https?:\/\//.test(body)) break;
          if (!URL_CHARS.test(body)) {
            const keep = urlPrefixLen(body);
            if (keep && !/\s/.test(body) && indent + body.length === width) overpainted = body.slice(0, keep);
            break;
          }
          run.push(body);
        }
        // The wrap signature: every row of the run except its last is exactly
        // as wide as the row the URL started on. One row that is short in the
        // middle means these are separate lines that merely look alike.
        if (width >= MIN_WRAP_WIDTH) {
          let take = 0;
          let short = false;
          for (let k = 0; k < run.length; k++) {
            short = indent + run[k].length !== width;
            take = k + 1;
            if (short) break; // a short row ends the URL
          }
          if (take) {
            url += run.slice(0, take).join("");
            span = 1 + take;
          }
          // Every row so far was full, so the over-painted one continues them.
          if (!short && take === run.length && overpainted !== null) {
            url += overpainted;
            span += 1;
            truncated = true;
          }
        }
      }
      if (!truncated) url = url.replace(TRAILING, "");
      if (url.length > m[0].length && !seen.has(url)) {
        seen.add(url);
        out.push(truncated ? { url, line: i, lines: span, truncated } : { url, line: i, lines: span });
      }
      // Continue scanning AFTER this URL's head — a row can carry two links.
      SCHEME.lastIndex = at + raw.length;
    }
  }
  return out;
}

/** `findUrls` over a plain block of text. */
export function findUrlsInText(text: string): FoundUrl[] {
  return findUrls(text.split("\n"));
}
