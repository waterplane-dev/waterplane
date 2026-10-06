/** The reader view's document — the CLI's own conversation log, parsed. */

/**
 * ── Structured transcript (the "reader" view of a conversation) ───────
 *
 * Parsed from the claude CLI's OWN conversation log
 * (`~/.claude/projects/<slug>/<conversation-uuid>.jsonl`) — NOT from PTY text.
 * That's what makes this view exact where the terminal is approximate: real
 * message boundaries, real tool names/inputs/results, no ANSI, no re-wrapping.
 * The phone renders it as normal DOM, so scrolling/selection/find/links behave
 * like a web page instead of a terminal grid.
 */
export type TranscriptBlock =
  /** Assistant prose (markdown source, rendered client-side). */
  | { kind: "text"; text: string }
  /** Extended-thinking block — collapsed by default in the UI. */
  | { kind: "thinking"; text: string }
  /**
   * TERMINAL TEXT — what the CLI printed on its own screen, ANSI-stripped.
   *
   * The reader's whole premise is that the conversation log is the exact
   * record, and for everything the model says it is. A TUI-local command is the
   * hole in that premise: `/btw`, `/goal`, `/usage` and friends are answered by
   * the CLI itself, so either the log holds only their `<local-command-stdout>`
   * envelope (which the parser used to drop as plumbing) or — for the ones the
   * CLI never writes down at all — nothing. Read mode therefore showed a
   * conversation with the command and its answer simply missing, while the
   * terminal one tab away showed both.
   *
   * Rendered MONOSPACE and never as markdown: this is screen text, complete
   * with box drawing and hint rows, and running it through a markdown renderer
   * turns a `*` into emphasis and a table into soup.
   */
  | {
      kind: "screen";
      text: string;
      /**
       * The CLI drew this inside a panel it could SCROLL, so `text` is the rows
       * that were painted and not the whole answer.
       *
       * A PTY capture is a replay of painted cells (host `render.ts`), and a TUI
       * paints only the slice of a panel that is on screen — so what sat below
       * the fold is in no record at all: not here, not in the scrollback, not in
       * the conversation log the command never reached. It exists only inside
       * the live CLI process, and only while that panel is still open.
       *
       * Set off the CLI's own "↑/↓ to scroll" footer, which is chrome the parser
       * strips — so this is the one piece of that furniture kept as EVIDENCE.
       * It says the panel was scrollable, not that text was definitely lost: the
       * footer is printed whether or not the content overflowed. The reader
       * words it that way.
       */
      scrollable?: boolean;
    }
  /** A tool call plus (when it came back) its result. */
  | {
      kind: "tool";

      /** tool_use id — how the result is matched back to the call. */
      id: string;
      /** Tool name as the model called it (Bash, Edit, Task, …). */
      name: string;
      /** One-line gist of the input (the command, the file, the query). */
      label: string;
      /** Pretty-printed input, truncated. Absent in a `lite` document — see `omitted`. */
      input?: string;
      /** Tool output, truncated (see `resultTruncated`). Absent = still running / no
       *  result recorded, OR withheld by a `lite` document — see `omitted`. */
      result?: string;
      /** False when the tool reported an error. Also the "a result came back at all"
       *  signal a `lite` block has left: it is set exactly when a tool_result was
       *  matched back, whether or not the text travelled with it. */
      ok?: boolean;
      resultTruncated?: boolean;
      /**
       * The call's input/result were deliberately LEFT OUT of this document, not
       * missing from the log. Set on every tool block of a `lite` transcript —
       * which is the default, because those two strings are ~95% of a busy
       * conversation's bytes and almost none of what someone reads on a phone.
       * The reader shows a placeholder and fetches the pair on demand
       * (`GET /api/transcript/tools`). Never set in a `detail=full` document.
       */
      omitted?: boolean;
    };

/** One user prompt and everything the assistant did in response. */
export interface TranscriptTurn {
  /** Stable id (the conversation-log uuid of the prompt record). */
  id: string;
  /**
   * This turn is not a prompt somebody typed.
   *
   * `"compaction"` is opencode's own record of a conversation being compacted —
   * a user-role row with no prompt text at all (measured: exactly the 43 rows
   * that carry a compaction part are exactly the 43 user rows with no text).
   * The reader draws a labelled divider for it. Without the marker those turns
   * would render as prompts somebody sent and left blank, which is a claim
   * about a person rather than about the tool.
   */
  marker?: "compaction";
  /** 1-based turn number, for the outline. */
  n: number;
  /** Full prompt text. */
  prompt: string;
  /** Single-line, truncated prompt — the outline label. */
  promptLabel: string;
  /** ms epoch of the prompt / of the last record in the turn. */
  sentAt?: number;
  endedAt?: number;
  blocks: TranscriptBlock[];
  /** Heuristic one-liner from the turn's final assistant text (no AI call). */
  summary?: string;
  toolCount: number;
  /** Unique repo-relative paths the turn wrote to (Edit/Write/NotebookEdit). */
  files: string[];
  /** Number of sub-agent (sidechain) records this turn produced. */
  sidechains: number;
  /**
   * This turn is a command the CLI answered ITSELF — no model call, no turn in
   * the usual sense — and where its text was recovered from.
   *
   * `"log"`: the conversation log wrote the `<command-name>`/`<command-args>`
   * envelope and a `<local-command-stdout>` beside it, so the words are exact.
   * `"screen"`: the log holds nothing at all (`/btw` is the measured case) and
   * this was rebuilt from the PTY capture waterplane keeps per turn — approximate by
   * construction, which is why it says so on the row rather than passing for a
   * log record.
   */
  local?: "log" | "screen";
  /**
   * **Sent, and the CLI has not taken it yet.**
   *
   * A prompt typed into a session that is mid-turn is HELD by the TUI until the
   * turn ends — it sits in the composer, visibly accepted, and the conversation
   * log gets nothing until the CLI actually starts it (measured: a prompt sent
   * at 09:57 reached the log at 10:04, behind a 131-tool turn). Every reader
   * here is built on that log, so for those minutes the outline was missing the
   * newest thing the person had sent and looked simply wrong — reported as "the
   * last thing I sent is being worked on but does not show in the list".
   *
   * So the row is drawn from what waterplane itself delivered (`HistoryEntry`), and
   * it says exactly that much: these words went in, nothing has started them.
   * It carries no blocks, no tools and no summary, because there is no turn yet
   * — the moment the log takes the prompt, the logged turn replaces it.
   */
  queued?: true;
  /**
   * **The CLI took these words into the turn that was already running.**
   *
   * The other half of `queued`. A prompt typed into a busy session is held by
   * the TUI, and when the turn ends the CLI normally starts it as a turn of its
   * own — a `user` record in the log, which every reader here is built on. But
   * it may instead ABSORB it into the running turn, and then it writes no
   * `user` record at all: the prompt exists in the log only as an `attachment`
   * of type `queued_command`, and the answer to it is appended to the turn
   * above.
   *
   * Measured on this desktop over seven days: 48 of 62 real queued prompts were
   * recorded that way and no other. The reader therefore drew no turn for them,
   * folded their answer into the previous prompt's turn, and — because nothing
   * in the log ever matched those words — left waterplane's own `queued` row saying
   * *the CLI has not started it yet* for ever, sorted BELOW the answer it had
   * already given. The report was "read mode misses the last output of the CLI",
   * and it was not the output that was missing: it was the boundary.
   *
   * So the attachment opens a turn, and this flag is what the row says about
   * it — the words went in mid-turn, so the assistant text above may be
   * answering the previous prompt as well. Exact, not approximate: the words
   * and the instant are the CLI's own record of them.
   */
  absorbed?: true;
  /**
   * **What this turn's own requests would have cost, at list prices (USD).**
   *
   * Every main-thread assistant request between this prompt and the next,
   * deduped by `message.id` and priced on its own model and day — the rule
   * `ctxlog.ts` prices the session by, so these sum to the same accounting.
   * Subagents are NOT in it (their logs are separate files; `sidechains` says
   * whether there were any). Absent when the turn ran no request, and absent —
   * never a partial sum — when any of its requests ran on an unpriced model.
   */
  costUsd?: number;
  /**
   * **The conversation's running total by the end of this turn**, same
   * accounting as `costUsd`. Absent when the log was tail-read (the start of
   * the conversation is not in hand, so any sum is short) and from the first
   * unpriced request on.
   */
  cumCostUsd?: number;
  /**
   * **Context the turn's last request carried** — input + cache read + cache
   * write, the number the window gauge measures. Tokens, not a percentage: the
   * window is not in the log, and a guessed one would be a wrong number.
   */
  ctxTok?: number;
  /**
   * **This turn's own requests, by token kind** — the split behind `costUsd`,
   * summed over the same deduped records (so a dollar figure is never printed
   * without the four numbers it was priced from). `cacheWrite` is both tiers.
   * Subagents are not in it, as they are not in `costUsd`. Absent when the
   * turn ran no request; never zeros for "not measured".
   */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /**
   * **Which models this turn's own requests ran on**, by the alias
   * (`normalizeModel`), in first-seen order. `tok` is all four kinds; `costUsd`
   * is absent for a model with no published rate. Same records as `costUsd`,
   * so the parts sum to it. Absent when the turn ran no request.
   */
  models?: { id: string; tok: number; costUsd?: number }[];
  /**
   * **The subagents this turn STARTED, counted by kind** — each `Task`/`Agent`
   * tool call's `subagent_type`, off the call itself (so exact even when the
   * reader's document is `lite`). `"(no type)"` when the call named none.
   * What they spent is `agentCostUsd`, never folded into `costUsd`.
   */
  agentTypes?: { type: string; n: number }[];
  /**
   * **What the subagents this turn started have spent SO FAR** — their own logs,
   * nested agents included, priced per record (`turnagents.ts`, the same
   * ledger as the header's total). Kept apart from `costUsd`, which stays this
   * conversation's own requests. Absent when the turn started none that spent
   * anything, or when the agent directory could not be read.
   */
  agentCostUsd?: number;
  /** Agent tokens on a model with no published rate — in no dollar figure. */
  agentUnpricedTok?: number;
  /** The same spend by model alias, so the turn's bar can show who spent it. */
  agentModels?: { id: string; tok: number; costUsd?: number }[];
  /**
   * **How many of this turn's subagents are still running.** A background
   * agent's call returns at once, so a turn looks finished long before its
   * agents are, and `agentCostUsd` is then a floor. Absent = none running.
   */
  agentsRunning?: number;
  /**
   * The subagents' spend through this turn, running — `cumCostUsd`'s twin, so
   * the two added are the header's session total. Absent whenever
   * `cumCostUsd` is, and whenever any agent could not be placed on a turn.
   */
  cumAgentCostUsd?: number;
}

/** A whole conversation, ready to render. */
export interface TranscriptDoc {
  /** waterplane session id this was fetched for. */
  sessionId: string;
  /** claude conversation uuid (absent for the history fallback). */
  claudeSessionId?: string;
  /** "jsonl" = the CLI's own log (exact). "history" = fallback built from the
   *  recorded prompt + ANSI-stripped PTY capture (approximate; used when the
   *  conversation log isn't available yet, e.g. a stub binary). */
  /**
   * Where the document came from. `"store"` is EXACT, like `"jsonl"` — it is
   * the backend's own dated record, read out of its store by the store reader
   * the backend names (`PluginStoreReader`; it was spelt `"opencode"` while
   * opencode's was the only one). Only `"history"` is
   * approximate, and it is the one every client already special-cases, so an
   * older phone treats an unknown source as exact, which is correct.
   *
   * `"backend"` is a backend's own `TranscriptSource` (a plugin's fold of its
   * CLI's event log) for a backend with no core reader — exact for the same
   * reason, and additive for the same reason.
   */
  source: "jsonl" | "history" | "store" | "backend";
  turns: TranscriptTurn[];
  /** True when the log was too big and only its tail was parsed. */
  truncated: boolean;
  /** Size of the source log in bytes (0 for the history fallback). */
  bytes: number;
  /** ms epoch of the log's last modification (so the client can poll cheaply). */
  updatedAt: number;
  /**
   * How much of each tool call travelled. `"lite"` (the default the reader asks
   * for) carries names, labels and ok/error but NOT inputs or results — see
   * `omitted` on the tool block. `"full"` is the whole thing, for a caller that
   * genuinely wants every byte. Absent on documents from an older host, which
   * read as full — the fields are simply present.
   */
  detail?: "lite" | "full";
}

/** The two strings a `lite` tool block left behind, fetched on demand and keyed
 *  by the tool_use id so a merge back into the document cannot mis-align. */
export interface TranscriptToolDetail {
  input?: string;
  result?: string;
  ok?: boolean;
  resultTruncated?: boolean;
}

/**
 * The reader's document as plain text — what the phone's select/copy sheet
 * shows when no terminal is mounted.
 *
 * The xterm is UNMOUNTED in reader view, so the grid dump the sheet was built
 * on (`TerminalHandle.getText()`) returns "" there and the sheet opened empty,
 * looking like a broken button. That is also what you hit with the link down,
 * because offline is precisely when you are reading the cached transcript
 * rather than watching a live grid.
 *
 * It lives here, beside the types, rather than in the web package: it is a pure
 * function of the wire document, and everything in `packages/web/src` that
 * would host it imports `localStorage` helpers, which is what stops it being
 * runnable under `node --test`.
 *
 * Tool inputs and results are usually absent — the reader asks for a `lite`
 * document, whose tool blocks carry name + label only (see `omitted` above).
 * The label is then all there is to copy, which is also all the reader shows.
 */
export function transcriptText(doc: TranscriptDoc): string {
  const indent = (t: string) => t.split("\n").map((l) => `    ${l}`).join("\n");
  const clock = (ts?: number) =>
    ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const out: string[] = [];
  for (const turn of doc.turns) {
    const when = clock(turn.sentAt);
    out.push(`\u2500\u2500 #${turn.n}${when ? ` \u00b7 ${when}` : ""} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    if (turn.prompt.trim()) {
      out.push(turn.prompt.trim().split("\n").map((l) => `> ${l}`).join("\n"));
    }
    for (const b of turn.blocks) {
      if (b.kind === "screen") {
        if (!b.text.trim()) continue;
        out.push("", indent(b.text.trimEnd()));
        continue;
      }
      if (b.kind === "text" || b.kind === "thinking") {
        if (!b.text.trim()) continue;
        out.push("", b.kind === "thinking" ? `[thinking]\n${indent(b.text.trim())}` : b.text.trim());
        continue;
      }
      out.push("", `[${b.name}]${b.label ? ` ${b.label}` : ""}${b.ok === false ? " \u2014 FAILED" : ""}`);
      if (b.input) out.push(indent(b.input));
      if (b.result) out.push(indent(b.result + (b.resultTruncated ? "\n\u2026(truncated)" : "")));
      else if (b.omitted) out.push("    (input and result not loaded \u2014 open the call in the reader first)");
    }
    out.push("");
  }
  // A document with no renderable content must come back as "" and not as a
  // string of separators: the caller uses the empty string to decide whether to
  // show its own "nothing cached yet" explanation instead.
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return /[^\s\u2500]/.test(text) ? text : "";
}
