/**
 * tmux is REQUIRED — the rule, its sentences and its preflight rows, in one place.
 *
 * Every session runs inside a private tmux server (`sessions/tmux.ts`), which is
 * what lets it survive a host restart and a self-update. It used to be opt-in
 * (`<PREFIX>TMUX=1`), then on by default with `<PREFIX>TMUX=0` as an escape
 * hatch to a direct PTY. The direct substrate is gone: tmux is the ONE way a
 * session runs (macOS, Linux, WSL2 — a Windows checkout runs its host there through
 * `scripts/windows/host.mjs`; native Windows is unsupported), the knob is
 * IGNORED — `doctor` says so when it is still set — and a host that cannot find
 * tmux REFUSES to start a session, in words naming the install command.
 *
 * Pure except `onPath` (a PATH scan, no spawn). Imports nothing that reads the
 * environment at import. `packages/host/test/tmuxreq.test.mjs`.
 */
import { envName } from "@waterplane/shared";
import type { Check } from "./doctor.js";
import { defaultLocale } from "./ptyenv.js";
import { onPath } from "./pathx.js";

/**
 * Is the retired `<PREFIX>TMUX` knob still set? It means nothing now — every
 * session runs inside tmux — so any non-empty value is one `doctor` names as
 * ignored, rather than letting someone believe `0` still turns tmux off.
 */
export function tmuxKnobSet(raw: string | undefined): boolean {
  return (raw ?? "").trim() !== "";
}

/**
 * The exact command that installs tmux on this machine, or null when there is no
 * package manager we recognise. `has` answers "is this binary on PATH". Linux
 * order: apt, dnf, pacman, zypper, apk — the same as the installer's
 * `tmux_install_cmd`, so the two never name different commands.
 */
export function tmuxInstallCommand(platform: NodeJS.Platform, has: (bin: string) => boolean): string | null {
  if (platform === "darwin") return has("brew") ? "brew install tmux" : null;
  if (platform === "win32") return null;
  if (has("apt-get")) return "sudo apt-get install -y tmux";
  if (has("dnf")) return "sudo dnf install -y tmux";
  if (has("pacman")) return "sudo pacman -S --noconfirm tmux";
  if (has("zypper")) return "sudo zypper install -y tmux";
  if (has("apk")) return "sudo apk add tmux";
  return null;
}

/** The "how to install it" sentence, for a platform with or without a known command. */
export function tmuxInstallAdvice(platform: NodeJS.Platform, cmd: string | null): string {
  if (platform === "win32") return "Native Windows is not supported: run it inside WSL2, where tmux installs with: sudo apt-get install -y tmux. From a Windows checkout, `npm run restart` does that for you (scripts/windows/host.mjs).";
  if (cmd) return `Install it with: ${cmd}`;
  if (platform === "darwin") return "Install Homebrew (https://brew.sh), then: brew install tmux.";
  return "Install tmux with your distribution's package manager.";
}

/**
 * Why a session is refused when tmux is required and missing — the sentence a
 * phone shows for a create that spawned nothing. There is no way to run
 * without tmux, so it names none.
 */
export function tmuxMissingSentence(platform: NodeJS.Platform, cmd: string | null): string {
  return `tmux was not found, and every session runs inside tmux so it survives a host restart — no session was started. ` +
    `${tmuxInstallAdvice(platform, cmd)} Then try again (no restart needed).`;
}

/** `tmux -V` → the version as tmux prints it (`3.4`, `3.3a`, `next-3.5`), or null. */
export function parseTmuxVersion(out: string | null | undefined): string | null {
  const m = /tmux\s+(\S+)/.exec(out ?? "");
  return m ? m[1] : null;
}

/**
 * [major, minor] of a version string, or null when it is not a release number
 * (`master`, an unparsable build). `next-3.5` is a pre-release OF 3.5, so it
 * counts as 3.5.
 */
export function tmuxVersionNumber(v: string | null): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The oldest tmux the generated `tmux.conf` (`sessions/tmux.ts`'s
 * `ensureTmuxConf`) is written for: it sets `allow-passthrough`, an option tmux
 * added in 3.3. An older server reports the unknown option as a config error,
 * which tmux shows in the first pane — in view mode, where keystrokes are pager
 * commands and a delivery types into nothing.
 */
export const TMUX_MIN: [number, number] = [3, 3];

/** The locale the host hands its tmux clients: `LC_ALL` beats `LC_CTYPE` beats `LANG`. */
export function effectiveLocale(e: Record<string, string | undefined>): { name: string; value: string } | null {
  for (const name of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const value = e[name];
    if (value) return { name, value };
  }
  return null;
}

export interface TmuxFacts {
  /** The retired `<PREFIX>TMUX` knob's raw value, if the environment still sets it. */
  knob?: string;
  platform: NodeJS.Platform;
  /** Where tmux is, or null when it is not on PATH. */
  path: string | null;
  /** `tmux -V`'s output, or null when it could not be run. */
  versionOut: string | null;
  /** `tmuxInstallCommand` for this machine. */
  installCmd: string | null;
  /** The host process's own environment (only the locale variables are read). */
  env: Record<string, string | undefined>;
}

/**
 * The preflight rows: `tmux-knob` (only when the retired knob is still set),
 * `tmux` (present and its version) and
 * `tmux-locale` (the trap `docs/notes/protocol-and-security.md` describes: a
 * tmux client that cannot conclude its terminal is UTF-8 does not forward
 * UTF-8, and prompt detection loses its `❯`). The clients are spawned `-u` and
 * `ptyEnv()` supplies a UTF-8 `LANG` (`defaultLocale`) when the environment has NO locale, so
 * the only case left that can be seen from here is a locale that is SET and is
 * not UTF-8 — `ptyEnv` keeps that one, and the panes inherit it.
 */
export function tmuxChecks(f: TmuxFacts): Check[] {
  const out: Check[] = [];
  if (tmuxKnobSet(f.knob)) {
    const knob = envName("TMUX");
    out.push({
      id: "tmux-knob",
      status: "warn",
      detail: `${knob}=${(f.knob ?? "").trim()} is ignored: every session runs inside tmux, there is no direct mode any more`,
      fix: `Remove ${knob} from the host's environment and .env files.`,
    });
  }
  if (!f.path) {
    return [...out, {
      id: "tmux",
      status: "fail",
      detail: "tmux not found — the host refuses to start sessions without it",
      fix: `${tmuxInstallAdvice(f.platform, f.installCmd)} Sessions run inside tmux so they survive a host restart.`,
    }];
  }
  const v = parseTmuxVersion(f.versionOut);
  const n = tmuxVersionNumber(v);
  if (n && (n[0] < TMUX_MIN[0] || (n[0] === TMUX_MIN[0] && n[1] < TMUX_MIN[1]))) {
    out.push({
      id: "tmux",
      status: "warn",
      detail: `tmux ${v} is older than ${TMUX_MIN.join(".")}: the generated tmux.conf sets allow-passthrough, which it does not know`,
      fix: `Upgrade tmux${f.installCmd ? ` (${f.installCmd})` : ""}. An older tmux shows the config error in the first pane, where it swallows typed text.`,
    });
  } else {
    out.push({ id: "tmux", status: "ok", detail: `tmux ${v ?? "(version unknown)"} at ${f.path}` });
  }
  const loc = effectiveLocale(f.env);
  if (loc && !/utf-?8/i.test(loc.value)) {
    out.push({
      id: "tmux-locale",
      status: "warn",
      detail: `${loc.name}=${loc.value} is not a UTF-8 locale; the tmux panes inherit it`,
      fix: `Set ${loc.name === "LANG" ? "LANG" : `${loc.name} (or unset it)`} to a UTF-8 locale such as ${defaultLocale(f.platform)} in the host's environment, then restart the host.`,
    });
  } else {
    out.push({
      id: "tmux-locale",
      status: "ok",
      detail: loc ? `${loc.name}=${loc.value} (UTF-8)` : `no locale set; tmux clients get LANG=${defaultLocale(f.platform)} and -u`,
    });
  }
  return out;
}

export { onPath };

/**
 * Null when tmux can be spawned, else the sentence a session create is refused
 * with. Asked per spawn, uncached: a PATH scan is microseconds, and someone who
 * installs tmux after reading the sentence must not have to restart the host.
 */
export function tmuxRefusal(platform: NodeJS.Platform = process.platform): string | null {
  if (onPath("tmux")) return null;
  return tmuxMissingSentence(platform, tmuxInstallCommand(platform, (b) => onPath(b) !== null));
}
