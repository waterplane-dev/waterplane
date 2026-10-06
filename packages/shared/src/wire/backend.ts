/**
 * `BackendInfo` — the wire subset of a host-side `BackendDescriptor`.
 *
 * The host can drive more than `claude` in the same PTY substrate (the whole
 * point being that the substrate never changes: drive the real binary,
 * never re-implement it). What differs per backend is which FEATURES this
 * app may exercise against it, and this is the document that says so —
 * quoted wholesale into the `backends` message so a client that never saw
 * `claude` specifically still knows what it can ask a session for.
 *
 * The iron rule that makes a second backend safe to add: a descriptor
 * declaring FEWER capabilities can only make waterplane ask for less, never
 * guess a fact the backend never printed. Every consumer of `caps` and
 * `contextWindowTokens` must degrade the same way this file documents —
 * to null/absent, never to a wrong number or a grey button with no reason.
 */

import type { PermissionMode } from "./session.js";

/** Where a model runs. Deliberately two values and an ABSENT third state — see
 *  `BackendInfo.models.where`: "not in the map" is unknown, not hosted. */
export type ModelHosting = "local" | "hosted";

export interface BackendInfo {
  /** Stable id, e.g. "claude" or "opencode" — what `LaunchOpts.backend` and
   *  `SessionInfo.backend` name. Never shown on its own; pair with `label`. */
  id: string;
  /** Human label for pickers and session facts ("Claude Code", "opencode"). */
  label: string;
  /**
   * What KIND of session this backend runs, when it is not a coding agent.
   * `"shell"` = a plain login shell: no turns, no model, no context — the phone
   * offers it as "open a shell here", not in the model picker. ABSENT means an
   * agent backend, exactly as before this field existed.
   */
  kind?: "shell";
  /**
   * Whether this backend has the THING AT ALL — not whether it is currently
   * on, not a live measurement. A capability that is `false` here means the
   * phone must not even attempt the feature: no polling, no "waiting for
   * data" spinner, just the absent-capability sentence CLAUDE.md requires
   * (words, never a greyed-out control). A capability that is `true` can
   * still read as absent moment-to-moment (e.g. `contextMeter: true` but no
   * figure printed yet) — that is the FIELD on `SessionInfo` degrading, not
   * this flag.
   */
  caps: {
    /** Prints something this app can parse as "% of context window left". */
    contextMeter: boolean;
    /** Has an ACCOUNT usage-limit concept this app can detect and resume from. */
    usageLimits: boolean;
    /** Keeps a conversation log this app can read as a transcript / fork from. */
    transcript: boolean;
    /** Understands `claude`-style `/slash` commands. */
    slash: boolean;
    /** Draws interactive choice/checkbox boxes this app's prompt detector can read. */
    promptBoxes: boolean;
    /** Can be wired to report turn boundaries via a hook/plugin pipe (exact,
     *  not the silence fallback). */
    hooks: boolean;
    /** Has a reasoning-effort knob (`Effort`). */
    effort: boolean;
    /** Can be started already mirrored to a claude.ai/code-style remote control session. */
    remoteControl: boolean;
    /**
     * Three capabilities that USED to be implied by `transcript` and
     * `contextMeter`, split out the moment a backend could have one without the
     * others.
     *
     * **Each is OPTIONAL, and its absence means "fall back to what implied it
     * before".** That is what makes an old host and a new phone render exactly
     * as they did: a descriptor that never heard of these fields answers
     * `undefined`, and every reader is required to resolve `fork ?? transcript`,
     * `resumePick ?? transcript`, `contextSeries ?? contextMeter`. A boolean
     * with a `false` default would have silently removed working controls from
     * every desktop that had not upgraded yet.
     */
    /** A conversation can be cut at a turn and written under a new id. opencode
     *  keeps its record in a live SQLite db this app must never write, so it
     *  reads a transcript it cannot fork. */
    fork?: boolean;
    /** The binary can be handed an interactive "pick an older conversation"
     *  list. Separate from `transcript` because opencode has a readable record
     *  and no picker this host knows how to drive — `launchArgs` REFUSES
     *  `"pick"` in words, so offering the button would be offering a refusal. */
    resumePick?: boolean;
    /** A context series can be assembled for the graph, even where no live
     *  gauge exists. `contextMeter` means "the TUI PRINTS a gauge" and stays a
     *  statement about the screen; this one is about whether history can be
     *  drawn at all. */
    contextSeries?: boolean;
    /** Which `PermissionMode`s this backend actually understands — empty when
     *  it has no such concept, never a guessed subset of claude's list. */
    permissionModes: PermissionMode[];
  };
  /**
   * The model catalogue this backend will accept, split into short aliases
   * (e.g. "opus") and full ids. Either or both may be empty — an empty
   * catalogue means "free-text field", never a guessed default list.
   */
  models: {
    aliases: string[];
    ids: string[];
    /**
     * Where each model RUNS: on this desktop, or on somebody's server.
     *
     * Keyed by the id exactly as it appears in `ids`. **An id that is absent
     * from this map is UNKNOWN, never "hosted"** — inferring the negative from
     * a missing key is how a local model ends up filed under the heading that
     * says "costs money and leaves the machine", which is the one mistake this
     * field exists to prevent. The phone therefore draws three groups at most
     * and never two: local, hosted, and whatever it could not be told about.
     *
     * The map may be absent entirely, which is the honest answer for a host
     * that could not determine it (an older desktop, a probe that failed). Then
     * the picker is exactly the flat list it was before this existed.
     *
     * "local" means LOOPBACK — a runner on this same machine. A model served
     * from another box on the LAN is `hosted`: it is not on this disk, it is
     * not there when the network is, and grouping it with the local ones would
     * make both headings mean nothing.
     */
    where?: Record<string, ModelHosting>;
    /**
     * Ids this backend prices at zero, measured from its own catalogue.
     *
     * Absent — or an id missing from a present list — means UNKNOWN, and the
     * phone must not draw unknown as "free": that is the direction that costs
     * somebody money. It exists so the picker can say the one thing that is
     * always true about a free hosted model without waterplane restating any
     * operator's contract: you are not paying in money, so read what the
     * operator takes instead.
     */
    zeroCost?: string[];
    /**
     * The window each id is CONFIGURED to hold, in tokens — the runner's
     * `num_ctx` or the endpoint's configured window. Absent, or an id missing,
     * is UNKNOWN: never claude's 200k table, never another model's number.
     * Read by `windowAdviceText`, never drawn as a bare figure.
     */
    contextWindow?: Record<string, number>;
    /**
     * Input tokens of the FIRST request of the most recent conversation that
     * ran this id, read off the CLI's own log — what Claude Code's prompt and
     * tools took before the conversation started. A MEASUREMENT: absent when
     * no conversation on this model was found, never estimated.
     */
    overheadTok?: Record<string, number>;
  };
  /**
   * The backend's context-window size in tokens, when it is a known, fixed
   * fact about the backend (not a per-session measurement — see
   * `SessionInfo.contextTotalTok` / `ctxwindow.ts` for that).
   *
   * Absent = unknown. MUST NEVER be rendered as a number, and never defaulted
   * to 0 or to claude's own window — a local model's context size is a fact
   * about a file on someone else's disk, not something this app is entitled
   * to guess.
   */
  contextWindowTokens?: number;
  /**
   * Why this backend cannot be launched right now, as a sentence ("Ollama not
   * reachable at http://…"). Present => the backend is still LISTED and the
   * phone says this instead of hiding it; absent => nothing is known to be wrong.
   */
  unavailable?: string;
  /**
   * The backend comes from an extension marked experimental (its manifest's
   * `experimental`; opencode, `deploy/ship.json`). The phone labels it so where
   * backends are listed. Absent = not experimental; an old phone ignores it.
   */
  experimental?: true;
}
