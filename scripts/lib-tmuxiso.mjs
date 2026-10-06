// Every test's tmux runs in a socket directory of its own.
//
// tmux is the ONE session substrate (there is no direct-PTY mode to pin), so
// every host a test boots spawns its sessions inside tmux. The owner's live
// server is `-L <brand>` in the DEFAULT socket directory (`/tmp/tmux-<uid>/`),
// and a host keyed on a temp root already derives a server name of its own —
// but a name is only a name. A private `TMUX_TMPDIR` moves the whole socket
// directory, so no `-L` name a test (or a host it boots) could pick resolves to
// the live server's socket; `TMUX` is deleted too, because inside a tmux pane it
// points a bare `tmux` command at the server that pane belongs to.
//
// tmux servers daemonize out of the process group, so killing a script's group
// does not reach them: every server in the directory is killed on the way out
// (exit, failure, ctrl-C), and the directory removed. A parent that already
// isolated its children (`run-e2e.mjs`) owns the cleanup instead; the child
// keeps the directory it was handed.
//
// Imported for its effect by `lib-brand.mjs` (so every e2e script) and by the
// host tests that start sessions.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set beside `TMUX_TMPDIR` by whoever created the directory, so a child knows it was isolated. */
export const ISO_MARK = "E2E_TMUX_TMPDIR";

/** A fresh socket directory, short enough for a unix socket path (104 bytes on macOS). */
export function makeTmuxDir() {
  const base = tmpdir().length <= 40 ? tmpdir() : "/tmp";
  return mkdtempSync(join(base, "tmx-"));
}

/** The env a child gets to run on `dir`: its own socket directory, no inherited `TMUX`. */
export function tmuxIsoEnv(env, dir) {
  const out = { ...env, TMUX_TMPDIR: dir, [ISO_MARK]: dir };
  delete out.TMUX;
  return out;
}

/**
 * Kill every tmux server in THIS process's socket dir and keep the dir — what a
 * machine reboot does to sessions: the daemon AND every pane go. A script whose
 * subject is "the sessions did not come back" calls it between stopping its host
 * and booting the next one (a plain host restart no longer kills anything).
 */
export function killTmuxServers() { killServersIn(process.env.TMUX_TMPDIR); }

/** Kill every tmux server whose socket is in `dir`, then remove `dir`. Never throws. */
export function killTmuxIn(dir) {
  if (!dir) return;
  killServersIn(dir);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function killServersIn(dir) {
  if (!dir) return;
  const env = { ...process.env, TMUX_TMPDIR: dir };
  delete env.TMUX;
  let uid = "";
  try { uid = String(process.getuid()); } catch { /* no uid */ }
  const sockDir = join(dir, `tmux-${uid}`);
  let names = [];
  try { names = readdirSync(sockDir); } catch { /* no server was ever started */ }
  for (const n of names) {
    try { execFileSync("tmux", ["-S", join(sockDir, n), "kill-server"], { stdio: "ignore", env, timeout: 5000 }); } catch { /* already gone */ }
  }
}

let owned = null;

/** Isolate THIS process (and everything it spawns with `...process.env`). Idempotent. */
export function isolateTmux() {
  delete process.env.TMUX;
  const handed = process.env[ISO_MARK];
  if (handed && process.env.TMUX_TMPDIR === handed && existsSync(handed)) return handed;
  if (owned) return owned;
  owned = makeTmuxDir();
  process.env.TMUX_TMPDIR = owned;
  process.env[ISO_MARK] = owned;
  const dir = owned;
  process.on("exit", () => killTmuxIn(dir));
  // A signal kills the servers first; the process then ends the way it would
  // have without us — by our exit when nobody else listens, else by the
  // script's own handler (whose exit runs the `exit` hook above again, harmlessly).
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const onSig = () => {
      killTmuxIn(dir);
      if (process.listeners(sig).every((l) => l === onSig)) process.exit(code);
    };
    process.on(sig, onSig);
  }
  return owned;
}

isolateTmux();
