/**
 * The requirements sheet's state and its ONE writer. Every host answer comes through `client`
 * (`plugin.call` on the one socket — never a second transport); the stores below are written only by
 * the actions here, never by a component.
 *
 *  - `view`      which repo the sheet is on, its cut and search, which item is open. The cut is the TAP
 *                that opened the sheet (a menu line or a chip), never a setting: `closeRequirements` resets it.
 *  - `lists`     the full list per repo, with when it was read (the sheet says how old).
 *  - `summaries` the repo menu line's count per repo; also refreshed by every full read, so the line
 *                and the sheet cannot disagree about one repo.
 */
import type { RepoTarget } from "@waterplane/shared";
import { core, createStore, featureSheetId, pluginClient } from "@waterplane/sdk";
import type { PluginCallResult, Store } from "@waterplane/sdk";
import type { ReqList, ReqMethods, ReqSummary } from "../shared/methods.mts";
import { NO_CUT, type ReqCut } from "./cut.ts";

export const REQ_SHEET = featureSheetId("requirements", "list");
const client = pluginClient<ReqMethods>("requirements");

/** `jump`: `open` was set by `focusItem` (a link to another item), the only time the sheet scrolls to it. */
export interface ReqView { repo: RepoTarget | null; cut: ReqCut; q: string; open: string | null; jump: boolean }
export const EMPTY_VIEW: ReqView = { repo: null, cut: NO_CUT, q: "", open: null, jump: false };
export const view = createStore<ReqView>(EMPTY_VIEW);

export interface Read<T> { at: number; res: PluginCallResult<T> }
export const lists = createStore<ReadonlyMap<string, Read<ReqList>>>(new Map());
export const summaries = createStore<ReadonlyMap<string, Read<ReqSummary>>>(new Map());

const put = <T>(s: Store<ReadonlyMap<string, T>>, id: string, v: T) => s.set((m) => new Map(m).set(id, v));

const SUMMARY_TTL_MS = 5 * 60_000;
const inflight = new Set<string>();

export function openRequirements(repo: RepoTarget, cut: ReqCut = NO_CUT): void {
  view.set({ repo, cut, q: "", open: null, jump: false });
  core().nav.open(REQ_SHEET);
}

export function closeRequirements(): void {
  view.set(EMPTY_VIEW);
  core().nav.close(REQ_SHEET);
}

export async function readList(repo: RepoTarget): Promise<void> {
  const res = await client.read("list", { repo: repo.id });
  const at = Date.now();
  put(lists, repo.id, { at, res });
  if (res.ok) {
    const l = res.result;
    put(summaries, repo.id, { at, res: { ok: true, result: {
      setUp: l.setUp, built: !!l.lastRun, total: l.items.length, requested: l.items.filter((i) => i.status === "requested").length,
    } } });
  }
}

/** The menu line's count. Skipped while in flight, while fresh, and with no link (a read would only queue). */
export async function ensureSummary(repo: RepoTarget): Promise<void> {
  const have = summaries.get().get(repo.id);
  if (inflight.has(repo.id) || (have && Date.now() - have.at < SUMMARY_TTL_MS) || core().conn.status !== "open") return;
  inflight.add(repo.id);
  try {
    put(summaries, repo.id, { at: Date.now(), res: await client.read("summary", { repo: repo.id }) });
  } finally { inflight.delete(repo.id); }
}

/** The one-time set-up: writes two files, spends nothing. */
export async function setUp(repo: RepoTarget): Promise<void> {
  const res = await client.call("setup", { repo: repo.id });
  core().say.toast(res.ok ? res.result.note : `could not set up: ${res.error}`);
  if (res.ok) {
    summaries.set((m) => { const n = new Map(m); n.delete(repo.id); return n; });
    await readList(repo);
  }
}

/**
 * The update, through the backlog: the host adds a row that WAITS for a tap (the run spends model
 * money and the person has not read the brief yet). This never fires anything. Used by the sheet's
 * button and by the setup row's hand-to-agent button (`SetupRowDef.agent`).
 */
export async function handUpdate(repo: RepoTarget, c = core()): Promise<void> {
  const res = await client.call("update", { repo: repo.id });
  if (!res.ok) { c.say.toast(`the update was not handed over: ${res.error}`); return; }
  const { intentId: id, existing } = res.result;
  const row = c.world.backlog.find((b) => b.id === id);
  c.say.toast(existing
    ? "already waiting in the backlog"
    : !row || row.status === "queued"
      ? `handed to ${repo.repoName}'s agent — waiting in the backlog for your tap`
      : `handed over — ${row.status}`);
  c.nav.openBacklogCut(repo.worktreePath, [id], "the requirements update");
}

/** Jump to another item (a `superseded-by`): outside the cut, the cut and the search go — it must be seen. */
export function focusItem(id: string, inCut: boolean): void {
  view.set((v) => ({ ...v, cut: inCut ? v.cut : NO_CUT, q: inCut ? v.q : "", open: id, jump: true }));
}
