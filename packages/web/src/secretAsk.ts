/**
 * **Is the PTY asking for a secret right now?** Read off the line the cursor
 * sits on, up to the cursor — `sudo`'s `Password:`, `[sudo] password for me:`,
 * ssh's `Enter passphrase for key '…':`, `git`'s `Password for 'https://…':`.
 *
 * Only the cursor line, and only when it ENDS with the ask: a password prompt
 * is the one place the program has stopped and is waiting on the line it just
 * printed. `Password:` scrolled up a row, or a log line that mentions a
 * password mid-sentence, is not an ask. A miss degrades to the ordinary
 * composer (CLAUDE.md: heuristics degrade to absent, never to a wrong answer);
 * a false hit only masks the box, and the bar says why and how to leave it.
 *
 * Returns the ask as printed (trimmed), for the bar to quote, or null.
 */
const ASK = /(?:^|[\s[(])(?:password|passphrase|passcode|pin)\b(?:'[^']*'|"[^"]*"|[^:'"\n]){0,160}:$/i;

export function secretAsk(cursorLine: string): string | null {
  const line = cursorLine.replace(/\s+$/, "");
  if (!line || line.length > 200) return null;
  if (!ASK.test(line)) return null;
  return line.trim();
}
