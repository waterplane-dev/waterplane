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
import { trimEndChars } from "./lineartrim.js";

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
const trimPath = (s: string): string => trimEndChars(s.replace(/^[([{'"`*]+/, ""), ")]}.,;:'\"`*");

/** The image extension alone, for `imgMatches`: no leading quantifier, so linear. */
const IMG_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|svg)\b/gi;

/**
 * `text.match(IMG_RE)` without the regex's quadratic scan (CodeQL
 * `js/polynomial-redos`: `\S+` retried from every start of a long run with no
 * extension). Same hits: a match never crosses whitespace, and greedy `\S+` makes
 * it run from the START of its whitespace-free run to the end of the LAST
 * extension in that run (an extension holds no `.`, so no later one is hidden
 * inside it) — hence at most one per run, and none when that extension's dot is
 * the run's first character.
 */
function imgMatches(text: string): string[] {
  const out: string[] = [];
  for (const run of text.split(/\s+/)) {
    let end = -1;
    let dot = -1;
    IMG_EXT_RE.lastIndex = 0;
    for (let e: RegExpExecArray | null; (e = IMG_EXT_RE.exec(run)); ) {
      dot = e.index;
      end = e.index + e[0].length;
    }
    if (dot > 0) out.push(run.slice(0, end));
  }
  return out;
}

/** Every image path in some text, de-duplicated, trailing punctuation stripped. */
export function imagePaths(text: string): string[] {
  const m = typeof text === "string" ? imgMatches(text) : [];
  return [...new Set(m.map(trimPath))];
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

/**
 * How long the desktop holds a prompt for an inbox file the phone has not
 * finished uploading (`awaitInboxFiles`, host `routes/session.ts`). A cap, not
 * a promise: past it the prompt is typed anyway, exactly as before the hold.
 * Inside the phone's own patience — its retries JOIN the held delivery
 * (`inputsInFlight`) and it gives a submit eight 90 s windows.
 */
export const INBOX_HOLD_MS = 5 * 60_000;
/** Only a name the phone minted this recently is waited for (see below). */
export const INBOX_FRESH_MS = 2 * 60 * 60_000;

/**
 * The `.claude/inbox/` paths in a prompt that the phone minted RECENTLY — the
 * ones whose bytes may still be on their way.
 *
 * The phone names an upload before it sends it (`plannedInboxPath`:
 * `<stem>-<Date.now() base 36><6 id chars><ext>`), so the prompt naming a
 * picture can reach the desktop before the picture does. The minted stamp is
 * what separates that from a path that will simply never exist (an old file
 * the sweep removed, a hand-typed name): only a name stamped within
 * `INBOX_FRESH_MS` of `now` is returned, so an old or foreign path never holds
 * a prompt. No stamp ⇒ not returned.
 */
export function freshInboxRefs(text: string, now: number, freshMs = INBOX_FRESH_MS): string[] {
  if (typeof text !== "string" || !text) return [];
  const out: string[] = [];
  for (const p of transportPaths(text)) {
    if (!p.startsWith(".claude/inbox/")) continue;
    const m = /-([0-9a-z]{8})[0-9a-z]{6}(?:\.[A-Za-z0-9]+)?$/.exec(p);
    if (!m) continue;
    const at = parseInt(m[1], 36);
    if (Number.isFinite(at) && Math.abs(now - at) <= freshMs) out.push(p);
  }
  return out;
}
