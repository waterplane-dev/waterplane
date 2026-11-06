/**
 * Two discovered repos with one name, told apart in words.
 *
 * A repo's name is its folder's name, so a second clone — a history-rewrite
 * leftover at `~/dev/waterplane-rewrite/out-ciqkit/ciqkit` beside the real
 * `~/dev/garmin/ciqkit` — reads exactly like the first on the phone. On
 * 2026-10-28 that sent three unattended week-end burn sessions to the leftover.
 *
 * The host computes `RepoTarget.where` with `twinWheres` over the CLONE dirs
 * (every worktree of one clone carries its clone's `where`, so they still list
 * together), and every surface that names a repo reads `repoLabel`. Absent
 * `where` = no twin (or an older host): the label is the bare name, unchanged.
 */

/** A clone as discovery found it: its folder name and its primary checkout dir. */
export interface RepoClone { name: string; dir: string }

const segs = (dir: string): string[] => dir.split(/[/\\]+/).filter(Boolean);

/**
 * `dir` → the shortest trailing part of its PARENT path that no other clone of
 * the same name shares, with a trailing `/` (`garmin/`, `out-ciqkit/`). Only
 * clones whose name another clone carries get an entry. When no tail is unique
 * (one parent ends the other) the whole parent path is the answer — longer, but
 * never two rows that read the same.
 */
export function twinWheres(clones: readonly RepoClone[]): Map<string, string> {
  const out = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const c of clones) {
    const dirs = byName.get(c.name) ?? [];
    if (!dirs.includes(c.dir)) dirs.push(c.dir);
    byName.set(c.name, dirs);
  }
  for (const dirs of byName.values()) {
    if (dirs.length < 2) continue;
    const parents = dirs.map((d) => segs(d).slice(0, -1));
    parents.forEach((mine, i) => {
      for (let n = 1; n <= mine.length; n++) {
        const tail = mine.slice(-n).join("/");
        if (parents.every((o, j) => j === i || o.slice(-n).join("/") !== tail)) { out.set(dirs[i], `${tail}/`); return; }
      }
      out.set(dirs[i], `/${mine.join("/")}${mine.length ? "/" : ""}`);
    });
  }
  return out;
}

/** The ONE wording of a repo's name on both ends: `ciqkit`, or `ciqkit · garmin/` for a twin. */
export function repoLabel(r: { repoName: string; where?: string }): string {
  return r.where ? `${r.repoName} · ${r.where}` : r.repoName;
}

// ── A name a person gave the repo, SHOWN instead of its folder ───────────────
//
// The product is called waterplane but its folder is still `myapp`, and moving the folder is
// the riskier fix. So a repo may carry a display name, stored on the host
// (`RepoTarget.displayName`, absent = the folder name). It changes what is SHOWN and nothing
// else: every id, path, API parameter, allow-list entry, stored key, group key and colour
// stays on the folder name. `repoLabel` is therefore still the KEY (the launcher groups,
// focuses and colours by it); `repoShown` is the only wording to print. Searching matches
// either (`repoNameMatches`).

/** The longest display name: a tab and a group header both have to hold it. */
export const REPO_DISPLAY_NAME_MAX = 40;

/**
 * A typed display name, or the sentence why not. Empty (after trimming) means "use the folder
 * name" and answers `value: null`; too long or holding a line break/control character is REFUSED
 * in words, never cut — a name that quietly lost its tail is words nobody typed.
 */
export function cleanRepoDisplayName(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "A display name is text." };
  const oneLine = { ok: false as const, error: "A display name is one line of plain text." };
  // NFC first, so the length counts what is drawn. Control, line/paragraph-separator and format
  // characters (zero-width, BOM, bidi overrides) are refused: they print as nothing, or reverse
  // what follows. ZWNJ/ZWJ stay — Persian and emoji sequences need them.
  const text = raw.normalize("NFC").trim();
  if (/[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u.test(text)) return oneLine;
  const value = text.replace(/[\s\p{Zs}]+/gu, " ");
  if (!value) return { ok: true, value: null };
  // Something must be visible: a run of joiners is not a name.
  if (!/[^\p{Z}\p{C}]/u.test(value)) return oneLine;
  if ([...value].length > REPO_DISPLAY_NAME_MAX) return { ok: false, error: `A display name is at most ${REPO_DISPLAY_NAME_MAX} characters.` };
  return { ok: true, value };
}

/** What to PRINT for a repo: its display name, else the folder name — `· where` for a twin either way. */
export function repoShown(r: { repoName: string; where?: string; displayName?: string }): string {
  return repoLabel({ repoName: r.displayName || r.repoName, where: r.where });
}

/** The same repo with its shown name in `repoName`, for a function that prints `repoName` (`repoBranchLabel`). Never to be stored or sent back. */
export function withShownName<T extends { repoName: string; displayName?: string }>(r: T): T {
  return r.displayName ? { ...r, repoName: r.displayName } : r;
}

/**
 * A title the repo's folder name leads (`myapp`, `myapp · main`), reworded with the shown name.
 * Only a whole leading name counts — never a prefix of a longer word — and the stored title is
 * not touched: this is for drawing it.
 */
export function shownTitle(title: string, repoName: string, shown: string): string {
  if (!shown || shown === repoName || !repoName) return title;
  if (title === repoName) return shown;
  return title.startsWith(`${repoName} · `) ? `${shown}${title.slice(repoName.length)}` : title;
}

/** `shownTitle` for the repo a title was made from, when you hold its target. */
export function shownTitleOf(r: { repoName: string; displayName?: string } | null | undefined, title: string): string {
  return r?.displayName ? shownTitle(title, r.repoName, r.displayName) : title;
}

/** `shownTitle` when you hold only the listing: the repo whose folder name leads the title (the longest, so `app-web` beats `app`). */
export function shownTitleIn(repos: readonly { repoName: string; displayName?: string }[], title: string): string {
  let best: { repoName: string; displayName?: string } | null = null;
  for (const r of repos) {
    if (!r.displayName || !(title === r.repoName || title.startsWith(`${r.repoName} · `))) continue;
    if (!best || r.repoName.length > best.repoName.length) best = r;
  }
  return shownTitleOf(best, title);
}

/** Does a search word find this repo — by its folder name or by the name it is shown as? */
export function repoNameMatches(r: { repoName: string; where?: string; displayName?: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return repoLabel(r).toLowerCase().includes(q) || repoShown(r).toLowerCase().includes(q);
}
