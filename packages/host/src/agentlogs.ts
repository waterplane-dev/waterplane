/**
 * The listing of a conversation's agent logs, apart from `agents.ts` because the VS Code extension bundles it:
 * `agents.ts` reaches `./proc.js` and `node:child_process`, and an extension that says "nothing spawned" must not ship
 * a process launcher (`packages/vscode/src/shims/agentmeta.ts`). This file imports only `node:fs` and `node:path`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** A dynamic workflow's directory under `subagents/workflows/`. */
export const WORKFLOW_DIR_RE = /^wf_[A-Za-z0-9_-]+$/;

/**
 * Every agent log under a conversation's `subagents/`, as paths relative to it:
 * `agent-<id>.jsonl` for the Task tool's, `workflows/<wf_…>/agent-<id>.jsonl` for
 * a dynamic workflow's. The ONE listing for whoever totals them: a reader that
 * lists `subagents/` alone showed 2 agents and 9.9M on a session whose workflows
 * had run 81 more and spent 204M, and the sum looked complete.
 *
 * Throws what `readdirSync` threw on `dir`, and on `workflows/` for anything but
 * a missing directory: a total that left a workflow out because its directory
 * could not be read is the wrong number the caller must not publish.
 */
export function agentLogs(dir: string): string[] {
  const isLog = (n: string) => n.startsWith("agent-") && n.endsWith(".jsonl");
  const out = readdirSync(dir).filter(isLog);
  const root = join(dir, "workflows");
  let wfs: string[];
  try { wfs = readdirSync(root).filter((n) => WORKFLOW_DIR_RE.test(n)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  for (const wf of wfs) {
    let names: string[];
    try { names = readdirSync(join(root, wf)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // removed between the two reads
      throw e;
    }
    for (const n of names) if (isLog(n)) out.push(`workflows/${wf}/${n}`);
  }
  return out;
}

/** The agent id in one of `agentLogs`' paths: the file name IS the id. */
export function agentLogId(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1).slice("agent-".length, -".jsonl".length);
}

/** The `wf_…` one of `agentLogs`' paths sits under; undefined for a Task agent's. */
export function agentLogWorkflow(rel: string): string | undefined {
  return rel.startsWith("workflows/") ? rel.split("/")[1] : undefined;
}
