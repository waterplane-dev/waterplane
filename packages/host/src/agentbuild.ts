/**
 * `GET /api/agent/builds?dir=` and `POST /api/agent/builds/run` — an agent runs one of its repo's BUILD BUTTONS,
 * exactly as a tap on the phone would (`BuildManager.run`): same entry, same parameter rules, same refusals.
 *
 * Why it exists: only a button run is collected into `.claude/outbox/` (`artifacts.ts`), recorded and picked up by
 * the auto-download rule — an APK the agent built with `./gradlew` in its own shell stays in `build/` and never
 * reaches the phone (owner, 2026-11-01: "build it and put it on my phone" had no answer short of "tap the button").
 * It grants nothing new: the agent can already run the command itself; this only routes it through the one path
 * whose output reaches a person.
 *
 * Same caller gate as every agent route (`agentCallerRefusal`: loopback, not proxied, not a browser). `key` is
 * required and makes the run once-only (`agent-build-<key>` is the intent id; a retry answers the same run).
 * An entry that is not in the repo's `builds.json` is refused — an agent cannot run a command through this route,
 * only a button the person can see.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BuildConfig, BuildRun } from "@waterplane/shared";
import { BRAND } from "@waterplane/shared";
import { agentCallerRefusal } from "./agentintents.js";

const LIST = "/api/agent/builds";
const RUN = "/api/agent/builds/run";
const KEY_RE = /^[A-Za-z0-9._-]{1,80}$/;

export interface AgentBuildDeps {
  builds: {
    list(repoDir: string): BuildConfig[];
    run(repoDir: string, buildId: string, given?: Record<string, string>, opts?: { origin?: string; id?: string }): BuildRun | { error: string };
  };
  /** The containment gate on a client-named directory (`wsops.ts`); null = refuse. */
  containRepoDir(dir: unknown): Promise<string | null>;
  /** A repo id (from `/api/repos`) → its worktree, or null. */
  repoDir(id: string): Promise<string | null>;
  json(res: ServerResponse, data: unknown, status?: number): void;
  readJson(req: IncomingMessage): Promise<any>;
}

/** The entry as an agent needs it: what to pass, nothing the phone's form state holds. */
export function agentBuildEntry(b: BuildConfig): { id: string; name: string; cmd: string; dir?: string; params?: { id: string; options?: string[]; default?: string }[] } {
  // `optionsCmd` options are read only behind the person's approval (`builds.ts`), so they are not listed here.
  const params = (b.params ?? []).map((p) => ({
    id: p.id,
    ...(p.options?.length ? { options: p.options } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  }));
  return { id: b.id, name: b.name, cmd: b.cmd, ...(b.dir ? { dir: b.dir } : {}), ...(params.length ? { params } : {}) };
}

/** `params` from a body: string values only, everything else dropped (run() refuses what is missing). */
function stringParams(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
  return Object.keys(out).length ? out : undefined;
}

/** `true` when the request was this route's (answered, or refused). */
export async function handleAgentBuilds(req: IncomingMessage, res: ServerResponse, path: string, url: URL, d: AgentBuildDeps): Promise<boolean> {
  if (path !== LIST && path !== RUN) return false;
  const refusal = agentCallerRefusal(req.socket.remoteAddress, req.headers);
  if (refusal) { d.json(res, { ok: false, error: refusal }, 403); return true; }

  const cwdOf = async (repo: unknown, dir: unknown): Promise<string | null | "unknown-repo"> => {
    if (typeof repo === "string" && repo.trim()) {
      const wt = await d.repoDir(repo.trim());
      return wt ? d.containRepoDir(wt) : "unknown-repo";
    }
    return typeof dir === "string" && dir.trim() ? d.containRepoDir(dir.trim()) : null;
  };

  if (path === LIST) {
    if (req.method !== "GET") { d.json(res, { ok: false, error: `GET ${LIST}?dir=<your $PWD> lists the build buttons; POST ${RUN} runs one` }, 405); return true; }
    const cwd = await cwdOf(url.searchParams.get("repo"), url.searchParams.get("dir"));
    if (cwd === "unknown-repo") { d.json(res, { ok: false, error: "unknown repo" }, 404); return true; }
    if (!cwd) { d.json(res, { ok: false, error: 'pass "dir": your $PWD (or "repo": an id from /api/repos)' }, 400); return true; }
    const builds = d.builds.list(cwd).map(agentBuildEntry);
    d.json(res, {
      ok: true,
      builds,
      ...(builds.length ? {} : { note: `This repo has no build buttons yet. Add one to ${BRAND.sharedDirName}/builds.json (it is committed), then run it here.` }),
    });
    return true;
  }

  if (req.method !== "POST") { d.json(res, { ok: false, error: `POST ${RUN} with {"dir","id","key"}` }, 405); return true; }
  const body = await d.readJson(req);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!KEY_RE.test(key)) { d.json(res, { ok: false, error: 'a "key" is required (letters, digits, . _ -, up to 80): it makes the run once-only, so a retried request is the same run' }, 400); return true; }
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) { d.json(res, { ok: false, error: `pass "id": one of the entries GET ${LIST} lists` }, 400); return true; }
  const cwd = await cwdOf(body?.repo, body?.dir);
  if (cwd === "unknown-repo") { d.json(res, { ok: false, error: "unknown repo" }, 404); return true; }
  if (!cwd) { d.json(res, { ok: false, error: 'pass "dir": your $PWD (or "repo": an id from /api/repos)' }, 400); return true; }
  if (!d.builds.list(cwd).some((b) => b.id === id)) {
    d.json(res, { ok: false, error: `no build button "${id}" in this repo — GET ${LIST} lists them; add one to ${BRAND.sharedDirName}/builds.json first` }, 404);
    return true;
  }
  const r = d.builds.run(cwd, id, stringParams(body?.params), { id: `agent-build-${key}` });
  if ("error" in r) { d.json(res, { ok: false, error: r.error }, 400); return true; }
  d.json(res, {
    ok: true,
    runId: r.runId,
    name: r.name,
    note: "Running as if the person had tapped the button: it shows in the phone's Builds sheet, its outputs are copied into .claude/outbox/, and the phone downloads them by itself where auto-download is on.",
  });
  return true;
}
