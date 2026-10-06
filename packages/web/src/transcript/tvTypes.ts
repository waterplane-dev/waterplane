import type { ReactNode } from "react";
import type { SessionCostReading } from "@waterplane/shared";
import type { AnswerSuggestion, DetectedPrompt, SessionAgent, SessionShell, TranscriptToolDetail } from "@waterplane/shared";
import type { FileRefCtx } from "../Markdown";
import type { ReaderToolsMode } from "../transcriptUtil";
import type { ForkCtx } from "../ForkTurn";

/**
 * Live state of the session behind the transcript. The reader has no terminal —
 * no spinner, no cursor — so without this you cannot tell "the agent is grinding
 * through a 3-minute build" from "it finished and is waiting for you".
 */
export interface TranscriptStatus {
  running: boolean;
  /** A turn is in flight. */
  busy: boolean;
  /** `busy` came from the claude hooks (exact) rather than the silence guess. */
  exact: boolean;
  /** Parked on a choice prompt — waiting on YOU, not working. */
  waiting: boolean;
  /**
   * The parsed choice box. The reader draws it at the tail AND answers it: the
   * session screen's `approve` bar is gone, so this card and `QuestionsSheet`
   * are the two surfaces with room for the whole question (`PromptAnswer.tsx`).
   */
  prompt?: DetectedPrompt | null;
  /** A plugin's suggested answer for that box (`plugin.ts`). */
  suggestion?: AnswerSuggestion | null;
  /**
   * A dialog is on screen that the host could not parse into options. There are
   * no one-tap buttons for it — the honest answer is "open the CLI".
   */
  awaitingInput?: boolean;
  /**
   * The turn ENDED on a question asked in prose — no box, nothing to tap. The
   * reader is the view with no terminal to notice it in, and this is the state
   * it used to call "idle — nothing running": true of the CLI, false of the
   * work. (`SessionInfo.asking`, host `question.ts`.)
   */
  asking?: { text: string; at: number } | null;
  /**
   * Agents running UNDER the session (host `agents.ts`), which is work the turn
   * flag does not cover: a BACKGROUND agent keeps going after the main loop's
   * Stop, so `busy` is honestly false while two reviewers are still reading.
   * The terminal says so in a footer this view does not have, and without it
   * the strip called that state "idle — nothing running".
   */
  agents?: SessionAgent[];
  /** Background shells still running under an idle main loop (host
   *  `readCliStatus`) — the same "not idle", without a count. */
  shells?: boolean;
  /** What each of those shells actually IS (host `shells.ts`) — the richer
   *  reading `shells` alone does not carry. Absent on an older host or a read
   *  that could not run; [] is a read that found none. */
  shellList?: SessionShell[];
  /** Blocked on a usage limit. */
  blocked: boolean;
  /**
   * The socket is not open, so every field above describes the session as of
   * the last frame that reached this phone. Without it the strip keeps
   * ASSERTING "working · 43m 56s" — a counter ticking off `turnStartedAt`,
   * which grows just as convincingly whether the agent is working or the
   * tunnel died forty minutes ago. Same rule the backlog's waiting reasons
   * follow: a session fact read from a cache is a fact about the past.
   */
  linkDown?: boolean;
  turnStartedAt?: number;
  /** Epoch ms of the last PTY frame this client saw for the session. */
  lastOutputAt?: number;
  /** Recent raw PTY output — scanned for the CLI's own working line. */
  tail?: string;
}

export interface TranscriptViewProps {
  sessionId: string;
  /** Bump to force a refetch (the session's turn just ended). */
  refreshKey: number;
  /** Live session state, rendered as the status strip. */
  status?: TranscriptStatus;
  /** Switch back to the xterm view. */
  onShowCli: () => void;
  /** What an EMPTY reader shows instead of a blank page: the top of the CLI
   *  (`CliPeek`). `leaving` turns true when the first turn lands; the peek
   *  animates away and calls `onGone`, after which it is not drawn again. */
  cliPeek?: (leaving: boolean, onGone: () => void) => ReactNode;
  /**
   * Queue an answer to the open choice box — App's `answerPrompt`, bound to this
   * session: durable, fingerprinted, first in its lane, refused host-side once
   * the box it names has gone. Absent ⇒ the question is drawn as a READOUT and
   * the CLI is where it gets answered.
   */
  onAnswer?: (data: string, label: string, submitBox?: boolean, choice?: number) => void;
  /**
   * Answers already queued for the open box, matched by the caller on the
   * prompt FINGERPRINT — the difference between "your tap did nothing" and
   * "your tap is waiting for the tunnel".
   */
  queuedAnswers?: readonly { label: string }[];
  /**
   * A verb fired from the TOOLBAR, which is where the reader's own controls
   * live now: outline, find and refresh are ordinary catalog actions the user
   * orders, hides and pins (`toolbar.ts`'s READER_TOOLBAR_IDS). They used to be
   * a bar of this component's own, portalled into a fixed slot in the session
   * header — a strip beside the configurable one that the config had no say
   * over. The STATE behind them is derived from the rendered document and so
   * stays here; only the buttons left.
   *
   * `key` bumps per tap, for `jumpTo`'s reason: firing the same verb twice must
   * act twice, and the kind alone is an unchanged prop the second time.
   */
  cmd?: { kind: "outline" | "find" | "refresh"; key: number };
  /**
   * Turn to scroll to, set by the outline SHEET (which can be opened from the
   * terminal). `key` bumps per tap so jumping to the same turn twice still
   * scrolls — the turn number alone would be an unchanged prop the second time.
   */
  jumpTo?: { n: number; key: number };
  /** Makes `.claude/inbox` / `.claude/outbox` paths in the conversation tappable
   *  (thumbnail for an image). Omitted = they render as plain text. */
  files?: FileRefCtx;
  /** How much of a tool call to show and to download — the user's setting
   *  (`transcriptUtil.ts`). Passed in rather than read here so flipping it in
   *  Settings re-renders (and refetches) the open reader immediately. */
  toolsMode: ReaderToolsMode;
  /** Absent = this build has no conversation verbs; the affordance is not drawn. */
  fork?: ForkCtx;
  /** Opens the context sheet for this session — the turn-cost strip's tap. */
  onOpenCost?: () => void;
  /** This session's cost reading (`sessionCostOf` over its `contextSpark`) —
   *  what the NEXT prompt re-reads against a fresh session, drawn under the
   *  newest FINISHED turn only. Absent ⇒ that line is absent. */
  nextTurn?: SessionCostReading | null;
  /** Dollars per percent of the weekly limit (`weekUsdPerPct`), so each turn's
   *  cost also reads as a share of the week; null/absent ⇒ no share drawn. */
  usdPerWeekPct?: number | null;
  /** What that week calibration counted beyond this desktop (`incl. $0.84 on pc`), said in the note. */
  weekIncl?: string | null;
  /** Opens the shells sheet for this session — the status strip's "see
   *  shells" door, drawn only while the strip has shells to say something
   *  about. */
  onOpenShells?: () => void;
  /** Interrupts the running turn — Esc into the PTY, the same key the CLI
   *  itself stops on. Absent ⇒ no stop button is drawn. */
  onStop?: () => void;
  onToast: (msg: string) => void;
}

/** Per-turn load state for the details a `lite` document withheld. */
export type DetailState =
  | { state: "loading" }
  | { state: "ok"; tools: Record<string, TranscriptToolDetail> }
  | { state: "error"; msg: string };
