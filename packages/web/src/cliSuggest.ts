/**
 * The CLI's own next-prompt proposal (`SessionInfo.cliSuggestion`) — what the
 * phone may do with it. No imports, so `node --test` runs it.
 *
 * A proposal is offered as ONE TAP because at the desk it is one key (Tab, then
 * Return). Except a shell command: claude proposes those too, `!`-prefixed
 * (measured: `! ollama rm qwen3-coder:30b && rm -rf ~/Library/Caches/pip`), and
 * a misread tap on a phone is not the same act as reading it at the desk and
 * pressing Return. Those are shown, and said, but never a button.
 */
export function isShellSuggestion(text: string): boolean {
  return /^\s*!/.test(text);
}

/** Why a shell proposal has no button — the sentence drawn in its place. */
export const SHELL_SUGGESTION_WHY = "a shell command — not offered as one tap; type it yourself to run it";
