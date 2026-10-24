/**
 * The launch half of a plugin backend (contract 2.0): what `prepare` is handed and answers, and the
 * provider table (`facts`) and binary caps a `PluginBackendDef` declares. Split out of `plugin.ts`
 * for size only; `plugin.ts` re-exports all of it, so it is the same contract and the same docs.
 */
import type { LaunchOpts, PermissionMode } from "./wire/session.js";

/** What `prepare` is handed. `hookPort` is the daemon's loopback port. */
export interface PluginLaunchRequest {
  readonly resumeMode?: "continue" | "pick" | "fork";
  readonly resumeSessionId?: string;
  readonly launch: LaunchOpts;
  readonly hookPort: number;
  /** The session's working directory (realpath) and the host's own id for it (2.0: always set). */
  readonly cwd: string;
  readonly hostSessionId: string;
  /** Fork `resumeSessionId` AT this turn — only reaches a backend with `forkVia: "server"`. */
  readonly forkAtTurn?: string;
  /**
   * The core's repo-facing text (`reposkilltext.ts`), the ONE text every agent is told: the
   * outbox, the inbox, builds, screenshots. The plan says how it reached the CLI
   * (`instructionsVia`): e.g. `files: [{ path: "session:instructions/AGENTS.md", content:
   * req.instructions }]` plus an `env` value `"session:instructions"`, which the host
   * resolves to that directory's absolute path (`"env-file"`).
   */
  readonly instructions: string;
  /** Ask rules already cut for this repo (`shared/askrules.ts`); the plan says how they hold (`askRulesVia`). */
  readonly askRules: readonly string[];
}

/** How the core's `instructions` reached the CLI; `"none"` is published so the phone can say so. */
export type InstructionsVia = "plugin-dir" | "env-file" | "config" | "flag" | "none";
/** How the ask rules hold: the CLI's own policy, the host's answer gate on dialogs, or not at all. */
export type AskRulesVia = "native" | "gate" | "none";

/**
 * What `prepare` answers. `sessionId` is CLAUDE's conversation uuid only (a
 * reader turns it into a path under claude's projects dir); any other CLI's id
 * rides on `backendSessionId`, and only when the launch KNOWS it. `env` is
 * merged after `spawnEnv` into the pane's environment.
 */
export interface PluginLaunchPlan {
  readonly args: string[];
  readonly sessionId?: string;
  readonly backendSessionId?: string;
  readonly createsRecord?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  /** Variables the pane must NOT inherit from the daemon: exact names, or `*_SUFFIX` (2.0). */
  readonly dropEnv?: readonly string[];
  /** Spawn THIS program in the PTY instead of `bin()` (absolute path), `args` as its argv — e.g. a
   *  POSIX `sh` that waits for the backend's own server, then `exec`s the CLI. */
  readonly exec?: string;
  readonly instructionsVia: InstructionsVia;
  readonly askRulesVia: AskRulesVia;
  /**
   * Written by the HOST before spawn. `session:<name>` ⇒
   * `<state dir>/launch/<hostSessionId>/<name>`; an absolute path is refused unless inside the
   * plugin's `dataDir` (realpath). Never the repo, never `~/.<cli>`. In an `env` value, an item
   * (comma-separated) spelled `session:<name>` is replaced by that path, so a variable can
   * name a launch file or directory; any other item is passed as written.
   */
  readonly files?: readonly { path: string; content: string; mode?: number }[];
}

/**
 * One way a fact can be answered, in the order the host asks (`facts`):
 *  - `{source: true}` — ask `sources.<fact>` (re-read per call; a getter may switch it off);
 *  - `{screen}` — a NAMED screen reader: core's (below) or one `api.screenReader` contributed;
 *  - `{store}` — a NAMED store reader: core's `claude-jsonl`, or one `api.storeReader` contributed.
 * A provider answering null passes to the next; an empty walk is ABSENT, never a guess.
 */
export type Provider =
  | { source: true }
  | { screen: string }
  | { store: string };

export type FactName = "turns" | "dialogs" | "questions" | "plan" | "delivery" | "transcript"
  | "context" | "tokens" | "usage" | "agents" | "conversations" | "asking" | "limits" | "mode" | "commands";
export const FACT_NAMES: readonly FactName[] = ["turns", "dialogs", "questions", "plan", "delivery", "transcript",
  "context", "tokens", "usage", "agents", "conversations", "asking", "limits", "mode", "commands"];
/**
 * The providers per fact. A fact left out has none — ABSENT. Core names per fact (the host
 * refuses any other at registration, naming the ones it has):
 *  turns: screen `silence` · dialogs: screen `claude-numbered` (+ contributed screen readers) ·
 *  questions / asking: screen `question-ts` · plan: screen `planbox` · context: screen
 *  `context-meter` · limits: screen `limit-ts` · usage: screen `usage-probe` · transcript /
 *  context / conversations / tokens: store `claude-jsonl` (+ contributed store readers) ·
 *  agents: store `claude-agents`. `delivery`, `mode` and `commands` (2.2) take `{source:true}` only.
 */
export type BackendFacts = Partial<Record<FactName, readonly Provider[]>>;

/** Facts about the BINARY — what it accepts, never which reader answers what (that is `facts`). */
export interface BackendCapsV2 {
  /** False = a plain shell: no turns, no idle ping, no model-made tab name. */
  turns: boolean;
  /** Whose slash-command vocabulary the composer speaks. */
  slash: "claude" | "own" | "none";
  /** The reasoning-effort ladder the binary accepts, in order; absent = no knob. Measured, never guessed. */
  effort?: readonly string[];
  /** The permission modes it accepts, in the order offered; empty = no such concept. */
  permissionModes: readonly PermissionMode[];
  /**
   * 2.2: the subset of `permissionModes` a session can START in; absent = all of them. Non-empty,
   * each mode once. Narrowing it refuses a stored launch (backlog, schedule, intent, fork, limit
   * relaunch) whose mode falls outside, in words at create.
   */
  launchModes?: readonly PermissionMode[];
  /** It accepts a remote-control flag. */
  remoteControl: boolean;
}
