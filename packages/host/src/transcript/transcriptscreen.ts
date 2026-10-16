/** TUI chrome trimming and repaint folding for a PTY capture. Moved from transcript.ts. */

/**
 * Trailing TUI furniture on a PTY capture: the composer box, the mode line, the
 * key hints. None of it is output — it is the CLI's chrome, which happens to be
 * on screen when the capture is sealed — and printed under a command's answer
 * in the reader it reads as part of the answer.
 *
 * Stripped from the END only, and only while every remaining line matches. A
 * rule in the MIDDLE of a capture is a real separator the command drew, and a
 * `❯` inside the text is somebody quoting a prompt.
 */
export const CHROME = [
  /^[\s]*[─━—=]{5,}[\s]*$/,          // the composer's own rules
  /^[\s]*[❯>][\s]*$/,                // the empty composer
  /^[\s]*\[[A-Z0-9 _-]{2,}\][\s]*$/, // status tags the statusline draws
  /^[\s]*(⏵⏵|⏵|⏸)\s/,                // permission-mode line (⏸ = plan / manual; permmode.ts)
  /to scroll|to copy|to fork|to close|to expand|to cycle|to interrupt/i,
  /^[\s]*$/,
];

/**
 * The one hint row that is EVIDENCE rather than furniture: the CLI saying the
 * panel it just drew holds more than the rows it painted.
 *
 * It matters because a capture is a replay of painted cells — `renderCapture`
 * feeds the turn's bytes to a headless VT and reads the buffer back — and a TUI
 * paints only the visible slice of a scrollable panel. Rows below the fold were
 * never written to the PTY, so they are in no record this daemon keeps. The
 * answer stored here is therefore partial, and the reader has to say so instead
 * of presenting it as the whole thing.
 *
 * Only the footer's own words, deliberately: the wider `CHROME` entry above also
 * matches "to copy"/"to close", which say nothing about how much was drawn.
 */
export const SCROLL_HINT = /\bto scroll\b/i;

/** Index of the first line of the trailing chrome run — `lines.length` if the
 *  capture ends in content. Shared so that "what was trimmed" and "what is
 *  left" can never disagree about where the furniture starts. */
function chromeStart(lines: string[]): number {
  let end = lines.length;
  while (end > 0 && CHROME.some((re) => re.test(lines[end - 1]))) end--;
  return end;
}

export function trimTuiChrome(text: string): string {
  const lines = text.split("\n");
  return lines.slice(0, chromeStart(lines)).join("\n").trimEnd();
}

/**
 * Did the furniture `trimTuiChrome` strips carry a scroll hint?
 *
 * Asked of the TRAILING run only, which is the run that was on screen when the
 * capture was sealed. A hint in the middle of a capture belongs to a panel the
 * CLI has since repainted over — whatever it held is equally unrecoverable, but
 * it is no longer what the reader is looking at, and treating it as current
 * would put the notice under an unrelated answer.
 */
export function scrollHintTrimmed(text: string): boolean {
  const lines = text.split("\n");
  return lines.slice(chromeStart(lines)).some((l) => SCROLL_HINT.test(l));
}

/**
 * A PTY capture, cut to the command it belongs to.
 *
 * The capture opens when waterplane records the send and closes when the session goes
 * idle, so it routinely starts mid-output: the tail of whatever the agent was
 * printing when the command was typed. The CLI echoes the command itself, so
 * the first line carrying it is where this exchange actually begins. No echo
 * found ⇒ the whole capture, uncut — a capture that lost the echo is still the
 * only record there is, and guessing a cut point would delete the answer.
 */
export function sliceToCommand(text: string, command: string): string {
  const head = command.trim().split(/\s+/)[0] ?? "";
  if (!head) return text;
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim().startsWith(head));
  return i > 0 ? lines.slice(i).join("\n") : text;
}

/**
 * One answer, once — even though the CLI drew it three times.
 *
 * A capture is a VT replay, and this TUI does not print a panel and move on: it
 * paints a first, short draft, then repaints a taller one as the text arrives,
 * and each paint SCROLLS into the replay buffer rather than overwriting the last
 * one. Measured on this desktop, one `/btw` came back as the question and its
 * opening paragraph, then the question and the whole answer — which the reader
 * showed as the same exchange happening twice, the first time truncated.
 *
 * Every paint restates the echoed command, so the echoes are the seams. A
 * section whose body is the BEGINNING of another section's body is that
 * section's earlier draft and is dropped; a section that says something the
 * others do not is kept, in place. That second rule is the point: an answer
 * long enough to scroll leaves rows in an early paint that no later one holds,
 * and folding on "keep the longest" would silently delete them.
 *
 * Compared on the body only, ignoring whitespace. The echo line itself differs
 * between drafts — the TUI truncates it to the width it has ("very very …" then
 * "very very e…") — so comparing whole sections would find no prefix at all.
 */
export function foldRepaints(text: string, command: string): string {
  const head = command.trim().split(/\s+/)[0] ?? "";
  if (!head) return text;
  const lines = text.split("\n");
  const seams: number[] = [];
  lines.forEach((l, i) => { if (l.trim().startsWith(head)) seams.push(i); });
  if (seams.length < 2) return text;

  const sections = seams.map((from, k) => lines.slice(from, seams[k + 1] ?? lines.length));
  const bodies = sections.map((sec) => sec.slice(1).join(" ").replace(/\s+/g, " ").trim());
  const kept = sections.filter((_, i) => !bodies.some((other, j) =>
    j !== i && other.startsWith(bodies[i]) &&
    // A longer draft supersedes a shorter one; two identical drafts leave the
    // FIRST standing, or each would drop the other and the answer would vanish.
    (other.length > bodies[i].length || j < i)));

  // Everything before the first seam is output the command interrupted, already
  // cut by `sliceToCommand` — nothing is put back here.
  return kept.flat().join("\n");
}

