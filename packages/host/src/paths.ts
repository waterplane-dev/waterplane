import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

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
 * and `resolve` handles it. It stays lexical because callers use it for paths
 * that do not exist yet (a sweep of something already gone, a file to create).
 *
 * A symlink is NOT harmless, though: a COMMITTED `link -> ~/.ssh/id_rsa` is
 * content from a clone, not something the person chose. So every path that
 * READS or WRITES file bytes on a client's say-so goes through `containedReal`
 * below, which realpaths an existing target and refuses one that resolves
 * outside the worktree. In-repo symlinks (to elsewhere inside the worktree)
 * keep working.
 */
export function contained(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * `contained` plus the symlink rule: when the target exists, its realpath must
 * lie inside the realpath of `root`. A dangling or looping link is refused too
 * (nothing legitimate reads it). A target that does not exist is returned as
 * `contained` would — creating is the caller's own check. Returns the LEXICAL
 * path (what callers already display and relativise), not the resolved one.
 *
 * A target that does not exist yet is checked through its nearest existing
 * ancestor (`evildir -> /tmp/x`, target `evildir/new.txt` is refused).
 * TOCTOU: a symlink swapped in between this check and the open is not caught;
 * only someone who already writes inside the worktree can race it.
 */
export function containedReal(root: string, rel: string): string | null {
  const full = contained(root, rel);
  if (full === null) return null;
  let real: string | null = null;
  let there = true;
  try { lstatSync(full); } catch { there = false; }
  if (there) {
    try { real = realpathSync(full); } catch { return null; }   // dangling or looping link
  } else {
    // Not there yet: judge the nearest existing ancestor.
    let anc = dirname(full);
    for (;;) {
      try { real = realpathSync(anc); break; } catch { /* keep climbing */ }
      const up = dirname(anc);
      if (up === anc) return null;
      anc = up;
    }
  }
  const r = realResolve(root);
  if (real !== r && !real.startsWith(r + sep)) return null;
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
