/**
 * Workspace: two readings about what a repo CARRIES, taken from the tree at
 * the newest commit — tracked litter and docs that name paths which are gone.
 *
 * ── Why these are HEAD-only ────────────────────────────────────────────────
 *
 * Both are lists of names a person acts on (delete this, fix that sentence),
 * and a list of last March's litter helps nobody. The metric is pure — a
 * list of tree entries and a reader of text in, a row out — and
 * `measureWorkspaceAt` is the one function that touches git, called by
 * `repohealth.mjs` for the newest commit only. Every earlier row carries
 * `{value: null, reason: "read at the newest commit only"}`; a point series
 * of these would need a tree read per commit for a number nobody trends.
 *
 * ── Litter: tracked only, and it says so ───────────────────────────────────
 *
 * The engine reads committed objects and never the working tree (`git.mjs`'s
 * header argues why: the tree is shared and half-edited). So this counts
 * TRACKED binaries and build output — the litter that reached the history —
 * and `scope: "tracked"` is on the value so the phone can say that untracked
 * files were not looked at. A file is litter when its extension is in
 * `LITTER_EXTS` (archives, packages, databases, logs, object files, editor
 * leftovers) or one of its directories is in `LITTER_DIRS` (directories that
 * only a build or a package manager writes). `build` and `out` are NOT in the
 * list: they are ordinary names for source directories. Paths under
 * `fixtures`/`testdata` are skipped — a test's zip is on purpose.
 *
 * ── Docs drift: candidate references, not proof ────────────────────────────
 *
 * A markdown file "names" a repo path when it writes one in an inline code
 * span (`` `packages/web/src/App.tsx` ``) or a relative link target. Fenced
 * code blocks are ignored (examples, not claims). A candidate must contain a
 * `/` (links may be a bare relative file) and end in a file extension or `/`,
 * hold no glob, placeholder or URL syntax, and not start in a build
 * directory. It resolves when it exists from the repo root or from the
 * document's own directory, as a file or a directory, or when it is the tail
 * of a tracked path (package-relative writing). Changelogs
 * are skipped: they are SUPPOSED to name what is gone.
 *
 * What this will still get wrong, and the list carries the evidence so a
 * person can tell: a path to an ignored file (`.claude/outbox/x.gif`), to
 * another repo, or to something a command creates. The count is "references
 * that did not resolve", worded so.
 */
import { posix } from "node:path";
import { inExcludedDir } from "../source.mjs";
import { scopeEntries } from "../scope.mjs";

const LITTER_EXTS = new Set([
  "apk", "aab", "ipa", "db", "sqlite", "sqlite3", "log", "zip", "tar", "tgz", "gz", "bz2", "xz",
  "7z", "rar", "jar", "war", "exe", "dll", "so", "dylib", "o", "a", "class", "pyc", "pyo",
  "dmp", "bak", "tmp", "swp", "swo", "pid",
]);
const LITTER_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const LITTER_DIRS = new Set([
  "dist", "node_modules", "target", ".next", ".nuxt", ".svelte-kit", ".gradle", "__pycache__",
  "coverage", ".turbo", ".parcel-cache",
]);
const ON_PURPOSE_DIRS = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "__snapshots__"]);

const none = (reason) => ({ value: null, reason });

/** @param {string} path */
function extOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Tracked litter in a tree.
 * @param {{path: string, size: number}[]} entries
 * @param {{HABITS_LIST_N: number}} prereg
 */
export function measureLitter(entries, prereg) {
  const kinds = {};
  const items = [];
  let bytes = 0;
  for (const e of entries) {
    const segs = e.path.split("/");
    const dirs = segs.slice(0, -1);
    if (dirs.some((d) => ON_PURPOSE_DIRS.has(d))) continue;
    const name = segs[segs.length - 1];
    let kind = null;
    if (LITTER_NAMES.has(name)) kind = name;
    else if (LITTER_EXTS.has(extOf(e.path))) kind = extOf(e.path);
    else if (dirs.some((d) => LITTER_DIRS.has(d))) kind = "build output";
    if (!kind) continue;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    bytes += e.size;
    items.push({ path: e.path, bytes: e.size, kind });
  }
  items.sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sortedKinds = Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return {
    value: {
      scope: "tracked",
      count: items.length,
      bytes,
      kinds: sortedKinds,
      items: items.slice(0, prereg.HABITS_LIST_N),
    },
  };
}

const CHANGELOG = /(^|\/)(CHANGELOG|HISTORY|RELEASES?|NEWS)[^/]*\.mdx?$/i;
const FENCE = /^(```|~~~)[\s\S]*?^\1[^\n]*$/gm;
const TICK = /`([^`\n]{3,200})`/g;
const LINK = /\]\(\s*<?([^)\s>]{1,200})>?(?:\s+"[^"]*")?\s*\)/g;
const BAD_CHARS = /[*?{}<>$()|=,'"~@!\\\[\]…]|\.\.\./;
const DOMAIN_FIRST = /\.(com|org|net|io|dev|app|ai|co|so|sh)$/i;

/** Directories docs name that a build or an install creates. */
const GENERATED_FIRST = new Set([
  "dist", "build", "out", "node_modules", "target", "coverage", ".next", "tmp", "temp",
]);

/**
 * The repo-relative path candidates a markdown text names, as
 * `{ref, link}` — `link` true for a link target (resolved from the document's
 * directory first). Exported for the test.
 * @param {string} text
 */
export function pathCandidates(text) {
  const body = text.replace(FENCE, "");
  const out = new Map();
  const take = (raw, link) => {
    let p = raw.trim();
    if (!link && /\s/.test(p)) return;
    if (link && /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(p)) return;
    // Cut at the first `#` / `?` and trim trailing punctuation by hand: the
    // regex forms (/#.*$/, /[.,;:]+$/) scan quadratically on a run of them.
    for (const mark of ["#", "?"]) { const at = p.indexOf(mark); if (at >= 0) p = p.slice(0, at); }
    p = p.replace(/:\d+(?::\d+|-\d+)?$/, "");
    let end = p.length;
    while (end > 0 && ".,;:".includes(p[end - 1])) end--;
    p = p.slice(0, end);
    if (p.startsWith("./")) p = p.slice(2);
    if (!p || BAD_CHARS.test(p) || p.startsWith("/")) return;
    if (!link && !p.includes("/")) return;
    const last = p.slice(p.lastIndexOf("/", p.length - 2) + 1);
    if (!p.endsWith("/") && !/\.[A-Za-z0-9]{1,8}$/.test(last)) return;
    const first = p.split("/")[0];
    if (DOMAIN_FIRST.test(first) || GENERATED_FIRST.has(first)) return;
    // The ref is the key: a link and a code span naming the same text are one.
    if (!out.has(p)) out.set(p, link);
  };
  let m;
  TICK.lastIndex = 0;
  while ((m = TICK.exec(body))) take(m[1], false);
  LINK.lastIndex = 0;
  while ((m = LINK.exec(body))) take(m[1], true);
  return [...out].map(([ref, link]) => ({ ref, link }));
}

/**
 * Markdown references that do not resolve in the tree.
 * @param {string[]} paths  every tracked path
 * @param {(path: string) => string} textOf  the text of a tracked markdown file
 * @param {{HABITS_LIST_N: number, DOCS_MAX_FILES: number, SRC: {excludeDirs: readonly string[]}}} prereg
 */
export function measureDocsDrift(paths, textOf, prereg) {
  const docs = paths.filter(
    (p) => /\.mdx?$/i.test(p) && !CHANGELOG.test(p) && !inExcludedDir(p, prereg.SRC.excludeDirs),
  );
  if (!docs.length) return none("the tree holds no markdown files");
  if (docs.length > prereg.DOCS_MAX_FILES) {
    return none(`${docs.length} markdown files is past the ${prereg.DOCS_MAX_FILES} this reading reads`);
  }
  const files = new Set(paths);
  const dirs = new Set();
  for (const p of paths) {
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
  }
  // Docs write package-relative paths (`src/index.ts` inside a package's
  // notes), so a reference also resolves when it is the TAIL of a tracked path
  // at a directory boundary. Conservative on purpose: it can hide a real break
  // when a same-tailed file exists elsewhere, and cannot invent one.
  const tails = new Set();
  for (const p of [...files, ...dirs]) {
    tails.add(p);
    for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) tails.add(p.slice(i + 1));
  }
  const exists = (p) => tails.has(p.endsWith("/") ? p.slice(0, -1) : p);

  let refs = 0;
  let broken = 0;
  const items = [];
  for (const doc of docs) {
    const dir = posix.dirname(doc);
    const cands = pathCandidates(textOf(doc));
    const missing = [];
    for (const { ref, link } of cands) {
      const fromDoc = posix.normalize(posix.join(dir, ref));
      const fromRoot = posix.normalize(ref);
      if (fromDoc.startsWith("..") && fromRoot.startsWith("..")) continue;
      refs++;
      const hit = link
        ? (!fromDoc.startsWith("..") && exists(fromDoc)) || (!fromRoot.startsWith("..") && exists(fromRoot))
        : (!fromRoot.startsWith("..") && exists(fromRoot)) || (!fromDoc.startsWith("..") && exists(fromDoc));
      if (!hit) missing.push(ref);
    }
    if (missing.length) {
      broken += missing.length;
      items.push({ path: doc, broken: missing.length, of: cands.length, missing: missing.slice(0, 3) });
    }
  }
  if (refs === 0) return none("no markdown file names a repo path in a code span or a link");
  items.sort((a, b) => b.broken - a.broken || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    value: {
      docs: docs.length,
      refs,
      broken,
      docsWithBroken: items.length,
      items: items.slice(0, prereg.HABITS_LIST_N),
    },
  };
}

/** Why an earlier row has neither reading. */
export const WORKSPACE_NOT_HEAD = "read at the newest commit only";

/** The row field for a commit that is not the newest one. */
export function workspaceElsewhere() {
  return { litter: none(WORKSPACE_NOT_HEAD), docsDrift: none(WORKSPACE_NOT_HEAD) };
}

/**
 * The newest commit's workspace row. The only function here that reads git.
 *
 * @param {string} root
 * @param {string} sha
 * @param {{listTree: Function, readBlobs: Function}} git
 * @param {object} prereg
 * @param {string|null} scope
 */
export function measureWorkspaceAt(root, sha, git, prereg, scope = null) {
  const entries = scopeEntries(git.listTree(root, sha), scope);
  const mds = entries.filter(
    (e) => /\.mdx?$/i.test(e.path) && !CHANGELOG.test(e.path) && !inExcludedDir(e.path, prereg.SRC.excludeDirs),
  );
  let docsDrift;
  if (mds.length > prereg.DOCS_MAX_FILES) {
    docsDrift = measureDocsDrift(entries.map((e) => e.path), () => "", prereg);
  } else {
    const blobs = git.readBlobs(root, mds.map((e) => e.oid));
    const byPath = new Map(mds.map((e) => [e.path, e.oid]));
    docsDrift = measureDocsDrift(
      entries.map((e) => e.path),
      (p) => blobs.get(byPath.get(p))?.toString("utf8") ?? "",
      prereg,
    );
  }
  return { litter: measureLitter(entries, prereg), docsDrift };
}
