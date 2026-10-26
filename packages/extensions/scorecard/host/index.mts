/**
 * The scorecard extension's host half: reads the public OpenSSF Scorecard for a repo's GitHub
 * remote (`shared/wire.mts`) over the engine (`engine.mts`). No credential, no model call, no
 * poller — a read happens when the phone or the setup checklist asks. Contributed through the same
 * `HostPluginApi` an external plugin gets.
 */
import { handleAll, type HostPluginApi, type PluginRepoScope } from "@waterplane/shared";
import { PUSH_CHANGED, type ScorecardMethods } from "../shared/wire.mjs";
import { createEngine, type Engine, type Roots } from "./engine.mjs";

export { createEngine } from "./engine.mjs";
export type { Roots } from "./engine.mjs";

type Api = Pick<HostPluginApi, "handle" | "repo">;

/** Wire an engine to `api`'s methods. Exported so the tests drive the real handlers. */
export function serve(api: Api, engine: Engine): () => void {
  // Args arrive unchecked from the wire: every method names its repo or says it was not told one.
  const scope = async (a: unknown): Promise<PluginRepoScope> => {
    const id = (a as { repo?: unknown } | null)?.repo;
    if (typeof id !== "string" || !id) throw new Error("which repo? the call named none");
    const s = await api.repo(id);
    if (!s) throw new Error(`no repo "${id}" under this host's root`);
    return s;
  };
  const arg = (a: unknown, k: string): unknown => (a as Record<string, unknown> | null)?.[k];
  return handleAll<ScorecardMethods>(api, {
    read: async (a) => engine.read(await scope(a)),
    refresh: async (a) => engine.refresh(await scope(a)),
    accept: async (a) => engine.accept(await scope(a), arg(a, "check"), arg(a, "reason")),
    unaccept: async (a) => engine.unaccept(await scope(a), arg(a, "check")),
    scoredAs: async (a) => engine.scoredAs(await scope(a), arg(a, "slug")),
    remedy: async (a) => engine.remedy(await scope(a), arg(a, "check")),
  });
}

let off: Array<() => void> = [];

export function activate(api: HostPluginApi): void {
  const roots: Roots = { stateDir: api.stateDir, fetch: globalThis.fetch, now: () => Date.now() };
  const engine = createEngine(roots, {
    push: (d) => { api.push(PUSH_CHANGED, d); },
    handToAgent: (id, prompt, o) => api.handToAgent(id, prompt, o), // no `fire`: it waits for a tap
  });
  off = [api.setupCheck(({ worktree }) => engine.row(worktree)), serve(api, engine)];
}

export function deactivate(): void {
  for (const f of off) f();
  off = [];
}
