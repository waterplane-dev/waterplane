/**
 * The environment every PTY this daemon spawns starts from — and the floor
 * under it, because the daemon is normally started by LAUNCHD and a launchd
 * agent inherits almost nothing.
 *
 * Two measured holes, both of which look like the CLI misbehaving rather than
 * like an empty environment:
 *
 * **The locale is not cosmetic.** A tmux CLIENT that does not believe its
 * terminal is UTF-8 does not pass UTF-8 through: it re-draws box characters as
 * ACS line-drawing and substitutes every OTHER non-ASCII glyph with "_".
 * launchd sets no `LANG` at all, so every session arrived with its "❯"
 * selection cursor, its checkboxes and its icons flattened to underscores — on
 * the phone's screen AND in the bytes prompt detection reads, which is how a
 * live choice box became invisible to the approve bar. `tmux -u` forces it
 * regardless of the environment; `LANG` is set too so the non-tmux path and
 * claude itself agree.
 *
 * **`USER` is not cosmetic either.** launchd sets no `USER`/`LOGNAME`, and a
 * `claude` spawned without them opens `/usage` with its local Session panel
 * drawn and the ACCOUNT rows — "Current session … % used", the two limit
 * windows — never arriving at all. Measured on this desktop, 2026-09-22, by
 * bisecting the environment against a probe that waits 40 s for those rows:
 * every variable but `USER` absent still paints in 5 s, `USER` absent alone
 * never paints. That is exactly the `? / ? wk` the phone drew after every
 * restart — a scrape that could not fail loudly, because a screen that simply
 * never printed a percentage is indistinguishable from one this host cannot
 * parse. The name comes from `os.userInfo()`, which reads the passwd database
 * and needs no environment.
 *
 * WHICH UTF-8 locale is per platform (`defaultLocale`): macOS always has
 * `en_US.UTF-8`; a Linux box often does NOT (a minimal Debian/Ubuntu image,
 * WSL, a container generates no `en_US` locale), and a locale that is not
 * installed falls back to "C" — ASCII, the trap above. `C.UTF-8` is built
 * into glibc from 2.35 and shipped by Debian/Ubuntu/WSL images for years, so
 * it is the one name that is there.
 *
 * A value that IS set is never overwritten: a session started from a shell
 * keeps everything that shell decided. PATH is the one that is added TO:
 * `~/.local/bin` (where `wp-secret`, pipx and uv put a person's own commands) is
 * appended when it exists and is not listed, because a launchd PATH has only the
 * system dirs and the CLI's shell snapshot keeps the PATH it was started with, so
 * a `.zshrc` line never repairs it. Appended, never put first: it can only add a
 * command, never replace one.
 */
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** The UTF-8 locale supplied when the environment names none: `en_US.UTF-8` on macOS, `C.UTF-8` elsewhere. */
export function defaultLocale(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

/** `path` with `~/.local/bin` appended when that dir exists and is not on it; an absent PATH stays absent. */
export function withUserBin<T extends string | undefined>(path: T, home: string = homedir(), exists: (p: string) => boolean = existsSync): T {
  if (!path) return path;
  const dir = join(home, ".local", "bin");
  if (path.split(":").includes(dir) || !exists(dir)) return path;
  return `${path}:${dir}` as T;
}

/** `{ PATH }` when the floor changes it, else `{}`. For a tmux pane's own env prefix: a pane takes
 *  the tmux SERVER's PATH, so the client's env alone never reaches it. */
export function userBinEnv(path: string | undefined = process.env.PATH): Record<string, string> {
  const p = withUserBin(path);
  return p && p !== path ? { PATH: p } : {};
}

export function ptyEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
  if (env.PATH) env.PATH = withUserBin(env.PATH);
  if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = defaultLocale(platform);
  if (!env.USER || !env.LOGNAME) {
    let name = "";
    try { name = userInfo().username || ""; } catch { /* no passwd entry: leave it absent rather than invent one */ }
    if (name) {
      env.USER ||= name;
      env.LOGNAME ||= name;
    }
  }
  return env;
}
