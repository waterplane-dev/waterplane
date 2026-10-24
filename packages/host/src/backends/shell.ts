/**
 * A plain login shell in the repo — "full control from my phone" for the work
 * that is not a coding agent: a CLI login, a deploy, a `git` the agent should
 * not be doing (docs/analysis/shell-plan.md).
 *
 * Data like every backend, and no new function: the shell is spawned in tmux
 * like a claude session, typed into through `deliver.ts` unchanged (no composer
 * regexes ⇒ its distance rule; no hooks ⇒ the unhooked press-and-look, which
 * presses Return ONCE because `caps.turns` is false), and every claude-shaped
 * reader stays disarmed because its cap says the thing does not exist.
 *
 * **`$BROWSER` goes to the phone.** Every shell session's `BROWSER` is
 * `ensureBrowserShim`'s script: it POSTs the URL to `/api/shell/open` on
 * loopback with this session's id, and the host publishes it on the session's
 * `links` (`sessions/links.ts`) — so `gh auth login --web` opens on the phone
 * instead of on a desktop nobody is sitting at. The shim always exits 0: a CLI
 * whose browser "failed" falls back to printing the URL, which is fine too.
 *
 * Same boundary as a claude session (SECURITY.md): the same `session.create`
 * op, `containRepoDir`, the device token / Tailscale gate. A claude session in
 * bypass mode is already arbitrary execution; this widens nothing.
 */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envName } from "@waterplane/shared";
import { env, STATE_DIR } from "../env.js";
import { writeTextAtomic } from "../jsonstore.js";
import type { CoreBackendDescriptor, LaunchPlan, LaunchRequest } from "./types.js";

/** The binary: `WATERPLANE_SHELL_BIN`, else the person's own `$SHELL`, else `/bin/sh`. */
export const shellBin = (): string => env("SHELL_BIN") || process.env.SHELL || "/bin/sh";

/** The shim's file name under the state dir. */
export const BROWSER_SHIM = "browser-shim.sh";

/** The shim's text. The port is a fallback: the pane's own env names it first. */
export function browserShimText(port: number): string {
  const sess = envName("SESSION");
  const portVar = envName("HOOK_PORT");
  return [
    "#!/bin/sh",
    "# $BROWSER for a shell session: hand each URL to the phone (POST /api/shell/open,",
    "# loopback only). Always exits 0 — a CLI whose browser failed prints the URL instead.",
    `port="\${${portVar}:-${port}}"`,
    'for u in "$@"; do',
    `  curl -sS -m 2 -X POST "http://127.0.0.1:$port/api/shell/open" --data-urlencode "session=\${${sess}:-}" --data-urlencode "url=$u" >/dev/null 2>&1 || true`,
    "done",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Write `<state dir>/browser-shim.sh` (0700) where it differs, and return its
 * path.
 *
 * **A state dir whose path holds a space** breaks `$BROWSER` for every CLI
 * that shlex-splits the variable (Python's `webbrowser`, so gcloud; some Go
 * CLIs) — they try to run `/Users/me/My` with the rest as arguments. Not
 * quoted here on purpose: a CLI that does NOT split would then run a path with
 * literal quotes in it, which fails everywhere. Either way it fails SAFE: the
 * CLI's browser call fails, it prints the URL, and the screen reader
 * (`shelllinks.ts`) puts that on the phone instead. Never throws: a shim that could not be written is a `BROWSER` pointing
 * at nothing, and a CLI then prints its URL — the session still starts.
 */
export function ensureBrowserShim(port: number, dir: string = STATE_DIR): string {
  const path = join(dir, BROWSER_SHIM);
  const text = browserShimText(port);
  try {
    if (!(existsSync(path) && readFileSync(path, "utf8") === text)) writeTextAtomic(path, text, { mode: 0o700 });
    chmodSync(path, 0o700); // the umask, or an older copy, may have said otherwise
  } catch { /* see above */ }
  return path;
}

/**
 * What a shell does NOT inherit from this daemon: its API keys and key files
 * (`GEMINI_API_KEY`, the sidecar's, the endpoint backend's key file and
 * keychain entry — every knob of that shape, under any brand prefix). A shell
 * is a person's own login shell: its profile sets whatever THEY export, and a
 * secret the daemon was given for its own calls is not theirs to `env` out of
 * a pane on a phone. `LaunchPlan.dropEnv` patterns (`*` = suffix match).
 */
export const SHELL_DROP_ENV: readonly string[] = ["*_API_KEY", "*_KEY_FILE", "*_KEYCHAIN"];

function prepare(req: LaunchRequest): LaunchPlan {
  // A shell keeps no conversation; "continue" / "pick" / "fork" would be a
  // launch that silently means something else. Refused in words, before a spawn.
  if (req.resumeMode) throw new Error("A shell has no conversation to continue — open a new shell instead.");
  return {
    args: ["-l"],
    dropEnv: SHELL_DROP_ENV,
    // A shell is a person's own prompt: no agent to tell, no rule to hold.
    instructionsVia: "none",
    askRulesVia: "none",
    env: {
      BROWSER: ensureBrowserShim(req.hookPort),
      [envName("SESSION")]: req.hostSessionId ?? "",
      [envName("HOOK_PORT")]: String(req.hookPort),
    },
  };
}

export const shellBackend: CoreBackendDescriptor = {
  id: "shell",
  label: "Shell",
  bin: shellBin,
  spawnEnv: {},
  prepare,
  delivery: {
    submitKey: "\r",
    textThenSubmitDelayMs: 150,
    pastePlaceholder: null,
    composerCursorRe: null,
    composerRuleRe: null,
    trustPromptRe: null,
    isLocalCommand: () => false,
    startsNoTurn: () => false,
  },
  caps: {
    turns: false,
    slash: "none",
    remoteControl: false,
    permissionModes: [],
  },
  // A plain shell: no provider for anything — every fact ABSENT (`derive.ts`).
  facts: {},
  // No model: an empty catalogue, which the phone never asks about for `kind: "shell"`.
  async models() { return { aliases: [], ids: [] }; },
  healthScope: false,
};
