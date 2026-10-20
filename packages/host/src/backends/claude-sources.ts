/**
 * claude's structured facts, on the SAME `sources` seam opencode and Copilot use
 * (docs/analysis/backends-design.md §10).
 *
 * The channel is the hook pipe `claude.ts`'s `hookSettingsArg` injects: the CLI
 * curls each lifecycle event to `POST /api/hook`. That route and its ROUTER stay
 * in core (`sessions/turn.ts`'s `onHookEvent` / `routeHook`) because finding the
 * session a hook belongs to needs the host's live conversation ids, cwds and
 * spawn times, which a source never sees. Once routed, the payload comes here
 * (`postClaudeHook`) and is translated into the seam's edges, the way a plugin
 * translates Copilot's events:
 *
 *  - any event, the first one ⇒ health `up` (the pipe works: `hooked`);
 *  - `SessionStart` ⇒ `identified(session_id)`, then `ready` (+ re-read the model);
 *  - `UserPromptSubmit` ⇒ `started` with the words the CLI took;
 *  - `Stop` ⇒ `ended` (+ re-read the model) — a REQUEST a hook may refuse,
 *    which is what `verifyEnds` tells the host;
 *  - `SessionEnd` ⇒ `ready`;
 *  - `Notification` and anything else ⇒ nothing beyond the health edge (the
 *    regex prompt path owns the dialogs).
 *
 * `inBand`: there is nothing to connect — the subscription is live from
 * `attach`, and the health is never published as `sideChannel` (absent for
 * claude, as it always was). Only `turns`: transcript and context stay the named
 * core readers (`caps.transcript: "claude-jsonl"`, `contextMeter`), and the
 * delivery proof stays `deliver.ts`'s `prompt-hook` rung over the words recorded
 * from `started` (§10 says why).
 *
 * Module state, keyed by the waterplane session id: one subscription per live
 * channel, gone when the channel closes. A post for a session with no live
 * subscription is refused (`false`) and changes nothing.
 */
import type { BackendSources, ChannelHealth, SourceHandle, SourceSession, TurnSource } from "@waterplane/shared";

type TurnWatcher = Parameters<TurnSource["watch"]>[1];

interface Sub {
  readonly onHealth: (h: ChannelHealth) => void;
  on: TurnWatcher | null;
  health: ChannelHealth;
}

const subs = new Map<string, Sub>();

/** The payload fields a hook carries that this file reads. */
export interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  /** `PreToolUse` only (matched to `AskUserQuestion`): the call, before its box. */
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
}

export const claudeSources: BackendSources = {
  inBand: true,
  turns: {
    verifyEnds: true,
    watch(ss: SourceSession, on: TurnWatcher): () => void {
      const sub = subs.get(ss.id);
      if (!sub) return () => {};
      sub.on = on;
      return () => { if (sub.on === on) sub.on = null; };
    },
  },
  attach(ss: SourceSession, onHealth: (h: ChannelHealth) => void): Promise<SourceHandle> {
    const sub: Sub = { onHealth, on: null, health: { state: "down", since: Date.now(), note: "no hook has reported yet" } };
    subs.set(ss.id, sub);
    return Promise.resolve({
      health: () => sub.health,
      close: async () => { if (subs.get(ss.id) === sub) subs.delete(ss.id); },
    });
  },
};

/** Is a live channel listening for this session's hooks? The router's candidate rule. */
export function claudeHookWatched(hostSessionId: string): boolean {
  return !!subs.get(hostSessionId)?.on;
}

/**
 * Hand a routed hook to its session's subscription. `false` = nobody is
 * listening (a hookless backend, a closed channel), and nothing happened.
 */
export function postClaudeHook(hostSessionId: string, payload: ClaudeHookPayload): boolean {
  const sub = subs.get(hostSessionId);
  const on = sub?.on;
  if (!sub || !on) return false;
  // The pipe going LIVE is the edge — once, on the first hook that arrives,
  // whatever it is: "the hooks work" is one fact about a session.
  if (sub.health.state !== "up") {
    sub.health = { state: "up", since: Date.now() };
    sub.onHealth(sub.health);
  }
  const at = Date.now();
  switch (String(payload.hook_event_name || "")) {
    case "SessionStart":
      // The one payload that hands us the conversation id up front.
      if (payload.session_id) on.identified?.(payload.session_id);
      on.ready({ reread: { logPath: payload.transcript_path } });
      break;
    case "UserPromptSubmit":
      on.started(at, { prompt: payload.prompt });
      break;
    case "Stop":
      // The CLI ASKING to end the turn (`verifyEnds`); the model switch is
      // read either way — a fact about the session, not the turn.
      on.ended(at, { reread: { logPath: payload.transcript_path } });
      break;
    case "SessionEnd":
      on.ready();
      break;
    // Notification (permission_prompt / idle_prompt) stays with the regex
    // prompt path, which also renders the tap buttons.
  }
  return true;
}
