/**
 * The claude half of the preflight: is the binary there, which version, and is it
 * signed in. The sign-in read is also asked on request paths (the onboarding plan,
 * a peer's hello), cached in `claudeSignInState`.
 */

import { homedir } from "node:os";
import { BRAND, envName, claudeNewerThanTested } from "@waterplane/shared";
import { env } from "./env.js";
import { claudeBinResolution, tilde } from "./claudebin.js";
import { run, which } from "./doctorproc.js";
import type { Check } from "./doctor.js";

/** Anthropic's native installer — the route the installer, Docker and WSL setup name too. */
export const CLAUDE_INSTALL_CMD = "curl -fsSL https://claude.ai/install.sh | bash";

/** How to sign in, said once for the doctor, the onboarding plan and a peer's row. */
export const CLAUDE_SIGN_IN_FIX =
  "Sign in from the phone: open any session on this desktop, tap its sign-in button, sign in in the browser, then tap paste code. (Or run `claude` once in a terminal here.) Sessions stop at the sign-in screen until then.";

/**
 * A signed-out claude is a FAIL only when this desktop gives no sign that it runs claude without an
 * account. `claude-local` (Ollama) and `claude-endpoint` launch with `ANTHROPIC_AUTH_TOKEN` of their
 * own and never read the login, so for a person on those alone "not signed in" is a note, not a
 * broken setup. The signs: a recent session on either backend, or an endpoint URL configured.
 */
export function signedOutStatus(usedBackends: readonly string[], endpointUrl: string): "warn" | "fail" {
  return usedBackends.some((b) => b === "claude-local" || b === "claude-endpoint") || endpointUrl.trim() ? "warn" : "fail";
}

/** Said beside a signed-out claude: a local model needs no account, so the row may not apply. */
export const NO_ACCOUNT_NOTE =
  "Only running local models through Ollama (or your own endpoint)? They need no Claude account; ignore this.";

/** `claude auth status` output → signed in, signed out, or unreadable (null — never a guess). */
export function classifyClaudeAuth(out: string): "in" | "out" | null {
  const text = out.toLowerCase();
  if (/loggedin["\s:]*false|not logged in|logged out|please run.*login/.test(text)) return "out";
  if (/loggedin["\s:]*true|logged in|authenticated/.test(text)) return "in";
  return null;
}

let authCache: { bin: string; at: number; state: "in" | "out" | null } | null = null;
let authInflight: Promise<"in" | "out" | null> | null = null;

/**
 * Is claude signed in on this desktop, for a request path (the onboarding plan, a peer's hello).
 * Cached — each read spawns `claude`: a yes for 5 minutes, a no or an unreadable answer for 15 s,
 * so signing in shows up on the next look. Never throws; a failure is null.
 */
export async function claudeSignInState(bin: string, now = Date.now()): Promise<"in" | "out" | null> {
  if (authCache && authCache.bin === bin && now - authCache.at < (authCache.state === "in" ? 300_000 : 15_000)) return authCache.state;
  authInflight ??= (async () => {
    try {
      const resolved = await which(bin);
      const state = resolved ? classifyClaudeAuth((await run(resolved, ["auth", "status"], 15000)).out) : null;
      authCache = { bin, at: Date.now(), state };
      return state;
    } catch { return null; } finally { authInflight = null; }
  })();
  return authInflight;
}

export async function checkClaude(bin: string, usedBackends: readonly string[]): Promise<Check[]> {
  const resolved = await which(bin);
  const res = claudeBinResolution();
  const home = homedir();
  if (!resolved) {
    const tried = res.tried.length ? ` Looked in: ${res.tried.map((t) => tilde(t, home)).join(", ")}.` : "";
    const win = res.windowsSide
      ? ` Claude is installed on the Windows side (${res.windowsSide}), but WSL cannot use that one — install it inside WSL too, in the WSL shell: \`npm i -g @anthropic-ai/claude-code\` or the native installer.`
      : "";
    return [{
      id: "claude-binary",
      status: "fail",
      detail: `\`${bin}\` not found — ${BRAND.name} currently drives Claude Code primarily (other CLIs come as plugins)`,
      fix: `Install Claude Code: \`${CLAUDE_INSTALL_CMD}\` (or \`npm i -g @anthropic-ai/claude-code\`), or point ${envName("CLAUDE_BIN")} at the binary. It runs on a paid Claude plan or an Anthropic API key — or, with no account, on a local model through Ollama.${tried}${win}`,
    }];
  }
  const out: Check[] = [];
  const ver = await run(resolved, ["--version"]);
  const verLine = ver.ok && ver.out ? ver.out.split("\n")[0] : "";
  out.push({
    id: "claude-binary",
    status: "ok",
    detail: bin === res.bin && res.source === "found"
      ? `claude${verLine ? ` ${verLine}` : ""} at ${tilde(resolved, home)} (not on PATH — found in a usual install location)`
      : `${resolved}${verLine ? ` (${verLine})` : ""}`,
  });
  // Newer than the build the heuristics were checked against: a warning with the
  // remedy already in the product (clihealth), never a refusal. Absent when the
  // version could not be read.
  const newer = ver.ok ? claudeNewerThanTested(ver.out.split("\n")[0]) : null;
  if (newer) out.push({ id: "claude-version", status: "warn", detail: newer });

  // Sessions spawn fine when logged out — they just die on the login screen,
  // which looks like "the app is broken" from the phone.
  const auth = await run(resolved, ["auth", "status"], 15000);
  const state = classifyClaudeAuth(auth.out);
  if (state === "in") {
    out.push({ id: "claude-login", status: "ok", detail: "claude is signed in" });
  } else if (state === "out") {
    out.push({
      id: "claude-login",
      status: signedOutStatus(usedBackends, env("CLAUDE_ENDPOINT_URL") || ""),
      detail: "claude is not signed in",
      fix: `${CLAUDE_SIGN_IN_FIX} Signing in needs a paid Claude plan (Pro, Max, Team) or an Anthropic Console account (pay per use). ${NO_ACCOUNT_NOTE}`,
    });
  } else {
    out.push({
      id: "claude-login",
      status: "warn",
      detail: "couldn't read `claude auth status` (CLI output may have changed)",
      fix: "Check from the phone: open a session on this desktop; if it shows a sign-in screen, use its sign-in button.",
    });
  }
  return out;
}
