/**
 * The sources seam — what a backend may hand over BESIDE its screen readers.
 * Pure types (`docs/analysis/backends-design.md` §1.1); no behaviour lives here.
 *
 * The ladder per fact is source → screen reader → absent. A source is a reader:
 * the descriptor's `facts` (`plugin.ts`, 2.0) list the providers per fact in
 * order — `{source:true}` means "ask the slot here" — and a source that cannot
 * answer returns `null`/absent so the next provider is asked. **Nothing a source reports becomes a number it did not
 * state.** The types live in `shared` so an in-repo extension and an external
 * plugin can implement them under the `extension-boundary` lint.
 */
import type { DetectedPrompt, PermissionMode } from "./wire/session.js";
import type { TranscriptDoc } from "./wire/transcript.js";
import type { BackendTokensDoc } from "./wire/backendtokens.js";
import type { UsageSourceId, UsageWindow } from "./wire/telemetry.js";

/** One live PTY session as a source sees it — never the Session record. */
export interface SourceSession {
  readonly id: string;              // waterplane session id
  readonly cwd: string;             // realpath
  readonly backendSessionId?: string; // the CLI's own id when the launch knew it
  readonly spawnedAt: number;
}

/**
 * What an edge may say beyond itself — each field only when the CLI stated it.
 * claude's hooks are the one source that fills these today (design §10).
 */
export interface TurnFacts {
  /** The words the CLI says it accepted with this turn (claude: `UserPromptSubmit.prompt`). Recorded so a delivery can claim them. */
  readonly prompt?: string;
  /** Re-read the session's model off its log at this edge (claude: `SessionStart`, `Stop` — a mid-turn `/model`). `logPath` = where the CLI says the log is. */
  readonly reread?: { readonly logPath?: string };
}

/** Exact turn boundaries. Replaces silence for the backend that supplies it. */
export interface TurnSource {
  /** Subscribe for one session; returns the unsubscribe. `ready` = at its prompt, no turn. */
  watch(s: SourceSession, on: {
    started(at: number, facts?: TurnFacts): void; // a user message was accepted
    ended(at: number, facts?: TurnFacts): void;   // ONE per turn (with `verifyEnds`: the CLI ASKING to end it)
    ready(facts?: TurnFacts): void;               // session reachable and idle
    /** The CLI named its own conversation id after attach (claude: `SessionStart.session_id`). */
    identified?(backendSessionId: string): void;
  }): () => void;
  /**
   * `ended` is the CLI ASKING to end the turn, and the CLI also works without announcing a turn
   * (claude: a `Stop` a hook may refuse; `/compact`). The host then holds each `ended` against the
   * screen's working line before believing it, owes the end whether or not a turn was believed,
   * and keeps its screen turn watch armed while the channel is up. Only for a TUI that
   * working-line reader was written for. Absent ⇒ `ended` is believed outright.
   */
  readonly verifyEnds?: boolean;
}

/** A dialog as the CLI itself posed it. `DetectedPrompt` is the WIRE shape; this is the source's. */
export interface SourceDialog {
  readonly id: string;              // the CLI's request id — becomes `askId`
  readonly kind: DetectedPrompt["kind"];
  readonly question: string;
  /** `takesText` (2.0): this row takes a typed reason ("No, and tell the agent why"). */
  readonly options: { index: number; label: string; desc?: string; remember?: SourceRemember; takesText?: boolean }[];
  /**
   * Answer by the CLI's own channel. `{ok:false, reason}` when it cannot (expired, channel down).
   *
   * `{ keys }` = "this dialog is now in my TUI and is answered by these keystrokes": the
   * source does not type them — it has no keystroke API, and gets none. The host's one
   * answer dispatcher (`sessions/boxes.ts`'s `answerBox`) types them into THIS session
   * through the same raw-input path a phone's digit tap uses, once, and only as the result
   * of that call. Bounded (`SourceKeys`); anything else is refused in words, nothing typed.
   *
   * `{ keys, typed, then? }` (2.1, `HostPluginApi.supports.dialogKeysThenTyped`) = "this row's
   * keys open a reason field; type the person's reason into it": only for a `takesText` row
   * answered with `extra.text`, and `typed` must BE that text. The host types the keys, waits
   * `TYPED_AFTER_KEYS_MS` (500 ms) for the field, then the words and, as a separate write, the
   * Return — each half bounded as `SourceKeys` / `SourceTyped`. Any other `typed` from a dialog
   * is refused in words, nothing typed.
   */
  answer(choice: number, extra?: { text?: string }): Promise<{ ok: boolean; reason?: string } | SourceKeys | (SourceKeys & SourceTyped)>;
}

/**
 * An option that, when a PERSON's tap chooses it, makes the HOST keep a standing rule for this
 * session (`answergate.ts`): "don't ask again" for exactly `key`. The source never creates the
 * rule; it may later ask `HostPluginApi.ruleAllows(sessionId, key, why)`, which the gate answers
 * and audits. `label` is what the person approved, in words (shown in the decision log). Never
 * on the wire.
 */
export interface SourceRemember { key: string; label: string }

/**
 * The keystrokes a `SourceDialog.answer` (or `ModeSource.set`, 2.2) may hand back for the host
 * to type. `keys` is at most `SOURCE_KEYS_MAX` (8) KEYS, each a printable character (no control
 * characters, no DEL) or one of the control keys a box walk or a mode cycle already presses:
 * Return `"\r"`, Escape `"\x1b"`, the arrows `"\x1b[A"`…`"\x1b[D"`, and (2.2) Tab `"\t"` and
 * Shift+Tab `"\x1b[Z"` — each of those counts as ONE key. E.g. Copilot past its hook hold:
 * `{keys:"1"}` (the digit, NO Return). Only ever the result of the source's own answer; never a
 * paste, never a prompt: words go through `deliver.ts`.
 */
export interface SourceKeys { keys: string }
export const SOURCE_KEYS_MAX = 8;
export interface DialogSource {
  watch(s: SourceSession, on: {
    asked(d: SourceDialog): void;
    resolved(id: string): void;      // answered by anyone, or withdrawn
    /**
     * How many dialogs the CLI has open that this source can SEE but cannot pose — a kind
     * it does not map, because nobody measured how it is answered (opencode's `question`
     * tool). While this is above 0 the host's screen reader keeps its duty for them;
     * absent / never called = 0. Reported on every change, and once on `watch` when above 0.
     */
    unposed?(count: number): void;
  }): () => void;
  /** Reconcile after a gap: what is pending NOW. Null = cannot say (channel down). */
  pending(s: SourceSession): Promise<SourceDialog[] | null>;
}

/** Proof that typed words became a user turn. */
export interface DeliverySource {
  /** Resolve true when a user message whose text equals `text` lands after `sinceMs`; false at timeout. */
  landed(s: SourceSession, text: string, sinceMs: number, timeoutMs: number): Promise<boolean>;
  /** Every user message since `sinceMs`; null = cannot say. */
  userTurns(s: SourceSession, sinceMs: number): Promise<{ id: string; text: string; at: number }[] | null>;
}

/** The conversation as a reader document. */
export interface TranscriptSource {
  /** The CLI's own change stamp; drives the 204 poll. Null = unknown (read anyway). */
  updatedAt(s: SourceSession): number | null;
  /**
   * Served verbatim, so a turn's subagent fields (`agentTypes`, `agentsRunning`, `agentModels`,
   * `agentCostUsd`, `agentUnpricedTok`) are the plugin's to fill — only off a record that links the
   * agent to that turn's own tool call, and the token/cost ones only beside the turn's OWN
   * `tokens`/`models` (the phone folds `agentModels` into the turn's model mix, so agents alone
   * read as the whole turn). An agent that cannot be placed withholds the turn's agent figures.
   */
  read(s: SourceSession, detail: "lite" | "full"): Omit<TranscriptDoc, "sessionId" | "source"> | null;
}

/** Named `Source…` because wire/session.ts already exports a `ContextSample`. */
export interface SourceContextSample {
  /**
   * When the CLI's count was TAKEN (the reading's own time), never when it was asked: the host
   * keeps a new graph point per newer `at`, so a plugin stamping `Date.now()` on each call would
   * cost a disk write per poll. A sample equal in figures to the last one is not a new point.
   */
  at: number;
  usedTok: number;
  model?: string;
  /**
   * (2.2) The window, in tokens, the CLI STATES for the model this session is using right now.
   * Absent = unknown — never a guess, never a table keyed on the id, never the window of a
   * neighbouring model or another session's.
   */
  window?: number;
}
/** (2.2) One compaction of THIS session, as the CLI recorded it. */
export interface SourceCompaction {
  /** When it happened (ms). */
  at: number;
  /** The fill just before, from the CLI's own count; absent = not stated. */
  preTok?: number;
  /** The fill just after; absent = not stated. */
  postTok?: number;
  /** True = the CLI compacted on its own, false = asked for (`/compact`); absent = not stated. */
  auto?: boolean;
}
export interface ContextSource {
  /**
   * Current fill, from the CLI's own count. The window rides only as `window`, and only when
   * the CLI states it for the model in use (absent = unknown, never a guess).
   */
  sample(s: SourceSession): SourceContextSample | null;
  watch?(s: SourceSession, on: (c: SourceContextSample) => void): () => void;
  /** (2.2) This session's compactions, oldest first. Null = cannot say; `[]` = none happened. */
  compactions?(s: SourceSession): SourceCompaction[] | null;
}

/**
 * (2.2) What THIS session has spent so far, in the backend's own figures — each field only
 * where the CLI states it, absent otherwise (never derived from a price table, never zero for
 * unknown). `tok`/`usd` are the session's own turns, `agentTok`/`agentUsd` its subagents'.
 * `usd` only where the CLI states dollars. A unit that is not dollars (Copilot's AI credits)
 * rides as `native` — never converted, never summed with dollars or with another unit.
 */
export interface SourceSessionSpend {
  /** When this reading was taken (ms). */
  at: number;
  tok?: number;
  agentTok?: number;
  usd?: number;
  agentUsd?: number;
  native?: { amount: number; unit: string; agentAmount?: number };
}
/** A ledger in the backend's OWN unit, served at GET /api/tokenstats/<backendId>. */
export interface TokenSource {
  ledger(maxAgeMs: number): Promise<BackendTokensDoc>;
  /** (2.2) THIS session's spend so far. Null = cannot say. */
  session?(s: SourceSession): SourceSessionSpend | null;
}

/** What a side channel is doing. Published as `SessionInfo.sideChannel`. */
export interface ChannelHealth { state: "up" | "down"; since: number; note?: string }

export interface SourceHandle {
  /** The session ended: tear the channel down, and any child the CLI depends on with it. */
  close(): Promise<void>;
  health(): ChannelHealth;
  /**
   * The CLI's own conversation id this channel is bound to, when the attach KNOWS it
   * (opencode: the daemon created the conversation on the backend's server). Adopted as
   * `SessionInfo.backendSessionId`; absent = discover it the old way.
   */
  readonly backendSessionId?: string;
  /**
   * The PTY detached but the CLI keeps running (a tmux pane): drop the stream, KEEP any
   * child the CLI depends on, so a re-attach finds it. Absent ⇒ `close()`.
   */
  suspend?(): Promise<void>;
  /**
   * This session has NO channel and never will (opencode: a pane started before the daemon
   * ran its server, so there is no record of one): the sentence says so, in words, and is
   * published as the down note. Sends are NOT held — the screen readers keep every rung, as
   * for a backend without sources. Absent = a real channel, held while it is down.
   */
  readonly screenOnly?: string;
}

// ── 2.0 slots (`docs/analysis/backend-v2-impl.md` §2.1). Typed here; the host consumes each in
// its own package (questions WP4, usage WP5, agents + conversations WP9). ─────────────────────

/** A question with NO choice box: Copilot `ask_user`, codex `requestUserInput`, opencode `question`. */
export interface SourceQuestion {
  /** The CLI's own id — becomes `DetectedPrompt.askId`. */
  readonly id: string;
  readonly question: string;
  /** Absent = free text only. */
  readonly options?: { index: number; label: string; desc?: string }[];
  /** A typed answer is accepted. */
  readonly freeText: boolean;
  /** Answer by the CLI's own channel. `{keys}`/`{typed}` = the host types it (`boxes.ts` `answerBox`). */
  answer(a: { choice?: number; text?: string }): Promise<{ ok: boolean; reason?: string } | SourceKeys | SourceTyped>;
}
/** The host types `typed` into the CLI's OWN FORM (never the composer), then `then`. At most `SOURCE_TYPED_MAX` chars. */
export interface SourceTyped { typed: string; then?: "\r" }
export const SOURCE_TYPED_MAX = 1000;
export interface QuestionSource {
  watch(s: SourceSession, on: { asked(q: SourceQuestion): void; closed(id: string): void }): () => void;
  pending?(s: SourceSession): Promise<SourceQuestion[] | null>;
}

/** Plan mode as the CLI states it: the plan text and the two verbs. Absent ⇒ no plan box. */
export interface SourcePlan {
  readonly id: string;
  readonly text: string;
  approve(): Promise<{ ok: boolean; reason?: string } | SourceKeys>;
  keepPlanning(): Promise<{ ok: boolean; reason?: string } | SourceKeys>;
}
export interface PlanSource { watch(s: SourceSession, on: { posed(p: SourcePlan): void; closed(id: string): void }): () => void }

/** One ACCOUNT's windows, in the wire's own shape, plus the wall. */
export interface UsageSource {
  /** Never `"claude"` from a plugin. */
  readonly source: UsageSourceId;
  readonly label: string;
  /** Null = absent; an empty list = send nothing. */
  windows(): Promise<UsageWindow[] | null>;
  /** Is THIS session blocked by the account right now? `resetAt` only when the CLI stated it. */
  wall?(s: SourceSession): { blocked: boolean; resetAt?: number; why: string } | null;
  everyMs?: number;
}

export interface SourceAgent { id: string; name?: string; startedAt: number; endedAt?: number; lastWriteAt?: number }
/**
 * Polled on `agents.ts`'s cadence. Background SHELLS have no slot: no plugin CLI writes down which
 * of its shells is still running (docs/analysis/backend-parity-v3/c11.md), so they stay ABSENT.
 */
export interface AgentSource { list(s: SourceSession): SourceAgent[] | null }

export interface SourceConversation { id: string; title?: string; updatedAt: number; firstPrompt?: string }
export interface ConversationSource {
  list(cwd: string): Promise<SourceConversation[] | null>;
  fork?(id: string, atTurn?: string): Promise<{ id: string } | null>;
  remove?(cwd: string, id: string): Promise<{ ok: boolean; reason?: string }>;
}

// ── 2.2 slots (`docs/plans/backend-parity-v3.md` §7). Typed here; consumed by P4b/P4c. ─────

/** The mode the CLI is in, as one of the descriptor's `caps.permissionModes`. Fact name "mode". */
export interface ModeSource {
  /** The mode now. Null = unknown, never a guess; a mode not in `caps.permissionModes` is unknown. */
  current(s: SourceSession): PermissionMode | null;
  watch?(s: SourceSession, on: (m: PermissionMode) => void): () => void;
  /**
   * Switch to `target`. The backend switches itself (a server call) ⇒ `{ok, reason?}`; or it
   * answers ONE press (`SourceKeys`, e.g. Shift+Tab) the core types, after which the core re-reads
   * `current()` until it changes — `livemode.ts`'s ladder (stop on the target / a repeat /
   * 6 presses), never counting positions.
   */
  set(s: SourceSession, target: PermissionMode): Promise<{ ok: boolean; reason?: string } | SourceKeys>;
}

/** One of the CLI's slash commands, as the CLI lists it. */
export interface SourceCommand {
  /** With the slash: `"/compact"`. */
  name: string;
  description?: string;
  /** The arguments as the CLI's help writes them; absent = none or unknown. */
  args?: string;
  /** Runs in the TUI and starts no agent turn (the delivery's proof is the screen moving). */
  local?: boolean;
}
/** The CLI's slash commands. Fact name "commands". At most `SOURCE_COMMANDS_MAX` rows. */
export interface CommandSource {
  /** The commands for a session in `cwd`. Null = cannot say. */
  list(cwd: string): Promise<SourceCommand[] | null>;
}

export interface BackendSources {
  /**
   * The channel rides the CLI process itself (claude: hooks the CLI runs as curls to the host):
   * nothing to connect, so the subscriptions are live the moment `attach` is called; its health
   * is `SessionInfo.hooked` and is never published as `sideChannel`; it never reports `down`,
   * and no send is held for it. Absent ⇒ a channel of its own (a server, an event stream).
   */
  readonly inBand?: boolean;
  turns?: TurnSource;
  dialogs?: DialogSource;
  delivery?: DeliverySource;
  transcript?: TranscriptSource;
  context?: ContextSource;
  tokens?: TokenSource;
  /** 2.0 slots — typed, consumed by later packages (see above). */
  questions?: QuestionSource;
  plan?: PlanSource;
  usage?: UsageSource;
  agents?: AgentSource;
  conversations?: ConversationSource;
  /** 2.2 slots — typed, consumed by later packages (see above). */
  mode?: ModeSource;
  commands?: CommandSource;
  /** Per session: bring the channel up (spawn a child, open SSE); the returned handle tears it down. */
  attach(s: SourceSession, onHealth: (h: ChannelHealth) => void): Promise<SourceHandle>;
  /**
   * Reap what a session that no longer exists left behind (opencode: a seat's server and its
   * record, after its pane died while detached or while the daemon was down). `alive(id)`
   * is the host's answer for a waterplane session id — a live session, or a tmux pane still
   * running under that name. Called after the plugins settle and then periodically; must
   * touch nothing whose id `alive` vouches for, and nothing it did not start itself.
   */
  sweep?(alive: (hostSessionId: string) => boolean): void;
}
