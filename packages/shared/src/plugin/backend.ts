import type { ContextEvent, ContextSample, DetectedPrompt } from "../wire/session.js";
import type { TranscriptDoc, TranscriptToolDetail } from "../wire/transcript.js";
import type { BackendSources } from "../backendsources.js";
import type { BackendCapsV2, BackendFacts, PluginLaunchPlan, PluginLaunchRequest } from "../pluginlaunch.js";

// ── plugin HTTP routes (`api.route`, since 1.2) ─────────────────────────────

/** The verbs a plugin route may answer. */
export type PluginHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** The largest JSON body a plugin route is handed. */
export const PLUGIN_ROUTE_BODY_MAX = 1_000_000;

/** What a plugin route's handler is handed. */
export interface PluginHttpRequest {
  readonly method: PluginHttpMethod;
  /** The pattern's `:name` segments, raw (still percent-encoded). */
  readonly params: Readonly<Record<string, string>>;
  /** What the pattern's trailing `*` matched, one entry per segment. */
  readonly rest: readonly string[];
  /** The query string, the first value of each key. */
  readonly query: Readonly<Record<string, string>>;
  /** The parsed JSON body; `{}` when there is none. Unchecked: validate it. */
  readonly body: unknown;
}

/** What a plugin route answers: an HTTP status (default 200) and a JSON body (default `{}`). */
export interface PluginHttpReply {
  readonly status?: number;
  readonly body?: unknown;
}

// ── plugin backends (`api.backend`, docs/analysis/backends-design.md §3) ──────

/** A backend id: a short lowercase word — the same rule the host's registry applies. */
export const PLUGIN_BACKEND_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A backend a plugin registers (2.0). Reader names in `facts` are plain strings — a name this host
 * has no reader for is refused at registration in words, never armed. `delivery` fields left out
 * are the "no anchor" defaults (`submitKey` "\r", every regex null, no local commands), which is
 * the shape `deliver.ts` already falls back to. A plugin backend is never on the claude health
 * board (`healthScope` is the core's to say, and it says false); `measured` is its health signal.
 *
 * `delivery`, `caps`, `facts`, `forkVia` and `sources` may be GETTERS (a knob read per call
 * switches them): the core reads them through on every access and never copies them at
 * registration. Each answer must name readers this host has — checked at registration.
 */
export interface PluginBackendDef {
  id: string;
  label: string;
  bin(): string;
  spawnEnv?: Readonly<Record<string, string>>;
  /** One launch's plan (replaces 1.x's sync `launchArgs`). A refusal is a thrown sentence. */
  prepare(req: PluginLaunchRequest): Promise<PluginLaunchPlan>;
  delivery?: {
    submitKey?: string;
    textThenSubmitDelayMs?: number;
    requiresChannel?: boolean;
    pastePlaceholder?: RegExp | null;
    composerCursorRe?: RegExp | null;
    composerRuleRe?: RegExp | null;
    /** An empty composer's hint text when it is NOT drawn dim (dim is discounted already). */
    composerPlaceholderRe?: RegExp | null;
    /**
     * Read with claude's trust words before every delivery: a match makes delivery `retry` with a
     * sentence, nothing typed (only claude's own descriptor may answer a trust box).
     */
    trustPromptRe?: RegExp | null;
    isLocalCommand?(text: string): boolean;
    startsNoTurn?(text: string): boolean;
  };
  caps: BackendCapsV2;
  /** Which provider answers each fact, in order (replaces 1.x's reader caps). */
  facts: BackendFacts;
  /** The backend forks a conversation on its own server (opencode's `POST /session/{id}/fork`). */
  forkVia?: "server";
  /** The CLI versions this plugin was MEASURED on, and how to ask the running one (null = cannot
   *  tell). The host compares and says a drift in a sentence — never a refusal — and the phone
   *  shows it verbatim where a backend is chosen (launch picker, Settings, new-repo menu). */
  measured: { versions: readonly string[]; version(): Promise<string | null> };
  /** The model catalogue. Empty ⇒ a free-text field on the phone, never a guessed list. */
  models(): Promise<{
    aliases: string[]; ids: string[];
    where?: Record<string, "local" | "hosted">; zeroCost?: string[];
    contextWindow?: Record<string, number>; unavailable?: string;
    /** A sentence about the list, under the picker; the backend still launches. */
    note?: string;
  }>;
  /** A source per fact beside the screen readers (`backendsources.ts`). */
  sources?: BackendSources;
}

// ── contributed readers (`api.screenReader` / `api.storeReader`, since 1.1) ───

/** A reader name: the same short lowercase word a backend id is. */
export const PLUGIN_READER_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** One run of cells painted alike on a rendered row. Colour keys are `def`, `pal:<n>` or `rgb:<n>`. */
export interface PluginScreenSpan {
  /** Column of the first cell in the run. */
  readonly from: number;
  /** Column of the last cell in the run, inclusive. */
  readonly to: number;
  /** The characters in the run, one per cell — spaces included. */
  readonly text: string;
  readonly bg: string;
  readonly fg: string;
}

/** One row of the session's rendered screen, as a screen reader is handed it. */
export interface PluginScreenRow {
  readonly text: string;
  /** Left to right, contiguous, covering every column of the grid. */
  spans: PluginScreenSpan[];
}

/** What a screen reader parsed: which option is armed (1-based) and how many there are. */
export interface PluginScreenBox {
  readonly armed: number;
  readonly options: readonly unknown[];
}

/**
 * A screen reader for a dialog with NO numbers, answered by walking the selection onto an option
 * and pressing Return. The core keeps the shape every box reader has — a cheap byte gate, an
 * expensive render, a miss budget so a half-drawn repaint cannot retire a live box, a walk that
 * RE-READS after every key and refuses rather than pressing Return on the wrong row — and asks the
 * reader only the questions that are about one TUI's pixels.
 *
 * Every member must be pure and must not throw; a throw reads as "no box".
 */
export interface PluginScreenReader<B extends PluginScreenBox = PluginScreenBox> {
  /** The cheap gate, on the ANSI-stripped tail of the scrollback: could a dialog be up at all? */
  candidate(strippedTail: string): boolean;
  /** The rendered rows, parsed: a box when its armed option is readable, else null. */
  read(rows: PluginScreenRow[]): B | null;
  /** The box as the phone is shown it. Options numbered 1.., `nav: true`. */
  prompt(box: B): DetectedPrompt;
  /** Rows that did NOT parse: is the dialog still drawn (spend a miss, keep the box) or gone? */
  stillUp(rows: PluginScreenRow[]): boolean;
  /** One step toward option `choice` — null when the box has no such option. */
  navTo(box: B, choice: number): { dir: "left" | "right" } | null;
}

/** What one pass of conversation discovery is handed (`PluginStoreReader.discover`). */
export interface PluginStoreLook {
  /** The session's working directory, realpath-resolved. */
  readonly dir: string;
  /** Did this session's own launch write a conversation row (`createsRecord`)? */
  readonly ownRow: boolean;
  readonly spawnedAt: number;
  /** The last prompt this host WATCHED land on screen, and when, while the id is unknown. */
  readonly probe?: { readonly text: string; readonly at: number };
  /** Conversation ids other live sessions have already adopted. */
  readonly adopted: ReadonlySet<string>;
  /** What the previous pass handed back as `carry` (null on the first, and after a new prompt). */
  readonly carry: unknown;
  readonly now: number;
}

/** The context series out of a store, before the core puts a window on it. */
export interface PluginStoreContext {
  readonly samples: ContextSample[];
  readonly events: ContextEvent[];
  /** The model the LAST assistant message ran under — the window is that model's. Null when unknown. */
  readonly model: string | null;
  readonly truncated: boolean;
  /** The change stamp a poll compares against. */
  readonly updatedAt: number;
}

/**
 * A store reader: the CLI's own conversation record, read and never written. Every member is
 * keyed by the CLI's own conversation id (`SessionInfo.backendSessionId`) and DEGRADES TO NULL —
 * a store that cannot be read is an absent fact, never a thrown error and never a zero.
 */
export interface PluginStoreReader {
  /** The `TranscriptDoc.source` the reader view carries for this store. */
  readonly source: TranscriptDoc["source"];
  /** The store's own change stamp for one conversation; null = unknown. */
  updatedAt(conversationId: string): number | null;
  /** May a poll answer "unchanged" for this stamp against the client's `since`? */
  pollUnchanged(stamp: number | null, since: number): boolean;
  /** The conversation as the reader's document; null when the store or the conversation is not there. */
  transcript(conversationId: string, detail: "lite" | "full"): Omit<TranscriptDoc, "sessionId" | "source"> | null;
  /** The inputs/results one turn's `lite` tool blocks withheld. */
  toolDetails(conversationId: string, turnId: string): Record<string, TranscriptToolDetail> | null;
  /** How full the context window has been, over time. */
  contextSeries(conversationId: string): PluginStoreContext | null;
  /**
   * One pass of finding WHICH conversation a session is in, for a backend whose launch does not
   * know the id. `id` only when exactly one candidate answers — a guess points the reader at
   * somebody else's conversation. `carry` is handed back on the next pass.
   */
  discover(look: PluginStoreLook): { id: string | null; carry: unknown };
  /**
   * The backend's own ledger, served verbatim at `GET /api/tokenstats/<backendId>` for a backend
   * whose `facts.transcript` names this reader and which has no `sources.tokens`. JSON; a store
   * that cannot be read answers `{ available: false, reason }`, never throws.
   */
  ledger?(maxAgeMs: number | undefined): Promise<unknown>;
}

