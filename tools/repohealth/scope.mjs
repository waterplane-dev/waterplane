/**
 * A SCOPE: one subtree of a repo, measured as though it were the repo.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A monorepo's readings are a monorepo's readings. `apps/ba3-web` at 24k lines
 * and `apps/boulder-app-v3` at 58k share one p95, one re-touch rate and one
 * untested count, and every one of those numbers is an average across parts
 * that have nothing to do with each other. The group stack says how big each
 * part is and that is the only per-part statement the series can make; the
 * question a person actually arrives with — "how is ba3-web doing" — has no
 * answer in it at all.
 *
 * ── Why it is a filter at the boundary and not an option in every metric ────
 *
 * Nothing below the boundary knows a scope exists. `buildSnapshot` is handed
 * the tree entries for one commit and this module cuts that list to a subtree
 * and re-roots the paths; `scopeHistory` does the same to the commit log. Every
 * metric, every pack, every threshold and every reading then runs unchanged and
 * unaware, which is the only way a scoped reading is the SAME KIND of reading
 * as the repo-wide one — and being able to put them side by side is the whole
 * point of measuring a part.
 *
 * The re-rooting is what makes that true rather than nearly true. Measured with
 * full paths, a subtree derives one group (`apps`), finds no `CLAUDE.md` where
 * it looks, and reads `.claude/skills` that are not its own. Re-rooted, the
 * subtree IS the tree: its groups are its own top-level directories, its
 * instructions are the ones that sit in it, and a metric that special-cased a
 * prefix would be a second definition of every one of those rules.
 *
 * The cost is that a path in a scoped row is relative to the scope. That is
 * stated on the wire (`scope` travels beside the rows) and never guessed at by
 * the reader — a path with no root beside it is exactly the half of the pair
 * that misleads, the same argument `longest.path` makes for travelling with
 * its day.
 *
 * ── Why the series is a separate file ───────────────────────────────────────
 *
 * The row shape is identical, so the two could share a file with a `scope`
 * column. They must not. `series.mjs` is append-only and every reader of it —
 * `missingShas`, `staleRows`, `perDay`, the mixed-version refusal — is written
 * over "the rows of this repo, in history order". A file holding two scopes
 * interleaved would make every one of those answers wrong in a way that reads
 * as a measurement: a day with two rows, a backfill that thinks it is done, a
 * rank taken over a window that is half somebody else's subtree.
 */

/** Characters a slug may carry. Everything else becomes `-`. */
const SAFE = /[^a-zA-Z0-9._-]+/g;

/**
 * The scope as the tool stores and prints it: a repo-relative directory path,
 * no leading or trailing slash, no `.` or `..` segment.
 *
 * It throws rather than sanitising. A scope is a thing a person named, and
 * quietly measuring a different subtree than the one they typed is the class
 * of bug the path-containment guards elsewhere in this codebase exist for.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeScope(raw) {
  const s = String(raw ?? "").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!s) throw new Error("--scope= needs a path inside the repo");
  if (s.startsWith("/")) throw new Error(`--scope=${raw}: a scope is relative to the repo, not absolute`);
  const parts = s.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`--scope=${raw}: a scope may not contain "." or ".." segments`);
  }
  return parts.join("/");
}

/**
 * The file-name half of a scope's series path.
 *
 * A path is not a filename, so `apps/ba3-web` becomes `apps-ba3-web` — and
 * because that flattening is lossy (`a/b` and `a-b` collide), four hex digits
 * of the ORIGINAL path ride along. The slug stays readable in a directory
 * listing and the suffix makes it unambiguous, which is the same trade the
 * repo ids on the daemon side make.
 *
 * @param {string} scope
 */
export function slugFor(scope) {
  const s = normalizeScope(scope);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const flat = s.replace(/\//g, "-").replace(SAFE, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${flat || "scope"}-${h.toString(16).padStart(8, "0").slice(0, 4)}`;
}

/**
 * The tree entries of one commit, cut to a scope and re-rooted.
 *
 * `null`/empty scope returns the list untouched, so the root series pays
 * nothing for this existing.
 *
 * @param {{path: string, oid: string}[]} entries
 * @param {string|null} scope
 */
export function scopeEntries(entries, scope) {
  if (!scope) return entries;
  const pre = `${scope}/`;
  const out = [];
  for (const e of entries) {
    if (!e.path.startsWith(pre)) continue;
    out.push({ ...e, path: e.path.slice(pre.length) });
  }
  return out;
}

/**
 * The commit log, cut to a scope and re-rooted.
 *
 * A commit that touched nothing in the subtree is DROPPED, not kept with an
 * empty file list. Keeping it would put a row in the series for a day on which
 * this subtree cannot have changed — the reading would be identical to the one
 * before it by construction — and every rate here is read against a window of
 * readings. Padding that window with copies is how a rate goes flat for a
 * reason that is about the rest of the repo.
 *
 * `batch` is re-derived rather than carried over: a 40-file commit that touched
 * three files in this subtree is not a batch HERE, and the cutoff is the same
 * pre-registered number applied to what this scope actually saw.
 *
 * @param {import("./types.mjs").History} history
 * @param {string|null} scope
 * @param {import("./types.mjs").EffectivePrereg} prereg
 * @returns {import("./types.mjs").History}
 */
export function scopeHistory(history, scope, prereg) {
  if (!scope) return history;
  const pre = `${scope}/`;
  const cutoff = prereg.BATCH_FILES;
  const commits = [];
  const touches = new Map();
  const batch = new Set();
  const lines = new Map();
  for (const c of history.commits) {
    const paths = (history.touches?.get(c.sha) ?? c.filesTouched ?? [])
      .filter((p) => p.startsWith(pre))
      .map((p) => p.slice(pre.length));
    if (!paths.length) continue;
    const isBatch = paths.length >= cutoff;
    commits.push({ ...c, filesTouched: paths, batch: isBatch });
    touches.set(c.sha, paths);
    if (isBatch) batch.add(c.sha);
    const num = history.lines?.get(c.sha);
    if (num) {
      const m = new Map();
      for (const [p, v] of num) if (p.startsWith(pre)) m.set(p.slice(pre.length), v);
      lines.set(c.sha, m);
    }
  }
  return { commits, touches, batch, lines };
}

/**
 * Which subtrees a person could reasonably ask for, off one commit's tree.
 *
 * The candidates are the source GROUPS the snapshot already derives, which is
 * the tool's own answer to "what are the top-level parts of this tree" — so
 * the list a reader picks from and the bands on the group chart are the same
 * set, and neither is a second opinion about the shape of the repo. `.` is
 * excluded: a scope of the whole tree is the series that already exists.
 *
 * @param {string[]} groups
 */
export function scopeCandidates(groups) {
  return (groups ?? []).filter((g) => g && g !== ".").sort();
}
