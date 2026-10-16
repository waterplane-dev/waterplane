/**
 * `POST /api/agent/followup` — an agent flags ITS OWN session for follow up
 * with a one-line reason (R-sessions-044). It can set the flag and never clear
 * it: there is no DELETE, and an empty reason is refused, so the only way a
 * flag goes away stays a person's tap.
 *
 * Same caller gate as `agentintents.ts` (`agentCallerRefusal`): loopback, not
 * proxied, not a browser. The session is named by `session`, or found from the
 * agent's `$PWD` (`resolveFollowUpSession`, pure, pinned without a daemon).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sep } from "node:path";
import { clipFollowUpText, type FollowUp, type SessionInfo } from "@waterplane/shared";
import { agentCallerRefusal } from "./agentintents.js";
import { realResolve } from "./paths.js";

const PATH = "/api/agent/followup";

/** The slice of a session this decision reads. */
export type FollowUpCandidate = Pick<SessionInfo, "id" | "cwd" | "title" | "running" | "idle" | "turnActive">;

export type FollowUpResolution = { ok: true; id: string } | { ok: false; status: number; error: string };

const midTurn = (s: FollowUpCandidate): boolean => s.turnActive ?? (s.idle === false);
const label = (s: FollowUpCandidate): string => `${s.id} (${s.title || "untitled"})`;

/**
 * Which live session is the caller. `session` wins when it names a live one;
 * otherwise `dir` is matched against session cwds (the longest cwd that is
 * `dir` or a parent of it), and among those exactly one mid-turn, or exactly
 * one at all, is the answer. Anything else is a refusal that lists the
 * candidates so the agent can retry with `session`. `real` compares paths
 * (injected so a test needs no disk).
 */
export function resolveFollowUpSession(
  sessions: readonly FollowUpCandidate[],
  q: { session?: unknown; dir?: unknown },
  real: (p: string) => string = realResolve,
): FollowUpResolution {
  const live = sessions.filter((s) => s.running);
  const sid = typeof q.session === "string" ? q.session.trim() : "";
  const dir = typeof q.dir === "string" ? q.dir.trim() : "";
  if (sid) {
    const hit = live.find((s) => s.id === sid);
    if (hit) return { ok: true, id: hit.id };
    if (!dir) return { ok: false, status: 404, error: `no live session "${sid}" — pass "dir": "$PWD" to find yours by folder` };
  }
  if (!dir) return { ok: false, status: 400, error: 'say which session: "session": "<id>" or "dir": "$PWD"' };
  const here = real(dir);
  const within = live
    .map((s) => ({ s, cwd: real(s.cwd) }))
    .filter(({ cwd }) => here === cwd || here.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep));
  if (!within.length) return { ok: false, status: 404, error: `no live session runs in ${dir} — nothing was flagged` };
  const longest = Math.max(...within.map((x) => x.cwd.length));
  const cands = within.filter((x) => x.cwd.length === longest).map((x) => x.s);
  if (cands.length === 1) return { ok: true, id: cands[0].id };
  const busy = cands.filter(midTurn);
  if (busy.length === 1) return { ok: true, id: busy[0].id };
  return {
    ok: false,
    status: 409,
    error: `${cands.length} sessions run in that folder${busy.length > 1 ? ` and ${busy.length} are mid-turn` : " and none is mid-turn"}, so I cannot tell which is yours: ${cands.map(label).join(", ")} — retry with "session": "<id>"`,
  };
}

export interface AgentFollowUpDeps {
  sessions: { list(): SessionInfo[]; setFollowUp(id: string, f: FollowUp | null): boolean };
  json(res: ServerResponse, data: unknown, status?: number): void;
  readJson(req: IncomingMessage): Promise<any>;
  now?: () => number;
}

/** `true` when the request was this route's (answered, or refused). */
export async function handleAgentFollowUp(req: IncomingMessage, res: ServerResponse, path: string, d: AgentFollowUpDeps): Promise<boolean> {
  if (path !== PATH) return false;
  const refusal = agentCallerRefusal(req.socket.remoteAddress, req.headers);
  if (refusal) { d.json(res, { ok: false, error: refusal }, 403); return true; }
  if (req.method !== "POST") { d.json(res, { ok: false, error: `POST ${PATH} sets the flag; only the person can clear it` }, 405); return true; }
  const body = await d.readJson(req);
  const reason = clipFollowUpText(body?.reason);
  if (!reason) { d.json(res, { ok: false, error: 'a one-line "reason" is required — say what the person should read' }, 400); return true; }
  const r = resolveFollowUpSession(d.sessions.list(), { session: body?.session, dir: body?.dir });
  if (!r.ok) { d.json(res, { ok: false, error: r.error }, r.status); return true; }
  const followUp: FollowUp = { by: "agent", at: (d.now ?? Date.now)(), reason };
  d.sessions.setFollowUp(r.id, followUp);
  d.json(res, { ok: true, session: r.id, followUp });
  return true;
}
