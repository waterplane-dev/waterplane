/**
 * The claude CLI's private directory on THIS desktop — the one definition
 * every reader (`projects/`, `sessions/`, `settings.json`, `commands/`) goes
 * through. `CLAUDE_CONFIG_DIR` replaces the whole directory exactly as the CLI
 * reads it; `<PREFIX>CLAUDE_HOME` is the tests' fake-HOME knob. The rule is
 * `@waterplane/shared`'s `claudeConfigDirOf` (the extensions share it).
 * Read at CALL time, so a test may move it. Spawned `claude` children inherit
 * `CLAUDE_CONFIG_DIR` untouched (`ptyenv.ts` starts from `process.env`; the
 * tmux pane gets it explicitly, `sessions/tmux.ts`).
 */
import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigDirOf, transcriptDirName, truncatedSlugPrefix } from "@waterplane/shared";
import { env } from "./env.js";

export function claudeConfigDir(): string {
  return claudeConfigDirOf({ configDir: process.env.CLAUDE_CONFIG_DIR, testHome: env("CLAUDE_HOME"), home: homedir() });
}

/**
 * Where the claude CLI stores a directory's conversations:
 * `<config dir>/projects/<slug>/<conversation-uuid>.jsonl`, slug = cwd with every
 * non-alphanumeric replaced by `-`.
 *
 * A slug past 200 chars is NOT that: the CLI keeps the first 200 and appends
 * `-<hash of the full path>` (read out of the 2.x bundle; the hash is not
 * re-derived here, so a wrong guess of it cannot happen). For such a path the
 * folder is found by its surviving head, and ACCEPTED only when exactly one
 * candidate holds a log naming this very cwd — two long worktrees can share
 * their first 200 chars, and the wrong sibling is a wrong file. Nothing found
 * (yet) or ambiguous answers the untruncated path, which does not exist, so a
 * reader finds nothing and says so.
 */
export function claudeProjectDir(cwd: string): string {
  const projects = join(claudeConfigDir(), "projects");
  const slug = transcriptDirName(cwd);
  const exact = join(projects, slug);
  const head = truncatedSlugPrefix(slug);
  if (head === null) return exact;
  const hit = longSlugCache.get(exact);
  if (hit && existsSync(hit)) return hit;
  let found: string | null = null;
  try {
    for (const name of readdirSync(projects)) {
      if (!name.startsWith(head)) continue;
      const dir = join(projects, name);
      if (!dirNamesCwd(dir, cwd)) continue;
      if (found) return exact; // two folders claim it: ambiguous is absent
      found = dir;
    }
  } catch { return exact; }
  if (!found) return exact;
  longSlugCache.set(exact, found);
  return found;
}

const longSlugCache = new Map<string, string>();

/** Does any of this folder's first few logs record `cwd` as its working directory? */
function dirNamesCwd(dir: string, cwd: string): boolean {
  const needle = `"cwd":${JSON.stringify(cwd)}`;
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).slice(0, 4); } catch { return false; }
  for (const n of names) {
    let fd: number | null = null;
    try {
      fd = openSync(join(dir, n), "r");
      const buf = Buffer.alloc(65536);
      const got = readSync(fd, buf, 0, buf.length, 0);
      if (buf.toString("utf8", 0, got).includes(needle)) return true;
    } catch { /* unreadable: not evidence */ } finally {
      if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return false;
}
