/**
 * The requirements extension's host half: the setup row and its set-up fix, and the methods the
 * requirements sheet calls (`shared/methods.mts`). Contributed through the same `HostPluginApi` an
 * external plugin gets. The row's words are `requirements.mts`'s, unchanged by the move out of core
 * (`packages/host/test/requirementsrow.test.mjs`).
 *
 * `update` spends model money, so it never fires: it adds a backlog row that waits for a tap.
 */
import { existsSync } from "node:fs";
import type { HostPluginApi, PluginRepoScope } from "@waterplane/shared";
import { handleAll } from "@waterplane/shared";
import type { ReqMethods } from "../shared/methods.mjs";
import { updateBrief, updateKeyNth } from "../shared/methods.mjs";
import { listOf, summaryOf } from "./list.mjs";
import { UPDATE_CMD, UPDATE_SCRIPT, isSetUp, readState, requirementsCheck, scaffoldRequirements } from "./requirements.mjs";

/** Intent states that are settled for good. */
const OVER = new Set(["done", "failed", "canceled", "cancelled", "dropped", "dismissed"]);

const setUpRepo = (worktree: string) => {
  const wrote = scaffoldRequirements(worktree);
  return wrote.length
    ? { applied: true, note: `wrote ${wrote.join(", ")}` }
    : { applied: false, note: "requirements preset and index already present — left as they are" };
};

export function activate(api: HostPluginApi): void {
  api.setupCheck(({ worktree }) => requirementsCheck(worktree));
  api.setupFix("requirements", ({ worktree }) => setUpRepo(worktree));

  // Args arrive unchecked from the wire: every method names its repo or says it was not told one.
  const scope = async (a: unknown): Promise<PluginRepoScope> => {
    const id = (a as { repo?: unknown } | null)?.repo;
    if (typeof id !== "string" || !id) throw new Error("which repo? the call named none");
    const s = await api.repo(id);
    if (!s) throw new Error(`no repo "${id}" under this host's root`);
    return s;
  };

  handleAll<ReqMethods>(api, {
    summary: async (a) => summaryOf(await scope(a)),
    list: async (a) => listOf(await scope(a)),
    setup: async (a) => setUpRepo((await scope(a)).worktree),
    update: async (a) => {
      const s = await scope(a);
      const wt = s.worktree;
      if (!isSetUp(wt)) throw new Error(`the requirements list is not set up in ${s.name} — set it up first (two files, no model call)`);
      if (!existsSync(UPDATE_SCRIPT)) throw new Error(requirementsCheck(wt)?.detail ?? `cannot find the build script at ${UPDATE_SCRIPT}`);
      const brief = updateBrief({ repoName: s.name, detail: requirementsCheck(wt)?.detail ?? "", cmd: UPDATE_CMD });
      const lastRun = readState(wt)?.lastRun ?? null;
      // One waiting update per build state. If the agent's run never wrote `.state.json`, the state never
      // moves — so a row that is OVER (done/failed/dropped) must not answer every later tap: the next
      // key (`.1`, `.2`, …) makes a new item. A row still waiting is the answer (`existing`).
      for (let n = 0; n < 50; n++) {
        const r = await api.handToAgent(s.id, brief, { key: updateKeyNth(s.id, lastRun, n), label: "update the requirements list" }); // no fire: it waits for a tap
        if (!r.ok) throw new Error(r.reason);
        if (r.existing && r.state && OVER.has(r.state)) continue;
        return { intentId: r.intentId, existing: r.existing === true };
      }
      throw new Error("fifty finished updates are already filed for this build — look at them in the backlog first");
    },
  });
}
