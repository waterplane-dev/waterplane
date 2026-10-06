/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/shared-architecture.md. */

// ── The caps, and what each one is protecting ────────────────────────────────

/**
 * How many candidates one pass may consider.
 *
 * Forty is the point past which the prompt stops being a few thousand tokens.
 * The rest are not dropped and not re-ordered — they keep their positions
 * untouched and the record says how many were not looked at, because a pass that
 * silently ignores half a backlog while reporting a clean sweep is worse than
 * one that says it ran out of room.
 */
export const SMARTPICK_MAX_ITEMS = 40;

/**
 * The character budget for the items in one prompt (≈ 3k tokens).
 *
 * Items go in whole, in current order, until this is spent; past it an item is
 * sent as its first few hundred characters and marked `clipped`. A clipped item
 * may be sorted — the model saw enough to place it — and may never be MERGED,
 * because a merge folds words the model would then not have read.
 */
export const SMARTPICK_MAX_CHARS = 12_000;

/** How many groups one pass may merge. A pass that wants to fold ten groups has
 *  stopped grooming a list and started rewriting it. */
export const MAX_SMARTPICK_MERGES = 10;

/** Notes are for a person reading the strip, not a log. Past twenty the strip is
 *  a scroll nobody finishes. */
export const SMARTPICK_MAX_NOTES = 20;

/** The model's one sentence about the pass, clipped — it is rendered on a phone
 *  under a row, and an unbounded string here is written by a model. */
export const SMARTPICK_MAX_WHY_CHARS = 600;

/** The sentence every degraded outcome ends on. One home for it, because it is
 *  the feature's whole safety promise said out loud. */
export const SMARTPICK_FIRED_AS_WAS = "fired in the order you had";

/** What a pass records when `cleanSmartPick` returned null. The host must not
 *  reword it — the strip's sentence is pinned by this module's test. */
export const SMARTPICK_UNREADABLE = "the model answered nothing readable";

/** What the strip says when the pass ran and moved nothing. */
export const SMARTPICK_NOOP_TEXT = "nothing moved — the order you had is the order it picked";

// ── Transport and image paths inside an item's words ─────────────────────────

/**
 * An image path as the backlog row's thumbnails find one.
 *
 * Lifted here from `web/Backlog.tsx`'s private copy so a merge can be checked
 * against the SAME rule that decides whether a row shows a picture — two
 * regexes would mean a merged text that keeps every path the thumbnailer looks
 * for while losing one this check looks for, or the reverse.
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
 * every time they are mentioned — a bare filename resolves nowhere. Which is
 * exactly why a merge may not drop one.
 */
export const TRANSPORT_RE = /\.claude\/(?:inbox|outbox)\/\S+/gi;

/**
 * Markup and punctuation off BOTH ends of a matched path.
 *
 * Backticks and asterisks are in the class because prompts are written in
 * markdown: `` `.claude/inbox/a.png` `` and `**a.png**` otherwise carry their
 * fences into the path, and the merge check then demands that the MARKUP
 * survive the merge — a refusal that is safe (nothing is lost) but permanent
 * and unreadable, dropping the same group on every pass with a note about a
 * file the merged text does in fact name.
 *
 * Both ends, because the two regexes clip differently: `TRANSPORT_RE` starts at
 * `.claude/`, so an opening fence falls outside its match, while `IMG_RE` is
 * `\S+` and swallows it. One of them is enough to keep the fence in the
 * required set, which is the whole failure.
 */
const trimPath = (s: string): string => s.replace(/^[([{'"`*]+/, "").replace(/[)\]}.,;:'"`*]+$/, "");

/** Every image path in some text, de-duplicated, trailing punctuation stripped. */
export function imagePaths(text: string): string[] {
  const m = typeof text === "string" ? text.match(IMG_RE) : null;
  return m ? [...new Set(m.map(trimPath))] : [];
}

/**
 * Every FILE this text tells an agent to look at: transport paths first, then
 * images anywhere.
 *
 * The union, not either half: an inbox path that is not an image
 * (`.claude/inbox/log.txt`) and an image that is not on the transport
 * (`docs/flow.png`) are both files the merged text has to keep naming.
 */
export function transportPaths(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const m = text.match(TRANSPORT_RE);
  const out = m ? m.map(trimPath) : [];
  return [...new Set([...out, ...imagePaths(text)])];
}