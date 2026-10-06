/**
 * Transport-dir file references inside conversation text.
 *
 * The phone↔repo transport dirs (`.claude/inbox/`, `.claude/outbox/`, the
 * top-level `.outbox/` some repos use — same set as the host's OUTBOX_SUBDIRS)
 * get named constantly in prompts and in what the agent writes back
 * ("saved to .claude/outbox/report.md"). In the reader view those were dead
 * text: the file sits one tap away in the gallery, but you had to go find it.
 * Recognising them turns every mention into the file itself — a thumbnail for
 * an image, a tappable chip for anything else.
 *
 * Matching is deliberately narrow: only paths that contain a transport dir, so
 * an ordinary source path in a diff stays plain text.
 */

const SEG = "[A-Za-z0-9._~@%+-]+";
/** A transport path, optionally prefixed by an absolute/relative lead-in
 *  (`/Users/me/dev/repo/.claude/inbox/x.png`, `~/repo/.outbox/y.md`). */
export const FILE_REF_SRC =
  `/?(?:${SEG}/)*\\.(?:claude/(?:inbox|outbox)|outbox)/${SEG}(?:/${SEG})*`;

const TRANSPORT_RE = /\.claude\/(?:inbox|outbox)\/|(?:^|\/)\.outbox\//;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|svg)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i;

export interface FileRef {
  /** The text as written (what stays visible as the label). */
  raw: string;
  /** Repo-relative path, i.e. from the transport dir onwards — what the
   *  artifact endpoint wants. */
  relPath: string;
  name: string;
  image: boolean;
  video: boolean;
}

/**
 * Parse one matched run into a ref. Returns null when it isn't actually a
 * transport path (or is bare directory), so callers can fall back to plain text.
 * Trailing sentence punctuation is trimmed off the match — "see .claude/outbox/a.md."
 * must not resolve to `a.md.`.
 */
export function parseFileRef(match: string): FileRef | null {
  const raw = match.replace(/[.,;:!?)\]]+$/, "");
  if (!raw) return null;
  const m = TRANSPORT_RE.exec(raw);
  if (!m) return null;
  // Slice from the transport dir itself: `/Users/x/repo/.claude/inbox/a.png`
  // → `.claude/inbox/a.png`, which is what the repo-scoped endpoints take.
  const cut = raw.indexOf(".claude/") >= 0 ? raw.indexOf(".claude/") : raw.indexOf(".outbox/");
  const relPath = raw.slice(cut);
  const name = relPath.split("/").pop() || "";
  if (!name || name === "inbox" || name === "outbox") return null;
  return { raw, relPath, name, image: IMAGE_RE.test(name), video: VIDEO_RE.test(name) };
}

/** Whole-string test — used for `code spans` and markdown link targets, where
 *  the whole content (not a run inside prose) is the candidate. */
export function wholeFileRef(text: string): FileRef | null {
  const t = text.trim();
  if (!new RegExp(`^(?:${FILE_REF_SRC})$`).test(t)) return null;
  return parseFileRef(t);
}

/**
 * Every transport-dir path a piece of text names, in the order written and
 * deduped by path.
 *
 * The markdown renderer walks text token by token because it has to keep the
 * prose around it; the queue and the pad want the opposite — the FILES, without
 * the sentence. Both ask the same regex, so a path the reader turns into a
 * thumbnail is exactly one the queue can check the existence of.
 */
export function refsIn(text: string): FileRef[] {
  const re = new RegExp(FILE_REF_SRC, "g");
  const out: FileRef[] = [];
  const seen = new Set<string>();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const r = parseFileRef(m[0]);
    if (!r || seen.has(r.relPath)) continue;
    seen.add(r.relPath);
    out.push(r);
  }
  return out;
}

/**
 * The text with every mention of `relPath` taken out — the strip's X.
 *
 * Removes the whole written run (an absolute lead-in included, so no orphan
 * `/Users/me/repo/` is left behind) and only the run: trailing sentence
 * punctuation stays with the sentence, and so does every OTHER file. Then the
 * hole is tidied — a doubled space closed, a line left empty dropped — and
 * nothing else is touched, so a deliberate blank line between paragraphs
 * survives.
 */
export function dropFileRef(text: string, relPath: string): string {
  const re = new RegExp(FILE_REF_SRC, "g");
  const lines: string[] = [];
  let hit = false;
  for (const line of text.split("\n")) {
    const cut = line.replace(re, (m) => {
      const r = parseFileRef(m);
      return r && r.relPath === relPath ? m.slice(r.raw.length) : m;
    });
    if (cut === line) { lines.push(line); continue; }
    hit = true;
    const tidy = cut.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([.,;:!?])/g, "$1").trimEnd();
    // A line that WAS only the mention goes with it; a blank line that was
    // already there is the writer's and stays.
    if (tidy.trim()) lines.push(tidy);
  }
  return hit ? lines.join("\n").trim() : text;
}

/**
 * A BARE filename, resolved against a listing of what is actually in the
 * transport dirs.
 *
 * The narrow rule above wants the transport dir written out, and that is the
 * right rule for prose: a bare `foo.png` in a diff, a log line or a stack trace
 * is not a file mention this reader should hijack. But the commonest way an
 * agent lists what it produced names the dir ONCE and then the files —
 *
 *     GIFs (in `.claude/outbox/`):
 *     - `boulder-top-out-10-flow.gif` — full lap
 *
 * — and every one of those came out as dead text while the pictures sat one tap
 * away in the gallery. So a name is resolved, but only where guessing is cheap
 * and wrong guesses are not:
 *
 *   1. CODE SPANS ONLY (the caller decides — see Markdown.tsx). Prose is left
 *      exactly as it was.
 *   2. MEDIA ONLY. `report.md` or `api.ts` in backticks stays a code span; the
 *      false-positive risk is all in the file types a repo is full of.
 *   3. IT MUST EXIST, in this repo's transport dirs, exactly once. An unknown
 *      name is not a file reference, and an ambiguous one (same basename in
 *      inbox and outbox) is refused rather than resolved to a coin flip.
 *
 * `known` is the listing — repo-relative transport paths, i.e. what
 * `api.artifacts()` / `api.inbox()` hand back. An empty or missing listing
 * resolves nothing, which is the pre-existing behaviour: this degrades to plain
 * text, never to a thumbnail of the wrong file.
 */
const BARE_NAME_RE = new RegExp(`^${SEG}$`);

export function bareFileRef(text: string, known: readonly string[] | undefined): FileRef | null {
  if (!known || !known.length) return null;
  const name = text.trim();
  if (!BARE_NAME_RE.test(name)) return null;
  const image = IMAGE_RE.test(name), video = VIDEO_RE.test(name);
  if (!image && !video) return null;
  let hit: string | null = null;
  for (const rel of known) {
    if ((rel.split("/").pop() || "") !== name) continue;
    if (!TRANSPORT_RE.test(rel)) continue;
    if (hit && hit !== rel) return null; // ambiguous — two files, one name
    hit = rel;
  }
  if (!hit) return null;
  return { raw: name, relPath: hit, name, image, video };
}

/**
 * A markdown IMAGE link — `![alt](docs/assets/hero.svg)` — resolved against
 * the document it is written in, the way GitHub resolves it.
 *
 * The transport-dir rule above exists because prose is full of paths nobody
 * meant as pictures. An image link is not prose: the author asked for the
 * picture, so any relative media path in one is a reference. Without this a
 * README's hero image read as its alt text plus a dead path.
 *
 * `docPath` is the repo-relative path of the document. A leading `/` is the
 * repo root (GitHub's reading too). A URL, a `..` that climbs out of the repo,
 * or a non-media target is null — the caller then renders the link as it did
 * before, never a broken picture and never a path outside the tree.
 */
export function docImageRef(href: string, docPath: string): FileRef | null {
  const target = href.replace(/[?#].*$/, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return null; }
  const name = decoded.split("/").pop() || "";
  const image = IMAGE_RE.test(name), video = VIDEO_RE.test(name);
  if (!image && !video) return null;
  const base = decoded.startsWith("/") ? [] : docPath.split("/").slice(0, -1);
  const parts = [...base];
  for (const seg of decoded.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  if (!parts.length) return null;
  return { raw: href, relPath: parts.join("/"), name, image, video };
}
