import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";

/**
 * The two containment guards, written once.
 *
 * Six files had hand-rolled the same three lines — `files.ts` twice, plus
 * `git.ts`, `secrets.ts`, `tree.ts` and `builds.ts` — under six different
 * names (`resolveInTree`, `pathInTree`, `inDir`, `inTree`, and twice inline).
 * They agreed, which is the good case; the point of collapsing them is that
 * nothing guarantees the seventh will.
 *
 * ── Why there are TWO of them, and not one ─────────────────────────────────
 *
 * `contained()` is LEXICAL: it normalises `..` and refuses anything that lands
 * outside the root, and it does not resolve symlinks. `inRoot()` additionally
 * resolves them (`realpathSync`). That difference is deliberate and neither is
 * the "fixed" version of the other.
 *
 * `inRoot` guards the directories a client NAMES — `session.create` spawns
 * `claude` in one, `build.run` executes a shell command in one — where the
 * argument is an absolute path that arrives from outside and must be compared
 * against `WATERPLANE_ROOT`. Both sides need realpath there or macOS's `/var` →
 * `/private/var` makes an honest path look like an escape.
 *
 * `contained` guards a repo-RELATIVE path joined onto a worktree we already
 * trust. Since the caller supplies the root, `..` is the whole attack surface
 * and `resolve` handles it. Making this one realpath-strict would ALSO refuse a
 * symlink that legitimately lives inside a repo and points elsewhere — a
 * symlinked asset directory, a linked package — and would break serving those
 * files for no gain: a symlink inside a worktree is not a privilege boundary
 * here, because whoever can create one can already run code in that repo (the
 * daemon spawns `claude` there, which is the entire product). The boundary is
 * the tailnet and `origin.ts`; this is traversal hygiene under it.
 */
export function contained(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * Keep a path inside the configured root — never write, and never SPAWN,
 * outside it. Symlinks resolved on both sides; see above for why this one and
 * `contained` differ.
 *
 * Pinned by `e2e-scaffold.mjs` and `e2e-rootguard.mjs`.
 */
export function inRoot(root: string, target: string): string | null {
  const r = realResolve(root);
  const t = realResolve(isAbsolute(target) ? target : resolve(root, target));
  if (t !== r && !t.startsWith(r + sep)) return null;
  return t;
}

/**
 * Resolve symlinks in a path that may not exist yet: realpath the deepest
 * ancestor that does, then re-append the rest. Without this `inRoot` compares
 * apples to oranges on macOS, where `/var` is a symlink to `/private/var` — the
 * configured root stays `/var/…` while git hands back the resolved
 * `/private/var/…`, and every path looks like an escape. A plain
 * `realpathSync` with a lexical fallback is NOT equivalent: it falls all the
 * way back for a leaf that does not exist yet, which is exactly the case a new
 * worktree is in when it is named.
 */
export function realResolve(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail.reverse()); } catch { /* not there yet */ }
    const parent = dirname(head);
    if (parent === head) return resolve(p);   // hit the filesystem root
    tail.push(head.slice(parent.length + 1));
    head = parent;
  }
}
