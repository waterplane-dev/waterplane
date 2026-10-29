/**
 * What a coding-agent backend IS, as far as this daemon is concerned.
 *
 * waterplane's central design choice is that it drives the real binary in a
 * pseudo-terminal and never re-implements it. That choice is what makes a
 * SECOND binary conceivable at all — but it is also what makes the knowledge
 * about the first one invisible: today the string `claude`, the argv it
 * accepts, the shape of its composer box, the words of its trust prompt and
 * the fact that it can be handed hooks through `--settings` are scattered
 * across eight modules as bare literals, and nothing in the type system says
 * they belong together.
 *
 * A descriptor is that scattered knowledge, gathered and named. It is DATA plus
 * a few functions, deliberately: `bin()` and `prepare()` are what a backend
 * has to COMPUTE to start, and `models()`, `measured.version()` and
 * `delivery.isLocalCommand` / `startsNoTurn` joined them later; everything
 * else is a constant or a regex. Another function per backend goes back
 * through review: it is a sign this is growing into a plugin interface.
 *
 * ── The rule that makes a second backend safe ───────────────────────────────
 *
 * `caps` and `facts` (through `derive.ts`) are read ONLY to decide whether a
 * reader runs at all — never to decide what it answers. This repo's standing rule is that a heuristic degrades to
 * null or absent and never to a wrong number, so a backend that declares FEWER
 * capabilities is structurally incapable of making anything WORSE: the context
 * meter that is not armed publishes nothing, and the phone already renders
 * "nothing here is measured" differently from "0%". A cap that gated the
 * CONTENT of an answer instead of its existence would break that property, and
 * is the one thing this shape must not be used for.
 *
 * Nothing here applies itself either: a descriptor produces argv and constants,
 * never a mutation and never a refusal. `resolveBackend()` in `./index.ts` is
 * where an unknown id turns into a sentence a person can act on.
 */
import type { AskRulesVia, BackendFacts, BackendSources, InstructionsVia, LaunchOpts, PermissionMode } from "@waterplane/shared";

/** Whose slash-command vocabulary the composer is speaking. */
export type BackendSlash = "claude" | "own" | "none";

/**
 * Facts about the BINARY (backend contract v2): what it accepts, never which reader answers
 * what. Every question about READERS — is there a transcript, which box reader, is there a
 * context gauge, an account limit, a box-less question — is `facts` now, asked through
 * `derive.ts`, so a cap and a source can never disagree.
 */
export interface BackendCaps {
  /**
   * The session has TURNS: words go in, the binary works, then it stops at its
   * prompt again. False = a plain shell (`shell.ts`), where silence is not a
   * finished turn — so `turn.ts` emits no idle, no "Turn finished" ping and no
   * turn end, `record.ts` buys no model-made tab name, and an unhooked delivery
   * presses Return ONCE (a second Return in a shell is a second empty command).
   * Gates whether those readers run, never what they answer.
   */
  readonly turns: boolean;
  /** Whose slash commands the composer accepts. */
  readonly slash: BackendSlash;
  /** The reasoning-effort ladder the binary accepts, in order; absent = no knob. */
  readonly effort?: readonly string[];
  /** The permission modes this binary accepts, in the order they are offered. */
  readonly permissionModes: readonly PermissionMode[];
  /** 2.2: the subset of `permissionModes` a session can START in; absent = all of them (`launchModesOf`). */
  readonly launchModes?: readonly PermissionMode[];
  /** 2.3: the native unit this backend bills in ("AI credits"); absent = tokens or dollars. */
  readonly spendUnit?: string;
  /** The binary accepts a remote-control flag. */
  readonly remoteControl: boolean;
}

/**
 * The literals "type into a live session and confirm" rests on.
 *
 * These are today hard-coded inside `deliver.ts` / `echo.ts`, which is correct
 * while there is one backend and a liability the moment there are two. They are
 * DECLARED here first and consumed later, on purpose: `deliver.ts` is the one
 * implementation of delivery in this app and the file with the most expensive
 * failure history in it, so it is the LAST thing a multi-backend change
 * touches, not the first.
 *
 * A null regex is not "the empty pattern" — it is "this backend gives no such
 * structural anchor", and the reader is expected to fall back to whatever it
 * does when its anchor is missing (for the composer that is `deliver.ts`'s
 * existing distance rule at `FALLBACK_ROWS`). Same degradation as everywhere
 * else here: no anchor ⇒ the old behaviour, never a brick.
 */
export interface BackendDelivery {
  /** The keystroke that submits the composer. */
  readonly submitKey: string;
  /**
   * Typed words are swallowed when the side channel is down (opencode's TUI
   * attached to a dead `serve`), so `deliver.ts` answers `retry` with a sentence
   * rather than type into it. Absent = false.
   */
  readonly requiresChannel?: boolean;
  /**
   * How long to wait between the text landing and the submit keystroke.
   *
   * The claude path does not spend this as a flat sleep: it polls toward a
   * quiet window and breaks early (`deliver.ts`), and this is the step it
   * sleeps between looks. A backend with no such signal spends it flat.
   */
  readonly textThenSubmitDelayMs: number;
  /**
   * The TUI's collapsed-paste placeholder, against a `squash`ed haystack.
   *
   * "Squashed" is `echo.ts`'s `squash()` — whitespace removed, lower-cased — and
   * it is not negotiable per backend: `collapsedPasteEcho` matches this against
   * one haystack, so a value written against the RENDERED screen is a regex that
   * can never fire, surfacing only as unexplained `unconfirmed` verdicts. A
   * backend whose chit was measured on the rendered screen states the transform
   * it applied (see `opencode.ts`).
   *
   * **Capture group 1 is the number of lines the chit is HIDING** — the only
   * thing a placeholder says about the text behind it, and what
   * `collapsedPasteEcho` reads to decide whether it accounts for essentially all
   * of the delivery. A pattern with no group makes that read `NaN`.
   */
  readonly pastePlaceholder: RegExp | null;
  /** The composer's input row — what identifies the box the user types into. */
  readonly composerCursorRe: RegExp | null;
  /** The composer's own full-width rules, above and below the input row. */
  readonly composerRuleRe: RegExp | null;
  /**
   * An EMPTY composer's hint text, where the TUI draws it in a colour rather
   * than dim (`composer.ts`'s `composerHeld` already discounts dim cells). Tested
   * against the held text with its whitespace runs collapsed. Absent/null = the
   * backend draws no such hint, or draws it dim.
   */
  readonly composerPlaceholderRe?: RegExp | null;
  /** The first-launch "do you trust this directory" dialog, squashed. Read by `derive.ts`'s
   *  `trustRule`: delivery refuses in words while it (or claude's words) is on screen. */
  readonly trustPromptRe: RegExp | null;
  /**
   * Delivery may ANSWER that box itself (`deliver/deliverrun.ts`, `trustKeys`) and auto-fire may
   * walk into it. Only `backends/claude.ts` sets it (claude-local and claude-endpoint spread it);
   * a plugin's `delivery` can never carry it (`pluginapi.ts`'s `normDelivery` builds a fresh
   * object). Absent ⇒ another CLI's trust question is a person's call: nothing typed.
   */
  readonly autoAcceptsTrust?: boolean;
  /**
   * Is this text a command the TUI handles ITSELF, by opening a VIEW?
   *
   * A local command starts no turn and writes no user turn to any log, so every
   * proof that rests on either is unavailable for it — which is a fact about
   * the BACKEND's vocabulary, hence its place here.
   */
  isLocalCommand(text: string): boolean;
  /**
   * Is this text a command that starts no turn — whether or not it opens a view?
   *
   * The wider of the two, and the one the submit contract hangs off. Every
   * `isLocalCommand` is one of these; claude's `/btw` is the case that is ONLY
   * one of these — it submits, files a note and clears the composer, opening
   * nothing. Splitting them is what stops a filed note being reported as
   * `unsubmitted` while still letting the phone interject it mid-turn, which is
   * the only thing it is for (`shared/slash.ts`).
   */
  startsNoTurn(text: string): boolean;
}

/** What a launch needs to know, from the caller's side. */
export interface LaunchRequest {
  /**
   * "continue" → the directory's most recent conversation; "pick" → the CLI's
   * own interactive picker (so an OLDER same-dir conversation can be chosen);
   * "fork" → branch a conversation under a NEW id, leaving the original
   * resumable on its own. Absent ⇒ a fresh conversation.
   */
  readonly resumeMode?: "continue" | "pick" | "fork";
  /** The exact conversation to continue/fork, when it is known. */
  readonly resumeSessionId?: string;
  /** Model / effort / permission mode / remote control, as the client asked. */
  readonly launch: LaunchOpts;
  /** Loopback port the host's `/api/hook` sink is listening on. */
  readonly hookPort: number;
  /**
   * The session's working directory and this host's own id for it. A backend that
   * brings up a per-session server before its TUI (`opencode.ts`: one `serve` per
   * session, keyed by this id) needs both; every other backend ignores them.
   */
  readonly cwd?: string;
  readonly hostSessionId?: string;
  /**
   * Fork `resumeSessionId` AT this turn (`TranscriptTurn.id`) rather than whole —
   * only for a backend whose server forks (`forkVia: "server"`); a claude
   * fork-at-turn is a file copy done before the launch and never reaches here.
   */
  readonly forkAtTurn?: string;
  /**
   * Claude Code permission rules this launch must ASK before running
   * (`shared/askrules.ts`, already cut for this repo). The claude backends put them
   * in the `--settings` blob (`permissions.ask`, `askRulesVia: "native"`); a plugin
   * answering `"gate"` has the answer gate hold them (`answergate.ts`). Absent/empty ⇒
   * the launch is byte-identical to one made before ask rules existed.
   */
  readonly askRules?: readonly string[];
  /**
   * The core's repo-facing text (`reposkill.ts`'s `repoInstructions`, the ONE text
   * every agent is told: outbox, inbox, builds, screenshots). claude ignores it — its
   * copy is the `--plugin-dir` plugin, written from the same text; a plugin backend
   * says how it reached its CLI (`instructionsVia`). Absent = "" (a test, `--doctor`).
   */
  readonly instructions?: string;
}

/** One file the HOST writes before the spawn (`launchfiles.ts`): `session:<name>` lands in
 *  `<state dir>/launch/<hostSessionId>/<name>`; an absolute path only inside the plugin's
 *  `dataDir`. Anything else refuses the launch in words. */
export interface LaunchFile { readonly path: string; readonly content: string; readonly mode?: number }

export interface LaunchPlan {
  /** argv after the binary. */
  readonly args: string[];
  /**
   * The conversation id this launch is KNOWN to run under, when it is knowable
   * at spawn time: minted here for a fresh conversation, carried through for a
   * `--resume <id>`, and ABSENT when only the CLI can know it (the picker, a
   * fork, a bare `--continue`) — those are adopted later from the log.
   *
   * PLAN.md calls this `mintedSessionId`. Renamed because it also carries the
   * id of a conversation we are RESUMING, which nothing here minted, and a
   * field whose name is true in only one of its two cases is a field that will
   * eventually be read wrong.
   */
  readonly sessionId?: string;
  /**
   * The BACKEND's own conversation id, for a backend that is not claude.
   *
   * A separate field from `sessionId` for the reason stated on
   * `SessionInfo.backendSessionId`: `sessionId` lands in `claudeSessionId`, and
   * every log reader here turns that into a path under `~/.claude/projects`. An
   * opencode `ses_…` there is a reader pointed at a file that cannot exist.
   *
   * **Only ever set where the launch KNOWS the id** — an exact `--session <id>`.
   * A fork mints a new conversation this host has not been told the id of, and
   * a bare `--continue` resolves to whichever conversation the binary picks; in
   * both cases the plan claims nothing and the id is DISCOVERED afterwards
   * (`sessions/convid.ts`'s opencode id watcher), or stays absent.
   */
  readonly backendSessionId?: string;
  /**
   * Does this launch CREATE the backend's conversation record, or join one that
   * already exists?
   *
   * The one consumer is the opencode id watcher, and it is not a detail. Its
   * first rung says "exactly one top-level conversation in this directory,
   * created since we spawned, is ours" — which is sound only where OUR OWN
   * SPAWN is what wrote that row. A fresh launch and a `--fork` do write one. A
   * bare `--continue` does NOT: it reopens a conversation whose `time_created`
   * is old, so it can never be its own rung-1 candidate, and any single fresh
   * row that shows up in the window is by construction SOMEBODY ELSE'S —
   * a second waterplane session starting in the same repo, or a hand-driven one. The
   * watcher adopting it points the reader at a stranger's conversation with
   * nothing on screen saying so, and leaves the session that really owns that
   * row unable to adopt its own id for ever.
   *
   * So the entitlement has to travel WITH the launch: `detectBackendId` runs
   * long after `create()` has forgotten which mode it asked for.
   *
   * **Absent means "no", and that is the safe direction.** A launch that does
   * not say so is one the watcher will only resolve from its second rung (a
   * prompt it watched land), and the worst that costs is an id staying absent
   * while the reader keeps answering its approximate document. `backends/claude.ts`
   * sets it nowhere: claude MINTS its id with `--session-id` when it creates a
   * conversation, and `detectClaudeId`'s rule is about files on disk, so nothing
   * on that path has ever asked this question.
   */
  readonly createsRecord?: boolean;
  /**
   * Environment for THIS launch (`ANTHROPIC_BASE_URL` for claude-local), merged
   * AFTER the descriptor's `spawnEnv` into the pane's `env(1)` prefix and the
   * direct spawn alike. Absent = nothing per-launch.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Variables the PANE must NOT inherit from this daemon: exact names, or a
   * `*` prefix for a suffix match (`*_API_KEY`). Resolved against the daemon's
   * own environment at spawn and passed as `env -u` on the pane's command line
   * (`sessions/tmux.ts`, `droppedEnvNames`) — the tmux server's global env is
   * where they would otherwise come from. A name `env` sets is never dropped.
   * The shell drops the daemon's secrets (`backends/shell.ts`); absent = none.
   */
  readonly dropEnv?: readonly string[];
  /**
   * Spawn THIS program in the PTY instead of `bin()`, with `args` as its argv.
   * opencode's hybrid launch: a POSIX `sh` that waits for the daemon to bring the
   * backend's server up, then `exec`s `<bin> attach …` — so the TUI is still the
   * PTY's own process. `bin()` keeps naming the CLI (version, doctor, exit report).
   */
  readonly exec?: string;
  /**
   * How the core's instructions reached the CLI — published as `SessionInfo.told`, so a
   * session that was NOT told about the outbox (`"none"`) says so on the phone.
   */
  readonly instructionsVia: InstructionsVia;
  /** How the ask rules hold: the CLI's own policy (`native`), the host's answer gate on
   *  the dialogs it poses (`gate`), or not at all (`none`) — `SessionInfo.askRulesVia`. */
  readonly askRulesVia: AskRulesVia;
  /**
   * Files the host writes BEFORE the spawn (`launchfiles.ts`). An `env` value item
   * spelled `session:<name>` (comma-separated items, each on its own) names one of them
   * by its absolute path — how a CLI that reads instructions from a directory
   * (`COPILOT_CUSTOM_INSTRUCTIONS_DIRS`, `instructionsVia: "env-file"`) is pointed at it.
   */
  readonly files?: readonly LaunchFile[];
}

/** The model catalogue a launch may choose from. */
export interface BackendModels {
  /** Short aliases the binary understands (`opus`, `sonnet`, …). */
  readonly aliases: readonly string[];
  /** Full model ids. */
  readonly ids: readonly string[];
  /**
   * Where each id RUNS — see `shared/wire/backend.ts`'s `models.where`, which
   * this is quoted into wholesale.
   *
   * **Absent means the host could not determine it**, and an id missing from a
   * present map means the same thing for that one model. Neither is "hosted".
   * Only the backend can answer this at all (it is a fact about a provider's
   * base URL, not about the id's spelling), and a backend that cannot answer
   * says nothing rather than guessing — the picker then looks exactly as it did
   * before this field existed.
   */
  readonly where?: Readonly<Record<string, "local" | "hosted">>;
  /**
   * Ids the backend PRICES AT ZERO — measured from its own catalogue, never
   * inferred from a `-free` in the name.
   *
   * Absent, or an id missing from it, means the price is unknown. Unknown must
   * never render as "free": that is the direction that costs somebody money.
   */
  readonly zeroCost?: readonly string[];
  /**
   * How many tokens of context each id is CONFIGURED to hold, keyed exactly as
   * `ids` spells them.
   *
   * Never `BackendInfo.contextWindowTokens`, because the number is a fact about
   * one MODEL and that field is a fact about a backend; it rides per id as
   * `BackendInfo.models.contextWindow`, where only `windowAdviceText` reads it.
   * The host's consumer is the context graph's y axis, through
   * `ContextWindowSource: "config"`, which exists precisely so the caption can
   * ATTRIBUTE the number instead of presenting it as a measurement: it is what
   * the tool believes it is allowed to send, not something anybody watched
   * happen, and a local runner may be holding a smaller context than the
   * configuration claims.
   *
   * **Absent, or an id missing from it, is UNKNOWN.** A zero is never stored —
   * opencode's own catalogue reports `limit.context: 0` for at least one local
   * provider (measured: ollama), and a 0 rendered as a window would put every
   * reading at infinite percent.
   */
  readonly contextWindow?: Readonly<Record<string, number>>;
  /**
   * Input tokens of the first request of the most recently written conversation
   * that ran each id, off the CLI's own log (`backends/overhead.ts`) — what the
   * CLI's own prompt took before the conversation began. MEASURED or absent.
   */
  readonly overheadTok?: Readonly<Record<string, number>>;
  /**
   * A sentence saying why this backend cannot be launched right now (its
   * runner is not reachable). The backend is LISTED with it, never hidden.
   */
  readonly unavailable?: string;
  /**
   * A sentence about the LIST itself, drawn under the model picker — the
   * backend still launches ("Copilot lists only Auto for this account").
   * Never a reason the backend cannot start; that is `unavailable`.
   */
  readonly note?: string;
}

export interface BackendDescriptor {
  /** Stable wire id. Absent on the wire MEANS `claude`. */
  readonly id: string;
  /** What a person sees. */
  readonly label: string;
  /** The binary to spawn. The ONE place its env override is read. */
  bin(): string;
  /**
   * Environment this binary must be spawned WITH, merged over the PTY env.
   *
   * Data, not a function, and empty for claude — it exists because for at least
   * one backend an environment variable is a SAFETY requirement rather than a
   * preference (`opencode.ts`: without it the CLI opens an update modal whose
   * focused button is `Confirm`, so "type text, press Return" upgrades the
   * user's install). A fact of that kind belongs beside the argv that spawns
   * the binary, where the spawn site cannot forget it, rather than in a
   * person's config file — which this app must not edit.
   */
  readonly spawnEnv: Readonly<Record<string, string>>;
  /**
   * argv for one launch, plus the conversation id if it is knowable now, how the
   * instructions and ask rules reach the CLI, and the files to write first. A core
   * backend answers SYNCHRONOUSLY, so `SessionManager.create()` spawns and registers
   * its session before its first `await` (the slot rung counts sessions that exist —
   * `intents/ladder.ts`); a plugin's `prepare()` is awaited. A refusal is a thrown sentence.
   */
  prepare(req: LaunchRequest): LaunchPlan | Promise<LaunchPlan>;
  readonly delivery: BackendDelivery;
  readonly caps: BackendCaps;
  /**
   * Which provider answers each fact, in order (`@waterplane/shared`'s `BackendFacts`): the
   * backend's own channel (`{source:true}` ⇒ `sources.<slot>`), a named screen reader, a named
   * store reader. Every reader gate in the host asks `derive(descriptor)` (`derive.ts`); a fact
   * with no provider is ABSENT. Names are checked at registration (`registry.ts`).
   */
  readonly facts: BackendFacts;
  /** The backend forks a conversation on its OWN server (opencode's `POST /session/{id}/fork`).
   *  A claude fork is `convfork.ts`'s file copy, implied by the `claude-jsonl` transcript. */
  readonly forkVia?: "server";
  /** The CLI versions its facts were measured on, and the running one (plugins; core leaves it out). */
  readonly measured?: { readonly versions: readonly string[]; version(): Promise<string | null> };
  /**
   * What this backend may be launched with. An EMPTY catalogue means "ask the
   * person", i.e. a free-text field — never a guessed list, because a wrong
   * model id is a spawn that fails minutes later with nothing to read.
   */
  models(): Promise<BackendModels>;
  /**
   * The LOCAL runner this backend's models always run on, when it has one —
   * data, so the local-model gate (`localslot.ts`) can count its sessions
   * against the local cap and load the model before an automatic start
   * without naming a backend id. `"ollama"` = `localrt.ts`'s `ollamaUrl()`,
   * local exactly when that URL is loopback. Absent = locality is per model
   * (`models.where`), and nothing is loaded on its behalf.
   */
  readonly localRunner?: "ollama";
  /**
   * May `clihealth.ts` file observations about sessions on this backend?
   *
   * False ⇒ `noteHealth()` files NOTHING for them. The health board measures
   * how well this app's readers track the claude TUI; a backend those readers
   * were never written for would amber it by simply existing, which is a rate
   * describing no event at all.
   */
  readonly healthScope: boolean;
  /**
   * A source per fact, beside the screen readers (`@waterplane/shared`'s
   * `backendsources.ts`). Absent = exactly today's backend. A slot is asked only where
   * `facts` lists `{source:true}` for it (`derive.ts`'s `askSource`).
   */
  readonly sources?: BackendSources;
  /** From an extension its manifest marks experimental — the phone labels it (`BackendInfo.experimental`). */
  readonly experimental?: boolean;
  /**
   * The id of the plugin that registered this backend (`api.backend()`), absent for a core one.
   * Its sources' dialogs are that plugin's, so a standing rule a person makes on one is keyed by
   * it (`answergate.ts`) — never by the backend id, which a second plugin may also declare.
   */
  readonly plugin?: string;
  /** That plugin's own data dir (`api.dataDir`): the one place outside the launch dir a
   *  `LaunchPlan.files` entry may name by absolute path (realpath-contained). */
  readonly dataDir?: string;
}

/** A core backend: its plan is decided synchronously (`prepare` returns no promise), so
 *  tests and the claude variants read it at once and `create()` spawns before its first `await`. */
export type CoreBackendDescriptor = Omit<BackendDescriptor, "prepare"> & { prepare(req: LaunchRequest): LaunchPlan };
