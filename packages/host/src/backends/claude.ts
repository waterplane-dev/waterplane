/**
 * The `claude` CLI, as a descriptor — today's behaviour, gathered.
 *
 * Nothing in this file is new. Every constant and every branch below was
 * already running; it was just spread across `sessions.ts` (the argv and the
 * hook injection), six modules that each re-read `WATERPLANE_CLAUDE_BIN`, and
 * `deliver.ts` / `echo.ts` (the delivery literals). The move is what makes the
 * knowledge NAMEABLE — and, as a side effect, what makes "which of these is a
 * fact about claude rather than a fact about this app" answerable at all.
 *
 * **This file is a regression surface, not a design surface.** It is pinned by
 * `packages/host/test/backendargs.test.mjs` against the four launch modes
 * because the argv it builds is the difference between resuming a person's
 * conversation and silently starting a new one on top of it — a failure that
 * looks like nothing at all until the context they were relying on is gone.
 */
import { randomUUID } from "node:crypto";
import type { BackendFacts, PermissionMode } from "@waterplane/shared";
import { isLocalCommand, startsNoTurn } from "@waterplane/shared";
import { PASTE_CHIT } from "../echo.js";
import { COMPOSER_RULE_RE } from "../composer.js";
import type { CoreBackendDescriptor, LaunchPlan, LaunchRequest } from "./types.js";
import { claudeSources } from "./claude-sources.js";
import { claudeModels } from "./claudemodels.js";
import { ensureRepoClaudePlugin } from "../reposkill.js";
import { homedir } from "node:os";
import { claudeBinResolution } from "../claudebin.js";
import { claudeMissingRefusal } from "../doctorclaude.js";
import { env } from "../env.js";

/**
 * The binary, and the ONE place `WATERPLANE_CLAUDE_BIN` is read.
 *
 * It used to be read in six modules, each with its own `|| "claude"` — the kind
 * of duplication that is harmless until the seventh reader spells the default
 * differently, and invisible in review because every copy is correct on its
 * own. Read per call rather than captured at import so a caller that wants the
 * live value gets it; the module-level consts that hold it keep their existing
 * read-once-at-boot semantics by calling this once, exactly as before.
 */
export const claudeBin = (): string => env("CLAUDE_BIN") || claudeBinResolution().bin;

// ── claude hook lifecycle reporting ─────────────────────────────────────
// Every session we spawn carries hooks (injected via `claude --settings <json>`)
// that POST each lifecycle event back to the host at /api/hook → onHookEvent.
// This is the POSITIVE turn-boundary signal that replaces silence-guessing:
//   • SessionStart  → hands us the conversation id at boot (no dir polling)
//   • UserPromptSubmit → a turn started (readyForAutoFire goes false)
//   • Stop          → the turn finished and the session is at its prompt = READY
//   • PreToolUse, AskUserQuestion only → the question's own words BEFORE its box
//     is drawn: 2.1.304 writes the call to its log only once it is answered
//     (two smoke runs in three), so the log alone left the box unexplained.
//     The command prints nothing and exits 0, so it never decides anything.
// Hooks are ADDITIVE across settings sources, so the user's own hooks still run.
// Delivery is best-effort (curl, short timeout, `|| true` so it never blocks a
// turn); if it never arrives the session degrades to the old silence heuristics.
export function hookSettingsArg(port: number, askRules: readonly string[] = []): string {
  const url = `http://127.0.0.1:${port}/api/hook`;
  const cmd = `curl -sS -m 2 -X POST ${url} -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true`;
  const h = [{ hooks: [{ type: "command", command: cmd, timeout: 5 }] }];
  const hooks = { SessionStart: h, UserPromptSubmit: h, Stop: h, Notification: h, SessionEnd: h,
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: h[0].hooks }] };
  // Ask rules (agent-authority §2): a flag-passed `permissions.ask` stops the matching
  // command under every permission mode, `bypassPermissions` included, and outranks the
  // repo's own settings files. No rules ⇒ no key, so the blob is exactly what it was.
  return JSON.stringify(askRules.length ? { hooks, permissions: { ask: [...askRules] } } : { hooks });
}

/**
 * The composer's input row.
 *
 * **A second copy of `composer.ts`'s `COMPOSER_CURSOR_RE`, and it must not be
 * allowed to become a second OPINION.** That file keeps the const private and
 * is the last thing this refactor may touch (its rules were paid for by real
 * deliveries that stacked, vanished or pressed Return at an empty box), so the
 * descriptor DECLARES the rule here while `echo.ts` still owns it; the stage
 * that hands the regex to `echo.ts` is what deletes this duplicate.
 * `backendargs.test.mjs` asserts the two agree row-for-row in the meantime.
 *
 * `❯` ONLY, never a plain `>`: this CLI scrolls rather than repainting, so a
 * user turn that RAN sits in the scrollback as `> yes all 3` verbatim, and a
 * `>` row would let it read as a prompt sitting unsent in the box.
 */
const COMPOSER_CURSOR_RE = /^\u276f(?:[\s\u00a0]|$)/;

/**
 * The first-launch trust dialog, against a squashed screen.
 *
 * A never-trusted directory makes claude draw "Is this a project you trust?
 * 1. Yes …" before anything else, and an instruction typed into that dialog is
 * an instruction that answers it. Three spellings because the wording has moved
 * and the cost of missing it is a prompt delivered to a modal.
 */
const TRUST_PROMPT_RE = /trustthisfolder|createdoroneyoutrust|doyoutrust/;

/** The permission modes this binary accepts. Typed so a removal upstream
 *  breaks the build here rather than at a spawn six weeks later. */
const PERMISSION_MODES: readonly PermissionMode[] =
  ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"];

/**
 * argv for one launch — moved verbatim out of `SessionManager.create()`. Synchronous
 * (`BackendDescriptor.prepare`): the create spawns before its first `await`.
 *
 * Resume modes: "continue" → --continue (most recent conversation in this
 * dir); "pick" → --resume (claude's interactive session picker, so an OLDER
 * same-dir conversation can be chosen); "fork" → --fork-session (branch a
 * conversation under a NEW session id, leaving the original resumable on its
 * own). When `resumeSessionId` is known, continue/fork target that EXACT
 * conversation (`--resume <uuid>`) instead of the directory's most recent —
 * this is what lets several conversations per repo restore independently.
 */
function prepare(req: LaunchRequest): LaunchPlan {
  const missing = claudeMissingRefusal(env("CLAUDE_BIN"), claudeBinResolution(), homedir());
  if (missing) throw new Error(missing); // before any tmux spawn: the phone gets this sentence, not tmux's [exited]
  const { resumeMode, resumeSessionId: rid, launch, hookPort, askRules } = req;
  const args: string[] =
    resumeMode === "pick" ? ["--resume"]
    : resumeMode === "fork" ? (rid ? ["--resume", rid, "--fork-session"] : ["--continue", "--fork-session"])
    : resumeMode === "continue" ? (rid ? ["--resume", rid] : ["--continue"]) : [];
  // Fresh conversation → mint its claude session id ourselves (--session-id)
  // so it's individually resumable later without any detection.
  let sessionId: string | undefined;
  if (!resumeMode) {
    sessionId = randomUUID();
    args.push("--session-id", sessionId);
  } else if (resumeMode === "continue" && rid) {
    sessionId = rid; // resuming keeps the id (--fork-session is what mints a new one)
  }
  // Always pinned. Without a flag the CLI starts on `model` in
  // ~/.claude/settings.json — which its own `/model` overwrites ("saved as your
  // default for new sessions"), so one session's wheel switch would pick the
  // next session's model. `default` is the CLI's own spelling for the
  // account's built-in default, read past that file. Effort has no such
  // spelling (`--effort` takes a level only), so an unset effort still follows
  // the CLI's saved per-model level.
  args.push("--model", launch.model || "default");
  if (launch.effort) args.push("--effort", launch.effort);
  if (launch.permissionMode) args.push("--permission-mode", launch.permissionMode);
  if (launch.remoteControlled) args.push("--remote-control");
  // Report hook lifecycle events back to the host (turn boundaries + conversation
  // id). Additive to the user's settings; a stub binary (e2e) just ignores it.
  args.push("--settings", hookSettingsArg(hookPort, askRules));
  // Make the repo aware of the product: the core's repo-facing skill, as a plugin dir
  // (`reposkill.ts`). Absent when it could not be written — help, not a
  // precondition.
  const pluginDir = ensureRepoClaudePlugin(hookPort);
  if (pluginDir) args.push("--plugin-dir", pluginDir);
  // Told through that plugin dir, and only when it was written — a launch without it was
  // told nothing, and says so. The ask rules are the CLI's own `permissions.ask`.
  return { args, sessionId, instructionsVia: pluginDir ? "plugin-dir" : "none", askRulesVia: "native" };
}

/**
 * The one variable a claude session is spawned with beyond the PTY floor.
 *
 * `DISABLE_AUTOUPDATER=1` switches off the CLI's own auto-updater. Measured on
 * this desktop, 2026-09-30, on the npm-global route: every `claude` start — a
 * tab, a reopen, the per-turn `claude -p` summary — ran `npm view
 * @anthropic-ai/claude-code@latest version --prefer-online` and then
 * `npm install --global @anthropic-ai/claude-code@2.1.285` over the SAME
 * version that was already installed: five reinstalls of the package in 70 s,
 * underneath every live session, with `"autoUpdates": false` in
 * `~/.claude.json`. Sessions died unexplained inside that window, from the day
 * 2.1.285 arrived. The CLI changing under a daemon that drives it is this app's
 * decision, not the binary's — `update.ts` is the one updater, a tap on the
 * phone, never a side effect of opening a tab.
 *
 * Every other `claude` this daemon starts carries it too (`sidecar.ts`,
 * `usage.ts`): a headless call is a claude start like any other.
 * `packages/host/test/opencodebackend.test.mjs` pins it.
 */
export const CLAUDE_SPAWN_ENV: Readonly<Record<string, string>> = { DISABLE_AUTOUPDATER: "1" };

/** The `--effort` ladder the CLI accepts, in order (the phone's `CLAUDE_EFFORTS` until WP10 reads it off the wire). */
export const CLAUDE_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** claude's provider table; `claude-local`/`claude-endpoint` start from it. */
export const CLAUDE_FACTS: BackendFacts = {
  turns: [{ source: true }, { screen: "silence" }],
  dialogs: [{ screen: "claude-numbered" }],
  questions: [{ screen: "question-ts" }],
  plan: [{ screen: "planbox" }],
  asking: [{ screen: "question-ts" }],
  limits: [{ screen: "limit-ts" }],
  transcript: [{ store: "claude-jsonl" }],
  context: [{ screen: "context-meter" }, { store: "claude-jsonl" }],
  usage: [{ screen: "usage-probe" }],
  agents: [{ store: "claude-agents" }],
  conversations: [{ store: "claude-jsonl" }],
};

/**
 * The same CLI against an account that is NOT claude.ai's (`claude-local`, `claude-endpoint`):
 * the TUI's gauge assumes a window for the model id, and the limit wall and the `/usage`
 * report are claude.ai's — so those three providers are dropped and the facts are ABSENT.
 */
export const ACCOUNTLESS_CLAUDE_FACTS: BackendFacts = {
  ...CLAUDE_FACTS,
  context: [{ store: "claude-jsonl" }],
  limits: [],
  usage: [],
};

export const claudeBackend: CoreBackendDescriptor = {
  id: "claude",
  label: "Claude Code",
  bin: claudeBin,
  spawnEnv: CLAUDE_SPAWN_ENV,
  prepare,
  delivery: {
    submitKey: "\r",
    // `deliver.ts` spends this as the step of a bounded poll toward a quiet
    // window, not as a flat sleep — see `BackendDelivery.textThenSubmitDelayMs`.
    textThenSubmitDelayMs: 150,
    pastePlaceholder: PASTE_CHIT,
    composerCursorRe: COMPOSER_CURSOR_RE,
    composerRuleRe: COMPOSER_RULE_RE,
    trustPromptRe: TRUST_PROMPT_RE,
    // claude's own first-launch box is the one delivery answers itself (`deliverrun.ts`).
    autoAcceptsTrust: true,
    isLocalCommand,
    startsNoTurn,
  },
  caps: {
    turns: true,
    slash: "claude",
    remoteControl: true,
    effort: CLAUDE_EFFORTS,
    permissionModes: PERMISSION_MODES,
  },
  /**
   * The first full provider table (backend contract v2): every fact is answered by the module
   * that always answered it — this table only NAMES them (`derive.ts`). Turns: the hook pipe
   * (`claude-sources.ts`, in-band), then silence. Dialogs: `prompt.ts`, named rather than
   * `true` so a reader written for another TUI can never be armed against this one. Context:
   * the TUI's gauge, then the jsonl. The usage probe, the limit wall and the gauge are the
   * claude.ai account's — `claude-local`/`claude-endpoint` drop them.
   */
  facts: CLAUDE_FACTS,
  /**
   * THE catalogue (`claudemodels.ts`): built-ins plus the optional
   * `<config dir>/models.json`. The phone reads this off the wire and carries no
   * copy of its own. Read at prime time, so an edit needs a daemon restart.
   */
  async models() {
    return claudeModels();
  },
  healthScope: true,
  /**
   * The hook pipe above, consumed through the same seam as every other backend's
   * channel (`claude-sources.ts`, design §10): turn edges only, in-band, every
   * `Stop` held against the screen. `claude-local`/`claude-endpoint` spread it.
   */
  sources: claudeSources,
};
