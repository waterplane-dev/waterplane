/**
 * The files an item's words name: images anywhere, and the phone↔repo
 * transport by full path.
 *
 * Moved out of the smart pick (removed 2026-10-16), where it decided whether
 * a merge kept every file its members named. The backlog row's thumbnails read
 * `imagePaths`; `transportPaths` is the rule anything that ever folds two
 * items into one must keep — a merged text that drops a path is a merge that
 * loses the picture somebody attached.
 */

/**
 * An image path as the backlog row's thumbnails find one.
 *
 * Global, so `String.match` returns every hit. Never call `.test()` on it: a
 * global regex carries `lastIndex` between calls and would answer differently on
 * the second question about the same string.
 */
export const IMG_RE = /\S+\.(?:png|jpe?g|gif|webp|bmp|heic|heif|svg)\b/gi;

/**
 * A file on the phone↔repo transport, by its FULL path.
 *
 * CLAUDE.md: files a person uploaded arrive in `.claude/inbox/`, artifacts a
 * person should see go in `.claude/outbox/`, and both are named by full path
 * every time they are mentioned — a bare filename resolves nowhere.
 */
export const TRANSPORT_RE = /\.claude\/(?:inbox|outbox)\/\S+/gi;

/**
 * Markup and punctuation off BOTH ends of a matched path.
 *
 * Backticks and asterisks are in the class because prompts are written in
 * markdown: `` `.claude/inbox/a.png` `` and `**a.png**` otherwise carry their
 * fences into the path. Both ends, because the two regexes clip differently:
 * `TRANSPORT_RE` starts at `.claude/`, so an opening fence falls outside its
 * match, while `IMG_RE` is `\S+` and swallows it.
 */
const trimPath = (s: string): string => s.replace(/^[([{'"`*]+/, "").replace(/[)\]}.,;:'"`*]+$/, "");

/** Every image path in some text, de-duplicated, trailing punctuation stripped. */
export function imagePaths(text: string): string[] {
  const m = typeof text === "string" ? text.match(IMG_RE) : null;
  return m ? [...new Set(m.map(trimPath))] : [];
}

/**
 * Every FILE this text tells an agent to look at: transport paths first, then
 * images anywhere. The union, not either half: an inbox path that is not an
 * image (`.claude/inbox/log.txt`) and an image that is not on the transport
 * (`docs/flow.png`) are both files a rewritten text has to keep naming.
 */
export function transportPaths(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const m = text.match(TRANSPORT_RE);
  const out = m ? m.map(trimPath) : [];
  return [...new Set([...out, ...imagePaths(text)])];
}
