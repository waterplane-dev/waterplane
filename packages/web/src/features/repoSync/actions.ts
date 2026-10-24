/**
 * Pull, push or sync every repo, from one tap. The same host calls the git
 * view makes per repo (`gitPull`, `gitPush` + `gitPushState`) — this only
 * walks them over a list:
 *
 * - pulls run a few at a time: seconds each, no hook;
 * - pushes run ONE at a time: each runs the repo's pre-push checks (build,
 *   lint, tests) on this desktop, and several at once fight for it;
 * - sync is the git view's: pull, then push whatever the fresh status still
 *   has ahead.
 *
 * Stop lets what is running finish and drops what is still waiting.
 */
import type { GitPushState, RepoTarget } from "@waterplane/shared";
import { api } from "../../api";
import { core } from "../../sdk";
import { doneToast, targets, type RowState, type SyncVerb } from "./logic";
import { run } from "./store";

const PULL_AT_ONCE = 3;
const PUSH_POLL_MS = 3000;

let stopped = false;

function setRow(id: string, st: RowState): void {
  const cur = run.get();
  run.set({ ...cur, rows: { ...cur.rows, [id]: st } });
}

async function pullOne(id: string): Promise<boolean> {
  setRow(id, { s: "pulling" });
  try {
    const r = await api.gitPull(id);
    setRow(id, r.ok ? { s: "ok", text: r.output ?? "Pulled." } : { s: "failed", text: r.error ?? "The pull failed." });
    return r.ok;
  } catch (e) {
    setRow(id, { s: "failed", text: `The pull did not run: ${(e as Error).message}` });
    return false;
  }
}

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Start (or join) the desktop's push job and follow it to its end. */
async function pushOne(id: string, pulled?: string): Promise<void> {
  const before = pulled ? `${pulled} ` : "";
  let p: GitPushState | null;
  try { p = await api.gitPush(id); } catch (e) {
    setRow(id, { s: "failed", text: `${before}The push did not start: ${(e as Error).message}` });
    return;
  }
  const startedAt = p.startedAt;
  setRow(id, { s: "pushing", startedAt });
  for (;;) {
    if (p && p.startedAt === startedAt && p.result) break;
    await wait(PUSH_POLL_MS);
    try { p = await api.gitPushState(id); } catch { continue; /* a missed ask; the push carries on */ }
    if (!p || p.startedAt !== startedAt) {
      setRow(id, { s: "failed", text: `${before}The push's record is gone — the desktop restarted or another push replaced it. Open git to see where it stands.` });
      return;
    }
  }
  const r = p.result!;
  setRow(id, r.ok
    ? { s: "ok", text: `${before}Pushed: ${r.output?.split("\n").slice(-1)[0] || "ok"}` }
    : { s: "failed", text: `${before}Push failed. ${r.error ?? ""}`.trim() });
}

/** Ahead count off a FRESH status — the one on screen predates the pull's fetch. */
async function aheadNow(id: string): Promise<number | null> {
  try { return (await api.gitStatus(id)).ahead; } catch { return null; }
}

export function stopRun(): void {
  stopped = true;
  const cur = run.get();
  const rows = { ...cur.rows };
  for (const [id, st] of Object.entries(rows)) if (st.s === "waiting") rows[id] = { s: "skipped", text: "Stopped before it ran." };
  run.set({ ...cur, rows });
}

export async function startRun(verb: SyncVerb, repos: readonly RepoTarget[]): Promise<void> {
  if (run.get().active) return;
  const c = core();
  const list = targets(repos, verb);
  if (list.length === 0) return;
  c.say.track(`action:git.all.${verb}`);
  stopped = false;
  run.set({ verb, active: true, rows: Object.fromEntries(list.map((r) => [r.id, { s: "waiting" } as RowState])) });

  // Pushes are a chain: one at a time, in the order repos become ready.
  let pushes: Promise<void> = Promise.resolve();
  const enqueuePush = (id: string, pulled?: string) => {
    pushes = pushes.then(() => (stopped ? undefined : pushOne(id, pulled)));
  };

  if (verb === "push") {
    for (const r of list) enqueuePush(r.id);
  } else {
    const todo = [...list];
    const worker = async () => {
      for (let r = todo.shift(); r && !stopped; r = todo.shift()) {
        const ok = await pullOne(r.id);
        if (!ok || verb === "pull") continue;
        const ahead = await aheadNow(r.id);
        const st = run.get().rows[r.id];
        const pulled = st?.s === "ok" ? st.text : undefined;
        if (ahead && ahead > 0) { setRow(r.id, { s: "waiting" }); enqueuePush(r.id, pulled); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PULL_AT_ONCE, list.length) }, worker));
  }
  await pushes;
  if (stopped) stopRun(); // rows the stop found still waiting
  const final = run.get();
  run.set({ ...final, active: false });
  c.world.refreshRepos();
  c.say.toast(doneToast(Object.values(final.rows)));
}
