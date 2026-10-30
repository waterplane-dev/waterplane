/**
 * The scorecard sheet's state and its ONE writer. Every host answer comes through `client`
 * (`plugin.call` on the one socket). `views` holds the last ScoreView per repo id (the chip and the
 * sheet read the same one, so they cannot disagree); `sheet` is which repo is open, its cut and the
 * last error as text. The host's one push, `changed`, means "read that repo again".
 */
import type { RepoTarget } from "@waterplane/shared";
import { core, createStore, featureSheetId, openExternal, pluginClient, type LeaveReason, type PluginCallResult } from "@waterplane/sdk";
import type { ScoreView, ScorecardMethods } from "../shared/wire.mts";
import { latest, leaveResets, remedyOutcome } from "./latest.ts";
import { remedyWords, type ScoreCut } from "./logic.ts";

export const SCORE_SHEET = featureSheetId("scorecard", "main");
const client = pluginClient<ScorecardMethods>("scorecard");

export interface Read { at: number; view: ScoreView }
export const views = createStore<ReadonlyMap<string, Read>>(new Map());

export interface SheetState { repo: RepoTarget | null; cut: ScoreCut | null; err: string | null; busy: boolean }
const EMPTY: SheetState = { repo: null, cut: null, err: null, busy: false };
export const sheet = createStore<SheetState>(EMPTY);

/** The one remedy call that may still open the backlog: a later call or leaving the sheet makes a pending reply stale. */
const remedyToken = latest();

const CHIP_TTL_MS = 5 * 60_000;
const inflight = new Set<string>();

const keep = (repo: string, view: ScoreView) => views.set((m) => new Map(m).set(repo, { at: Date.now(), view }));

/** For the chip: skipped while in flight, while fresh, and with no link (a read would only queue). */
export async function ensureRead(repo: RepoTarget): Promise<void> {
  const have = views.get().get(repo.id);
  if (inflight.has(repo.id) || (have && Date.now() - have.at < CHIP_TTL_MS) || core().conn.status !== "open") return;
  inflight.add(repo.id);
  try {
    const res = await client.read("read", { repo: repo.id });
    if (res.ok) keep(repo.id, res.result);
  } finally { inflight.delete(repo.id); }
}

const fail = (res: { ok: false; error: string }) => sheet.set((s) => ({ ...s, err: res.error, busy: false }));

/** Run one call that answers a view; its error becomes text on the sheet. */
async function act(run: () => Promise<PluginCallResult<ScoreView>>, repo: string): Promise<boolean> {
  sheet.set((s) => ({ ...s, busy: true, err: null }));
  const res = await run();
  if (!res.ok) { fail(res); return false; }
  keep(repo, res.result);
  sheet.set((s) => ({ ...s, busy: false }));
  return true;
}

export const refresh = (repo: string) => act(() => client.call("refresh", { repo }), repo);
export const accept = (repo: string, check: string, reason: string) => act(() => client.call("accept", { repo, check, reason }), repo);
export const unaccept = (repo: string, check: string) => act(() => client.call("unaccept", { repo, check }), repo);
export const scoredAs = (repo: string, slug: string | null) => act(() => client.call("scoredAs", { repo, slug }), repo);

/** Ask Claude: the host files the remedy prompt in the backlog, waiting for a tap — and the backlog opens on that row. */
export async function remedy(repo: string, check: string): Promise<void> {
  sheet.set((s) => ({ ...s, err: null }));
  const token = remedyToken.begin();
  const name = sheet.get().repo?.repoName ?? repo;
  const res = await client.call("remedy", { repo, check });
  const out = remedyOutcome(remedyToken.current(token), res.ok ? { ok: true, text: remedyWords(check, res.result) } : res, name, check);
  if (out.sheetErr !== null) fail({ ok: false, error: out.sheetErr });
  if (out.toast !== null) core().say.toast(out.toast);
  // Only a current reply navigates, and only if the sheet still shows that repo.
  const open = sheet.get().repo;
  if (out.navigate && res.ok && open?.id === repo) core().nav.openBacklogCut(open.worktreePath, [res.result.intentId], `Scorecard: ${check}`);
}

export function openScorecard(repo: RepoTarget, cut: ScoreCut | null = null): void {
  remedyToken.invalidate();
  sheet.set({ repo, cut, err: null, busy: false });
  core().nav.open(SCORE_SHEET);
  void client.read("read", { repo: repo.id }).then((res) => { if (res.ok) keep(repo.id, res.result); else fail(res); });
}

export const clearCut = () => sheet.set((s) => ({ ...s, cut: null }));
/**
 * The sheet's `onLeave`, told by the route whether it was CLOSED or COVERED (`leaveResets`). Both make a
 * pending remedy reply stale; a cover keeps the state (its repo, re-reading on `changed`, a read error
 * for Back), and a close — ×, Back, an unwind past it — resets it, so `changed` stops re-reading a repo
 * nobody has open.
 */
export const leaveScorecard = (reason?: LeaveReason) => {
  remedyToken.invalidate();
  if (leaveResets(reason)) sheet.set(EMPTY);
};
/** The sheet's ×: one close; the reset arrives through `onLeave("close")`, the one place it happens. */
export const closeScorecard = () => { core().nav.close(SCORE_SHEET); };
export function openLink(url: string): void {
  if (!openExternal(url)) core().say.toast(`could not open ${url} — the browser blocked it`);
}

/**
 * Typed words, kept OUTSIDE the components: an accept reason per repo+check and the scored-as field per
 * repo. A row that remounts (the cut and the sections draw lists at different tree positions) must not
 * delete them. `text` absent = never edited (the field shows the view's own value).
 */
export interface Draft { open: boolean; text: string }
export const drafts = createStore<ReadonlyMap<string, Draft>>(new Map());
export const setDraft = (key: string, d: Draft) => drafts.set((m) => new Map(m).set(key, d));
export const dropDraft = (key: string) => drafts.set((m) => { const n = new Map(m); n.delete(key); return n; });

/** The host's `changed` push `{ at, slug }`: read the open sheet's repo again, and mark stale only the views of that slug (a chip then re-reads: its effect depends on the stamp). */
export function onChanged(data?: unknown): void {
  const slug = typeof (data as { slug?: unknown } | null)?.slug === "string" ? (data as { slug: string }).slug : null;
  const r = sheet.get().repo;
  if (r) void client.read("read", { repo: r.id }).then((res) => { if (res.ok) keep(r.id, res.result); });
  views.set((m) => new Map([...m].map(([k, v]) => [k, slug === null || v.view.slug === slug ? { ...v, at: 0 } : v])));
}
