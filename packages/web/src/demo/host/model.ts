/**
 * The demo desktop's state — `DemoState.model`, typed (WP2b).
 *
 * The snapshot rule (snapshot.ts) stores the model as `Json`; this file is
 * the typed VIEW handlers read and mutate through `modelOf(state)`. Every
 * field is optional in a scenario file: an absent list reads as empty and an
 * absent number is never invented — the frame that would carry it is simply
 * not sent, the way the real host sends no `clihealth` when it has no store.
 * ("Heuristics degrade to null or absent, never to a wrong number.")
 *
 * The shape is documented for scenario authors in docs/analysis/
 * demo-mode-plan.md, "WP2b: what landed". Wire types are reached through
 * `HostMessage` (`Frame<"…">`) so a wire change shows up here as a tsc error.
 */
import type { DetectedPrompt, HostMessage, SessionInfo, TranscriptTurn } from "@waterplane/shared";
import type { DemoState } from "./snapshot.ts";

/** The `HostMessage` of type `T`. */
export type Frame<T extends HostMessage["t"]> = Extract<HostMessage, { t: T }>;

/** One step the demo desktop takes on its own: a scenario script event, a
 *  scripted reply to a prompt, or what follows an answered choice box. */
export type DemoStep =
  /** Broadcast this frame as-is (WP2a's original event). `keep: true` also
   *  writes it into the model, so a later READ of the same thing answers what
   *  was broadcast (`keepFrame` in desk.ts names the frames that can be kept). */
  | { kind: "frame"; msg: HostMessage; keep?: true }
  /** Jump the demo's clock FORWARD to `to` (an instant on the demo's scale:
   *  the scenario's `now` plus whatever it adds). Everything due by then fires,
   *  in order; the steps after this one in the same list are laid out from the
   *  NEW now, so a turn that resumes "at the reset" keeps its own pacing. A `to`
   *  already passed is a no-op: the clock never runs backwards. The transport
   *  moves the page's `Date` by the same amount (transport.ts), so a countdown
   *  on screen agrees with the desktop it counts for. */
  | { kind: "clock"; to: number }
  /** A fresh `/usage` reading, taken as the step runs (`checkedAt` is the
   *  demo's now): kept as `numbers.usage` and broadcast as `usage.status`. */
  | { kind: "usage"; usage: Omit<Frame<"usage.status">["usage"], "checkedAt"> }
  /** The account's usage window ran out during this turn (usagewall.ts): the turn
   *  stops and the session is parked until `resetAt`, with the host's decision
   *  row and notification. `meanwhile` is laid out from now — where a scenario
   *  puts the `clock` step that gets to the reset. With auto-continue on
   *  (`limitConfig`) an `autoContinue` fires AT `resetAt`, then `resumed`, then
   *  the steps after this one in the same list (a reply's own end of turn);
   *  with it off, the session stays parked and they never run. */
  | { kind: "wall"; sessionId?: string; resetAt: number; meanwhile?: DemoTimedStep[]; resumed?: DemoTimedStep[] }
  /** The host's auto-continue at the reset: "continue" typed, the turn starts,
   *  the block clears. Holds the rest of its list until it fires, so what
   *  follows is paced from the reset, not from when it was laid out. */
  | { kind: "autoContinue"; sessionId?: string }
  /** Write `text` into the session's PTY (`\r\n` line ends, ANSI allowed). */
  | { kind: "output"; sessionId?: string; text: string }
  /** Put a choice box on the session — the parsed `SessionInfo.prompt` the
   *  phone answers by tap (`session.updated`). `answers` maps the option
   *  index ("1", "2", …), "submit" (a checkbox box's Submit row), "esc" or
   *  "*" (any) to what follows; the steps after this one in the same list run
   *  after whichever answer, so a scripted turn reads top to bottom. */
  | { kind: "prompt"; sessionId?: string; prompt: DetectedPrompt; answers?: { [key: string]: DemoTimedStep[] } }
  /** Patch the session (turnActive, contextLeft, tabTitle, …) and broadcast
   *  `session.updated`. `unset` removes fields (JSON has no undefined). */
  | { kind: "session"; sessionId?: string; patch: Partial<SessionInfo>; unset?: (keyof SessionInfo)[] }
  /** The turn is over: `turnActive:false`, and a backlog item running in this
   *  session is done. Appended to every scripted reply automatically. */
  | { kind: "turnEnd"; sessionId?: string }
  /** The CLI's log has priced the session's newest prompt: the reader's turn
   *  foot figures for it (`TranscriptTurn`'s own fields, so the demo feeds the
   *  real renderer exactly what a real host's `transcript.ts` would). */
  | { kind: "facts"; sessionId?: string; facts: DemoTurnFacts }
  /** A file lands in a repo's outbox while this session runs: into the gallery
   *  (`/api/repos/<id>/artifacts`, the badge count), and — as the real host's
   *  turn-end scan does — `session.images` to the session's strip plus an
   *  `image` notification. The bytes are bundled media (`demo/media.ts`). */
  | { kind: "artifact"; sessionId?: string; repoId: string; relPath: string; size: number };

/** The per-turn figures a scenario states for the reader (`DemoStep` `facts`). */
export type DemoTurnFacts = Pick<TranscriptTurn,
  "costUsd" | "cumCostUsd" | "ctxTok" | "tokens" | "models" | "agentTypes" | "agentCostUsd" | "cumAgentCostUsd" | "agentModels">;

/** A step with its delay after the PREVIOUS step of the same list. */
export type DemoTimedStep = DemoStep & { afterMs?: number };

/** What a submitted prompt gets back. First rule that matches wins. */
export interface DemoReply {
  /** Case-insensitive substring of the prompt; absent = any prompt. */
  match?: string;
  /** Only in sessions whose cwd is (or is under) this directory. */
  cwd?: string;
  steps: DemoTimedStep[];
}

/** One session's PTY as bytes the phone replays. `data` is the retained tail
 *  (utf-8 text); `seq` counts every byte ever written, like the host's ring. */
export interface DemoScreen {
  data: string;
  seq: number;
  cols?: number;
  rows?: number;
}

/** An open choice box and what follows each answer. */
export interface DemoBox {
  answers: { [key: string]: DemoTimedStep[] };
  rest: DemoTimedStep[];
}

export interface DemoModel {
  /** `/api/repos` targets (`RepoTarget`). `worktreePath` is what a create /
   *  backlog add names as its cwd; a cwd outside every one is refused. */
  repos?: unknown[];
  sessions?: SessionInfo[];
  screens?: { [sessionId: string]: DemoScreen };
  history?: { [sessionId: string]: Frame<"session.history">["entries"] };
  /** Reader figures per history row id, per session (`facts` steps, or seeded). */
  turnFacts?: { [sessionId: string]: { [historyId: string]: DemoTurnFacts } };
  recent?: Frame<"recent.list">["recent"];
  closed?: Frame<"closed.list">["closed"];
  backlog?: { items?: Frame<"backlog.list">["items"]; auto?: boolean; idleMs?: number };
  schedules?: Frame<"schedule.list">["entries"];
  intents?: Frame<"intent.list">["intents"];
  launches?: Frame<"launch.list">["launches"];
  deliveries?: Frame<"delivery.list">["items"];
  /** `/api/repos/<id>/artifacts` files (`FileEntry`), per repo id. Thumbnails
   *  come from bundled media through `abs()` (WP1/WP4), never through here. */
  gallery?: { [repoId: string]: unknown[] };
  /** `/api/repos/<id>/inbox` files, per repo id. */
  inbox?: { [repoId: string]: unknown[] };
  artifactPolicies?: { [repoDir: string]: Frame<"artifacts.config">["policy"] };
  settings?: Frame<"settings.all">["doc"];
  notifications?: Frame<"notification.list">["items"];
  plugins?: Frame<"plugin.list">["plugins"];
  decisions?: Frame<"decisions.log">["entries"];
  sent?: Frame<"sent.log">["entries"];
  pulls?: Frame<"pull.list">["items"];
  install?: Frame<"install.log">["doc"];
  /** Every number is optional; absent means its frame is not sent. */
  numbers?: {
    usage?: Frame<"usage.status">["usage"];
    meter?: Frame<"meter.status">["summary"];
    budget?: { budget: Frame<"budget.state">["budget"]; verdict: Frame<"budget.state">["verdict"] };
    clihealth?: { health: Frame<"clihealth">["health"]; rollup: Frame<"clihealth">["rollup"] };
    update?: Frame<"update.status">["info"];
    notifyPrefs?: Frame<"notify.prefs">["prefs"];
    /** `/api/context?id=` documents (`ContextSeriesDoc`), per session id. */
    context?: { [sessionId: string]: { updatedAt: number; [k: string]: unknown } };
    /** `true` = answer `/api/tokenstats`, `/api/tokenwindows` and `/api/usagelog` from `ledger.ts`'s
     *  fictional fortnight instead of the honest empty document. Absent = no logs to count. */
    ledger?: true;
    /** `true` = answer `/api/repos/<id>/repohealth` from `repohealth.ts`'s fictional series for the
     *  demo repos. Absent = the honest 404. */
    repoHealth?: true;
  };
  /** The host-wide auto-continue switch and resume mode (`limit.config`); absent = switched off. */
  limitConfig?: { enabled: boolean; mode?: Frame<"limit.config">["mode"] };
  /** `/api/storage/*` answers; absent = an empty, honest report. */
  storage?: { transport?: unknown; host?: unknown };
  /** What a submitted prompt gets back. */
  replies?: DemoReply[];
  /** Written into a new session's PTY; `{repo}` and `{cwd}` are filled in. */
  banner?: string;

  // ── the engine's own bookkeeping (scenario files leave these out) ──────
  /** Steps waiting for their time, fired by `advance()`. */
  timeline?: { at: number; n: number; sessionId?: string; step: DemoStep; rest?: DemoTimedStep[] }[];
  boxes?: { [sessionId: string]: DemoBox };
  /** Raw keystrokes typed into a session's composer, not yet submitted. */
  composer?: { [sessionId: string]: string };
  /** Id counter for everything the demo mints. */
  minted?: number;
  /** Intent ids the demo judges and runs itself (waiting.ts): a person's
   *  *when it's free* sends. A scenario's seeded intents are never in it. */
  runs?: string[];
  /** How far `clock` steps have moved the demo ahead of the injected clock, ms. */
  clockShift?: number;
  /** Sessions whose budget crossing was already told (the host's `budgetTripped` latch). */
  budgetTripped?: { [sessionId: string]: true };
}

/** The typed view of `state.model`. Same object: mutating it mutates state. */
export const modelOf = (state: DemoState): DemoModel => state.model as unknown as DemoModel;

/** What a handler (and a fired step) may do to the outside world. Built by
 *  the dispatcher (index.ts); sockets and faults stay its business. */
export interface Desk {
  m: DemoModel;
  now(): number;
  bootId: string;
  broadcast(msg: HostMessage): void;
  /** To every socket attached to session `id` (PTY frames go only there). */
  toSession(id: string, msg: HostMessage): void;
}

export function mint(m: DemoModel, prefix: string): string {
  m.minted = (m.minted ?? 0) + 1;
  return `${prefix}-${m.minted}`;
}

/** Directories the demo will open things in. Empty = no repos seeded, and
 *  then anything goes (a bare test scenario). */
export function inRepos(m: DemoModel, dir: unknown): boolean {
  if (typeof dir !== "string" || !dir) return false;
  const roots = (m.repos ?? [])
    .map((r) => (r && typeof r === "object" ? (r as { worktreePath?: unknown }).worktreePath : undefined))
    .filter((p): p is string => typeof p === "string" && !!p);
  if (!roots.length) return true;
  return roots.some((r) => dir === r || dir.startsWith(r.endsWith("/") ? r : `${r}/`));
}

export const NOT_A_DEMO_REPO = "That folder is not one of the demo's repos — pick one from the list.";

// ── bytes, without a DOM or Node global (the core's tsc runs with no lib.dom) ──

export function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}
