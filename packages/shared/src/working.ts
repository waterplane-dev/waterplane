/**
 * The CLI's own working line, scraped out of the PTY tail.
 *
 * The reader has no terminal, so the one thing a person watching a long turn
 * wants — what the agent is doing RIGHT NOW and how much it has spent — exists
 * only in PTY frames the socket is already delivering. `App.tsx` keeps a 4 KB
 * per-session tail for exactly this; scraping it costs no host traffic.
 *
 * **Shared because the HOST asks the same question, and both ends must answer
 * it the same way.** The phone reads this line to say what a turn is doing;
 * `sessions.ts` reads it to decide whether a `Stop` hook really ended the turn
 * (a Stop hook that blocks makes the CLI carry straight on, printing this line
 * the whole time). Two spinner matchers would be two opinions about whether a
 * session is working, and the interlock that keeps a queued prompt out of a
 * live turn hangs off the answer.
 *
 * This used to anchor on the literal "esc to interrupt", which the TUI once
 * printed inside the parenthetical. Measured against claude 2.1.236 in a 46-col
 * PTY (a phone) and a 100-col one, that hint is simply not there any more:
 *
 *     ✽ Bloviating… (2s · ↓ 125 tokens)
 *     ✳ Clauding… (9m 20s · ↓ 9.7k tokens)
 *
 * so the anchor matched nothing and the reader said "working · output appears
 * here as claude writes it" for nine minutes while the terminal two taps away
 * was counting seconds and tokens. The anchor is now the SHAPE — a gerund, an
 * ellipsis, and a parenthetical carrying a duration or a token count — which is
 * what the line has been in every version, hint or no hint.
 */

/** ANSI escapes, so a scraped line is text and not styling (`stripAnsi`). */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
const LINE_END = /[\n\r\u2028\u2029]/g;

/**
 * ANSI escapes removed, exactly as replacing every match of the regex
 * `/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[PX^_].*?\x1b\\|\x1b\][^\x07]*\x07/g` with ""
 * did, but as a scan. That regex was quadratic on PTY bytes (CodeQL
 * `js/polynomial-redos`): every unterminated `ESC P` / `ESC ]` re-scanned to the
 * end of its line or of the tail. Same removals: a CSI as before (sticky); a
 * DCS/SOS/PM/APC runs to the FIRST `ESC \` after it unless a line terminator
 * (what `.` will not cross) comes first; an OSC runs to the first BEL. The next
 * ST / BEL / line end is looked up once and reused while it still lies ahead,
 * so the whole scan is linear.
 */
export function stripAnsi(s: string): string {
  let out = "";
  let from = 0;
  // Next index at/after the point last looked up; -1 = none ahead; -2 = not looked up yet.
  let st = -2;
  let bel = -2;
  let eol = -2;
  const ahead = (cached: number, at: number, find: (at: number) => number): number =>
    cached === -1 || cached >= at ? cached : find(at);
  for (let i = s.indexOf("\x1b"); i >= 0; i = s.indexOf("\x1b", i)) {
    const c = s[i + 1];
    let end = -1;
    if (c === "[") {
      CSI.lastIndex = i;
      if (CSI.test(s)) end = CSI.lastIndex;
    } else if (c === "P" || c === "X" || c === "^" || c === "_") {
      st = ahead(st, i + 2, (at) => s.indexOf("\x1b\\", at));
      eol = ahead(eol, i + 2, (at) => {
        LINE_END.lastIndex = at;
        return LINE_END.exec(s)?.index ?? -1;
      });
      if (st >= 0 && (eol < 0 || eol > st)) end = st + 2;
    } else if (c === "]") {
      bel = ahead(bel, i + 2, (at) => s.indexOf("\x07", at));
      if (bel >= 0) end = bel + 1;
    }
    if (end < 0) {
      i++;
      continue;
    }
    out += s.slice(from, i);
    from = i = end;
  }
  return from === 0 ? s : out + s.slice(from);
}
/** "17s", "9m 20s", "450ms" — the elapsed field of the parenthetical. */
const DUR_RE = /^(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)\s*)+$/i;
/** Terminal affordances. The reader is not a terminal and has its own key bar,
 *  so they are dropped rather than spending phone width. */
const HINT_RE = /\b(?:esc|ctrl\+|shift\+|tab)\b/i;
/** The phrase the spinner cycles: always a gerund, always ellipsed. Taken as the
 *  LAST such word on the line because a partial TUI redraw leaves junk in front
 *  of it ("✽Bloviating…", "│ ✻ Vibing…").
 *
 *  Every match of `/([A-Za-z][A-Za-z'-]*ing)\s*(?:…|\.\.\.)/g`, group 1 only — as
 *  a scan, because that regex re-read a long word from each of its letters
 *  (CodeQL `js/polynomial-redos`). With `objects`, every match of the object
 *  form below. */
export function gerundPhrases(s: string, objects = false): string[] {
  const out: string[] = [];
  const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z'-]/.test(c);
  const isLetter = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  const wordEnd = (at: number) => { while (isWord(s[at])) at++; return at; };
  /** Index just past `\s*(?:…|\.\.\.)` at `at`, or -1. */
  const ellipsis = (at: number) => {
    while (isSpace(s[at])) at++;
    return s[at] === "…" ? at + 1 : s.startsWith("...", at) ? at + 3 : -1;
  };
  let i = 0;
  while (i < s.length) {
    if (!isWord(s[i])) { i++; continue; }
    // A run of word characters: a match can only start at its first letter and
    // its gerund can only end where the run does — what follows is never a word
    // character.
    const end = wordEnd(i);
    let start = i;
    while (start < end && !isLetter(s[start])) start++;
    let next = -1;
    let to = end;
    if (end - start >= 4 && s.endsWith("ing", end)) {
      if (!objects) next = ellipsis(end);
      else {
        for (let n = 0; n < 3 && next < 0; n++) {
          let k = to;
          while (isSpace(s[k])) k++;
          if (k === to || !isLetter(s[k])) break;
          to = wordEnd(k);
          next = ellipsis(to);
        }
      }
    }
    if (next < 0) { i = end; continue; }
    out.push(s.slice(start, to));
    i = next;
  }
  return out;
}
/**
 * The same shape with an OBJECT between the gerund and the ellipsis —
 * "Compacting conversation… (35s)", which is what `/compact` prints for however
 * many minutes it takes.
 *
 * Accepted ONLY when the line also carries a parenthetical with a duration or a
 * token count, and that condition is the whole design. Relaxed on its own it
 * matches the TUI's truncation ellipsis — "⚠ Transcript saving is off —
 * inherited CL…" would read as "working on: saving is off" — which is this app
 * inventing an activity, the failure `workingLine`'s doc names. A measured
 * parenthetical is what a spinner has and a truncated warning does not.
 *
 * Read by `gerundPhrases(s, true)`: every match of
 * `/([A-Za-z][A-Za-z'-]*ing(?:\s+[A-Za-z][A-Za-z'-]*){1,3})\s*(?:…|\.\.\.)/g`.
 */
/**
 * **The other measured thing, and for the first half-minute it is the ONLY one.**
 *
 * The parenthetical rule above was written off a compaction already under way.
 * Read off this desktop's own turn captures, the line the CLI actually draws
 * when one STARTS carries no parenthetical at all — the elapsed field only
 * appears once there is an elapsed worth printing:
 *
 *     Compacting conversation…
 *       ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 2%
 *
 *     Compacting conversation… (32s)
 *       ▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 30%
 *
 * Those first seconds are exactly the window a delivery watches, so "no
 * parenthetical" meant the reader said *idle — nothing running* over a starting
 * compaction and `deliver.ts` had nothing to rest a submit proof on. The
 * percentage row IS a measurement, and it is a stricter one than a duration:
 * a bar of block glyphs AND a percentage AND nothing else on the row. A
 * truncated warning does not grow one of those underneath it.
 *
 * `─` is deliberately not in the glyph class — the line cleaner above turns box
 * rules into spaces, so a rule would arrive here as whitespace and a row of
 * them must never read as progress.
 */
const PROGRESS_RE = /^[▰▱▬█▓░▒⣿⠿\s]*[▰▱▬█▓░▒⣿⠿]{4,}[\s]*(\d{1,3})\s?%$/;

/**
 * **A row of the CLI's background-agent TRAY, which is not the turn.**
 *
 * Under the composer, while background agents run, the CLI lists them — one
 * row per agent, its type, its own current activity, its elapsed and tokens:
 *     ⏺ main
 *     ◯ general-purpose  Investigating… 11m 17s · ↓ 159.4k tokens
 * That activity is very often a bare gerund with an ellipsis, which is exactly
 * the weak spinner shape below. Measured 2026-10-06: an orchestrator whose main
 * loop had ENDED sat at an idle composer for ten minutes while this row ticked
 * every second; the host's screen watch (`checkTurnWatch`) read it as a turn,
 * set `turnActive`, and the repo's `serial` group held an agent-posted row the
 * whole time. Background agents are `info.agents`' fact, never the turn's.
 *
 * Two shapes, either one: a tray glyph, a type token, then the CLI's two-space
 * column gap; or the stats trailing the row UNPARENTHESISED ("11m 17s · ↓ 159.4k
 * tokens") — the spinner always wraps its stats in parentheses.
 */
const TRAY_ROW_RE = /^\s*[◯◉○●◎⏺]\s+[A-Za-z][\w:-]*\s{2,}\S/;
/**
 * The stats shape: what `/(?:^|\s)\d+(?:\.\d+)?\s*[smh](?:\s+\d+\s*[sm])*\s+·\s+[↓↑]\s*[\d.,]+\s*[km]?\s+tokens?\s*$/i`
 * answered, without its quadratic retry from every whitespace (CodeQL
 * `js/polynomial-redos`). Two facts make it a split: the `·` it matched is the
 * line's LAST one (nothing after it may hold another), and the `(?:\s+\d+\s*[sm])*`
 * run never decided anything — its last item alone, after whitespace, is already
 * a first item — so one duration before the `·` is the same test.
 */
export function trayStats(line: string): boolean {
  const dot = line.lastIndexOf("·");
  return dot >= 0
    && /(?:^|\s)\d+(?:\.\d+)?\s*[smh]\s+$/i.test(line.slice(0, dot))
    && /^\s+[↓↑]\s*[\d.,]+(?:\s*[km])?\s+tokens?\s*$/i.test(line.slice(dot + 1));
}

export interface WorkingLine {
  /** "Clauding…" — the TUI's own word for what it is doing. */
  phrase: string;
  /** "9m 20s", when the parenthetical carried one. The reader prefers its own
   *  count off `turnStartedAt` and falls back to this. */
  elapsed: string | null;
  /** "↓ 9.7k tokens" — the spend, which nothing else in the reader can say. */
  tokens: string | null;
  /** Everything else the parenthetical held ("thinking"), hints removed. */
  extra: string[];
  /** One line for a phone: phrase, tokens, extras — never the elapsed, which
   *  the card beside it is already counting. */
  text: string;
}

/**
 * The CLI's working line, recovered from recent PTY bytes.
 *
 * Heuristic like the rest of the TUI scraping, and it degrades to `null`, never
 * to a wrong number: a line is only read as a spinner when it carries a gerund
 * AND (a duration OR a token count), with a bare gerund accepted only as a
 * fallback. That second rule is why the ellipsis alone is not enough — the TUI
 * truncates other lines with one too ("⚠ Transcript saving is off — inherited
 * CL…"), and a warning banner rendered as "working on: inherited CL…" would be
 * this app inventing an activity.
 */
export function workingLine(tail?: string): WorkingLine | null {
  if (!tail) return null;
  const lines = stripAnsi(tail).split(/[\r\n]+/);
  const clean = (raw: string | undefined) => (raw ?? "").replace(/[│┃|╭╮╰╯─]/g, " ").replace(/\s+/g, " ").trim();
  let weak: WorkingLine | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    // A background agent's tray row is the AGENT working, not the turn.
    if (TRAY_ROW_RE.test(lines[i] ?? "") || trayStats(lines[i] ?? "")) continue;
    const line = clean(lines[i]);
    if (!line) continue;
    const parens = [...line.matchAll(/\(([^()]*)\)/g)];
    const last = parens[parens.length - 1];
    const head = last ? line.slice(0, last.index) : line;
    let elapsed: string | null = null;
    let tokens: string | null = null;
    const extra: string[] = [];
    for (const raw of (last?.[1] ?? "").split("·")) {
      const part = raw.trim();
      if (!part || HINT_RE.test(part)) continue;
      if (!elapsed && DUR_RE.test(part)) { elapsed = part; continue; }
      if (!tokens && /tokens?\b/i.test(part)) { tokens = part; continue; }
      extra.push(part);
    }
    // The progress row the CLI draws UNDER the phrase — the only measurement a
    // compaction has for its first half-minute (`PROGRESS_RE`). Read off the
    // row below because that is where the CLI puts it, and off this one too for
    // a terminal wide enough to keep them together.
    const pct = PROGRESS_RE.exec(clean(lines[i + 1]))?.[1] ?? PROGRESS_RE.exec(line.slice(line.search(/[▰▱▬█▓░▒⣿⠿]/) < 0 ? line.length : line.search(/[▰▱▬█▓░▒⣿⠿]/)))?.[1] ?? null;
    if (pct) extra.push(`${pct}%`);
    const phrases = gerundPhrases(head);
    // The gerund-with-an-object form is read ONLY off a line that also carries
    // something MEASURED — a parenthetical with a duration or a token count, or
    // the progress row above. See the object form's doc for why it is never read on
    // its own. It is how `/compact` announces itself, and `/compact` fires no
    // hook at all, so this line is the only thing that says the CLI is busy for
    // the minutes it runs.
    const objs = phrases.length || !(elapsed || tokens || pct) ? [] : gerundPhrases(head, true);
    const hit = phrases[phrases.length - 1] ?? objs[objs.length - 1];
    if (!hit) continue;
    const phrase = `${hit}…`;
    if (!elapsed && !tokens && !pct) {
      // A gerund with nothing measured behind it — the first repaint of a turn,
      // or a redraw that split the line. Worth showing if nothing better turns
      // up further back, but never in preference to a line with numbers on it.
      weak ??= { phrase, elapsed: null, tokens: null, extra: [], text: phrase };
      continue;
    }
    const text = [phrase, tokens, ...extra].filter(Boolean).join(" · ");
    return { phrase, elapsed, tokens, extra, text: text.length > 140 ? `${text.slice(0, 139)}…` : text };
  }
  return weak;
}

/**
 * How far back in the tail a panel footer still counts as "on screen now".
 *
 * The tail is raw bytes, not a rendered grid, so a footer the CLI has since
 * painted over is still sitting in it. A window keeps the claim to roughly the
 * last repaint; older than that and the answer is no, which is the safe way to
 * be wrong here — the notice beside it stands on its own and the button is
 * simply absent.
 */
const PANEL_WINDOW = 2000;

/** The footer the CLI prints under a panel you can move through. Same words the
 *  host strips as chrome (`transcript.ts` `SCROLL_HINT`) — the two read one
 *  fact, one about a sealed capture and one about the screen right now. */
const SCROLL_FOOTER = /\bto scroll\b/i;

/**
 * Is a scrollable panel open in the CLI at this moment?
 *
 * The reader needs it to know whether "there is more below the fold" is still
 * actionable. A capture that was clipped stays clipped for ever — the rows were
 * never painted, so they are in no record — but while the panel is STILL OPEN
 * the missing part is one scroll away in the terminal, and the reader can hand
 * you over to it. Once the panel closes there is nowhere to go, so the button
 * must not be drawn.
 *
 * Heuristic, like every other read of this tail, and it degrades to false: a
 * late repaint costs a button that was owed, never a button that lies about
 * where the text went.
 */
export function scrollPanelOpen(tail?: string): boolean {
  if (!tail) return false;
  return SCROLL_FOOTER.test(stripAnsi(tail).slice(-PANEL_WINDOW));
}
