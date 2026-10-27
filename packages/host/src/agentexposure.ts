/**
 * `GET /api/agent/exposure?dir=` and `POST /api/agent/exposure/triage` — an agent reads the exposure / crash
 * findings of the repo it works in and marks one seen, investigating or fixed (`exposure.ts` `setExposureTriage`).
 *
 * Same caller gate as `agentfollowup.ts` (`agentCallerRefusal`): loopback, not proxied, not a browser. The GET
 * changes nothing (OPEN findings by default, `?all=1` adds accepted / fixed ones and stale marks). An agent can mark, never clear: removing a mark stays a person's tap (403 with a sentence).
 * `dir` is matched by realpath to a stored series (`seriesFor`); the session is `session` or resolved from `dir`
 * like the follow-up route, and a POST with no resolving session is refused (same status and sentence).
 */
import { basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionInfo } from "@waterplane/shared";
import { agentCallerRefusal } from "./agentintents.js";
import { resolveFollowUpSession } from "./agentfollowup.js";
import { exposureFindingsFor, setExposureTriage } from "./exposure.js";

const GET_PATH = "/api/agent/exposure";
const POST_PATH = "/api/agent/exposure/triage";

export interface AgentExposureDeps {
  sessions: { list(): SessionInfo[] };
  /** Re-run the repo's checklist after a write so the badge moves. Optional: tests omit it. */
  refresh?(dir: string): void | Promise<void>;
  json(res: ServerResponse, data: unknown, status?: number): void;
  readJson(req: IncomingMessage): Promise<any>;
}

/** `true` when the request was this route's (answered, or refused). */
export async function handleAgentExposure(req: IncomingMessage, res: ServerResponse, path: string, url: URL, d: AgentExposureDeps): Promise<boolean> {
  if (path !== GET_PATH && path !== POST_PATH) return false;
  const refusal = agentCallerRefusal(req.socket.remoteAddress, req.headers);
  if (refusal) { d.json(res, { ok: false, error: refusal }, 403); return true; }
  if (path === GET_PATH) {
    if (req.method !== "GET") { d.json(res, { ok: false, error: `GET ${GET_PATH}?dir=<abs path> lists findings; POST ${POST_PATH} marks one` }, 405); return true; }
    const dir = (url.searchParams.get("dir") ?? "").trim();
    if (!dir) { d.json(res, { ok: false, error: 'pass "dir": your $PWD' }, 400); return true; }
    const all = ["1", "true"].includes((url.searchParams.get("all") ?? "").toLowerCase());
    const r = exposureFindingsFor(dir, { all });
    if (!r) { d.json(res, { ok: true, repo: null, findings: [], note: "No exposure watch reading is stored for that folder, so there are no findings to list." }); return true; }
    d.json(res, { ok: true, ...r });
    return true;
  }
  if (req.method !== "POST") { d.json(res, { ok: false, error: `POST ${POST_PATH} marks a finding` }, 405); return true; }
  const body = await d.readJson(req);
  if (body?.clear) { d.json(res, { ok: false, error: "an agent can mark a finding seen, investigating or fixed but cannot clear a mark; only the person can, from the phone" }, 403); return true; }
  const dir = typeof body?.dir === "string" ? body.dir.trim() : "";
  if (!dir) { d.json(res, { ok: false, error: 'pass "dir": your $PWD' }, 400); return true; }
  if (typeof body?.triageId !== "string" || !body.triageId.trim()) { d.json(res, { ok: false, error: 'pass "triageId" from GET /api/agent/exposure' }, 400); return true; }
  const found = exposureFindingsFor(dir);
  if (!found) { d.json(res, { ok: false, error: "No exposure watch reading is stored for that folder." }, 404); return true; }
  // A mark is attributed to a session that exists: with none resolving, refuse as the follow-up route does.
  const sessions = d.sessions.list();
  const sess = resolveFollowUpSession(sessions, { session: body?.session, dir });
  if (!sess.ok) { d.json(res, { ok: false, error: sess.error }, sess.status); return true; }
  const me = sessions.find((x) => x.id === sess.id);
  // The repo is the session's folder (a linked worktree's main checkout), never its title: a backlog row's title starts "backlog · …".
  const repo = me?.cwd ? basename(me.cwd.split("/.claude/worktrees/")[0]) || undefined : undefined;
  const by = { kind: "agent" as const, ...(repo ? { repo } : {}), session: sess.id };
  const r = setExposureTriage(dir, { id: body.triageId, state: body.state, fixedIn: body.fixedIn, commit: body.commit, note: body.note }, by);
  if (!r.ok) { d.json(res, { ok: false, error: r.error }, 400); return true; }
  try { await d.refresh?.(found.dir); } catch { /* the mark is saved; the next sweep moves the badge */ }
  d.json(res, { ok: true, triageId: body.triageId });
  return true;
}
