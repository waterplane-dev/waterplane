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
 * keeps everything that shell decided.
 */
import { userInfo } from "node:os";

/** The UTF-8 locale supplied when the environment names none: `en_US.UTF-8` on macOS, `C.UTF-8` elsewhere. */
export function defaultLocale(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

export function ptyEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color" };
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
