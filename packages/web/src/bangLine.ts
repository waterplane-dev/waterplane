/**
 * "Run this yourself" lines in an agent's reply, recognised so the reader can
 * put them in the session's shell with one tap (`features/shells` `lineToShell`).
 *
 * Claude writes a command it cannot run (auto mode blocked it, it needs the
 * person's login) as `! gh pr close 11 …` — the CLI's own bang prefix, meant
 * for its prompt box. Copied into a SHELL that `!` is wrong (zsh reads it as
 * "negate the exit status"), so the line handed over is the command alone.
 *
 * Pure, so `bangLine.test.mjs` pins it under `node --test`. Nothing here runs
 * anything: the line is SEEDED into the shell's box and the person sends it.
 */

/** `! cmd` (or `!cmd` where cmd is a word followed by arguments) → `cmd`; null
 *  for anything else. `!=`, `!important`, `!!` and multi-line spans are not
 *  commands. */
export function bangLine(code: string): string | null {
  const t = code.trim();
  if (t.includes("\n")) return null;
  const m = /^!\s+(\S.*)$/.exec(t) ?? /^!([A-Za-z][\w.-]*\s+\S.*)$/.exec(t);
  return m ? m[1].trim() : null;
}

const SHELL_LANGS = /^(sh|bash|zsh|shell|console|terminal|shellsession)$/i;

/**
 * A fenced block a person could paste into a shell: a shell-language fence, or
 * any fence whose every line is a bang line. Returns the lines with their
 * prompt prefix (`$ `, `% `, `! `) dropped, blank lines out; null when the block
 * is not a command (or holds nothing).
 */
export function shellBlock(lang: string, code: string): string | null {
  const lines = code.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return null;
  if (!SHELL_LANGS.test(lang.trim())) {
    const bangs = lines.map(bangLine);
    return bangs.every((b) => b != null) ? bangs.join("\n") : null;
  }
  return lines.map((l) => bangLine(l) ?? l.replace(/^\s*[$%]\s+/, "")).join("\n");
}
