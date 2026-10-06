/**
 * The sources seam — what a backend may hand over BESIDE its screen readers.
 * Pure types (`docs/analysis/backends-design.md` §1.1); no behaviour lives here.
 *
 * The ladder per fact is source → screen reader → absent. A source is a reader:
 * `caps` still says the fact EXISTS for the backend and still gates whether a
 * screen reader runs, and a source that cannot answer returns `null`/absent so
 * the next rung is asked. **Nothing a source reports becomes a number it did not
 * state.** The types live in `shared` so an in-repo extension and an external
 * plugin can implement them under the `extension-boundary` lint.
 */
import type { DetectedPrompt } from "./wire/session.js";
import type { TranscriptDoc } from "./wire/transcript.js";
import type { BackendTokensDoc } from "./wire/backendtokens.js";

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
  readonly options: { index: number; label: string; desc?: string; remember?: SourceRemember }[];
  /**
   * Answer by the CLI's own channel. `{ok:false, reason}` when it cannot (expired, channel down).
   *
   * `{ keys }` = "this dialog is now in my TUI and is answered by these keystrokes": the
   * source does not type them — it has no keystroke API, and gets none. The host's one
   * answer dispatcher (`sessions/boxes.ts`'s `answerBox`) types them into THIS session
   * through the same raw-input path a phone's digit tap uses, once, and only as the result
   * of that call. Bounded (`SourceKeys`); anything else is refused in words, nothing typed.
   */
  answer(choice: number): Promise<{ ok: boolean; reason?: string } | SourceKeys>;
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
 * The keystrokes a `SourceDialog.answer` may hand back for the host to type. `keys` is at
 * most `SOURCE_KEYS_MAX` (8) KEYS, each a printable character (no control characters, no
 * DEL) or one of the control keys a box walk already presses: Return `"\r"`, Escape
 * `"\x1b"`, the arrows `"\x1b[A"`…`"\x1b[D"`. E.g. Copilot past its hook hold: `{keys:"1"}`
 * (the digit, NO Return). Never a paste, never a prompt: words go through `deliver.ts`.
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
  read(s: SourceSession, detail: "lite" | "full"): Omit<TranscriptDoc, "sessionId" | "source"> | null;
}

/** Named `Source…` because wire/session.ts already exports a `ContextSample`. */
export interface SourceContextSample { at: number; usedTok: number; model?: string }
export interface ContextSource {
  /** Current fill, from the CLI's own count. Never a window. */
  sample(s: SourceSession): SourceContextSample | null;
  watch?(s: SourceSession, on: (c: SourceContextSample) => void): () => void;
}

/** A ledger in the backend's OWN unit, served at GET /api/tokenstats/<backendId>. */
export interface TokenSource {
  ledger(maxAgeMs: number): Promise<BackendTokensDoc>;
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
