/**
 * The links sheet's words and cuts, pure so `logic.test.mjs` reads them straight off the TypeScript.
 *
 * A count is a filter: `inRepo` is the ONE cut the repo chip counts with and the sheet lists with.
 */
import type { FoundLink, LinkEnv, LinksState, PinnedView, Probe } from "../shared/wire.mts";

export type RepoCut = { repo: string } | null;

export const inRepo = <T extends { repo: string | null }>(rows: readonly T[], cut: RepoCut): T[] =>
  cut ? rows.filter((r) => r.repo === cut.repo) : [...rows];

/** Rows grouped by repo, repo-less last, groups in name order, rows in their own order. */
export function byRepo<T extends { repo: string | null }>(rows: readonly T[]): [string | null, T[]][] {
  const m = new Map<string | null, T[]>();
  for (const r of rows) { const l = m.get(r.repo) ?? []; l.push(r); m.set(r.repo, l); }
  return [...m].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : a[0].localeCompare(b[0])));
}

export const repoTitle = (repo: string | null) => repo ?? "no repo";

/** Where a row runs: a port on this desktop, or an address somewhere else (cloud, typed by hand). */
export type Where = "here" | "hosted";
export const WHERES: readonly Where[] = ["here", "hosted"];
export const whereWord: Record<Where, string> = { here: "this desktop", hosted: "hosted" };
export const whereOf = (r: { port?: number }): Where => (r.port != null ? "here" : "hosted");

/** A pin's last check. Found rows are never checked, so they have no health. */
export type Health = "up" | "down" | "unchecked";
export const HEALTHS: readonly Health[] = ["up", "down", "unchecked"];
export const healthWord: Record<Health, string> = { up: "up", down: "down", unchecked: "not checked" };
export const healthOf = (p: { probe?: Probe | null }): Health => (p.probe ? p.probe.state : "unchecked");

/** The chip filters. null = that facet does not cut. */
export interface Facets { env: LinkEnv | null; where: Where | null; health: Health | null }
export const NO_FACETS: Facets = { env: null, where: null, health: null };
export const facetsOn = (f: Facets) => [f.env, f.where, f.health].filter((x) => x != null).length;

type FacetRow = { env: LinkEnv; port?: number; probe?: Probe | null };

/**
 * THE facet cut — what the list shows and what every chip counts (a chip's number is
 * `facetCut(rows, { ...f, [facet]: key }).length`, never a second copy of the rule).
 * `health` cuts pins only: a found row has never been checked, so `checked: false` skips it.
 */
export function facetCut<T extends FacetRow>(rows: readonly T[], f: Facets, checked = true): T[] {
  return rows.filter((r) => (f.env == null || r.env === f.env)
    && (f.where == null || whereOf(r) === f.where)
    && (!checked || f.health == null || healthOf(r) === f.health));
}

/** What the list is grouped by. */
export type GroupBy = "repo" | "env" | "where";
export const GROUP_BYS: readonly GroupBy[] = ["repo", "env", "where"];
export const groupByWord: Record<GroupBy, string> = { repo: "repo", env: "env", where: "where" };

const ENV_ORDER: Record<LinkEnv, number> = { prod: 0, staging: 1, dev: 2 };

/** Rows grouped by `by`: repos by name (repo-less last), envs prod → dev, this desktop first. Keys are stable per `by`. */
export function groupRows<T extends { repo: string | null } & FacetRow>(rows: readonly T[], by: GroupBy): { key: string; title: string; rows: T[] }[] {
  if (by === "repo") return byRepo(rows).map(([r, l]) => ({ key: `repo:${r ?? "~"}`, title: repoTitle(r), rows: l }));
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = by === "env" ? r.env : whereOf(r); const l = m.get(k) ?? []; l.push(r); m.set(k, l); }
  const rank = (k: string) => (by === "env" ? ENV_ORDER[k as LinkEnv] : WHERES.indexOf(k as Where));
  return [...m].sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([k, l]) => ({ key: `${by}:${k}`, title: by === "env" ? k : whereWord[k as Where], rows: l }));
}

/** A group header's tally: "13 · 2 down" — down pins named, since that is what a glance is for. */
export function groupTally(rows: readonly object[], pins: boolean): string {
  const down = pins ? rows.filter((r) => healthOf(r as { probe?: Probe | null }) === "down").length : 0;
  return down > 0 ? `${rows.length} · ${down} down` : `${rows.length}`;
}

/** An address as a row prints it: no scheme, no www, no closing slash. Search still reads the whole URL. */
export function shortUrl(u: string): string {
  return u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/** The one env every row shares, so a group's header can say it once; null when they differ. */
export function sharedEnv(rows: readonly { env: LinkEnv }[]): LinkEnv | null {
  const e = rows[0]?.env ?? null;
  return e && rows.every((r) => r.env === e) ? e : null;
}

export function probeWords(p: Probe | null, ago: (ts: number) => string): { tone: "ok" | "bad" | "dim"; text: string } {
  if (!p) return { tone: "dim", text: "not checked yet" };
  if (p.state === "up") {
    const st = p.status && p.status !== 200 ? ` (${p.status}${p.status === 401 || p.status === 403 ? ", sign-in" : p.status >= 300 && p.status < 400 ? ", redirect" : ""})` : "";
    return { tone: "ok", text: `up${st} · ${p.ms ?? "?"} ms · ${ago(p.at)}` };
  }
  return { tone: "bad", text: `down — ${p.error ?? `HTTP ${p.status}`} · ${ago(p.at)}` };
}

/** Under a local pin: whether anything listens, before the probe has said more. */
export function localWords(p: PinnedView): string | null {
  if (p.port == null) return null;
  if (p.listening === false) return `nothing listens on :${p.port} right now`;
  return `:${p.port} on this desktop`;
}

export const kindWord: Record<FoundLink["kind"], string> = {
  local: "running here", cloudrun: "Cloud Run", function: "Cloud Function", firebase: "Firebase Hosting",
};

export interface FoundCut { shown: FoundLink[]; hidden: number; total: number }

/** The found list under the repo cut, without what is pinned already; hidden rows kept out unless asked. */
export function foundCut(s: LinksState, cut: RepoCut, showHidden: boolean): FoundCut {
  const pinnedFrom = new Set(s.pinned.map((p) => p.from).filter(Boolean));
  const all = inRepo(s.found, cut).filter((f) => !pinnedFrom.has(f.key));
  const shown = showHidden ? all : all.filter((f) => !f.hidden);
  return { shown, hidden: all.length - shown.length, total: all.length };
}

/** The line under the head: what was looked at and when, and what is being looked at now. */
export function discoveryLine(s: LinksState, ago: (ts: number) => string): string {
  const part = (what: string, at: number | null, running: boolean) =>
    running ? `${what}: looking now…` : at == null ? `${what}: not looked yet` : `${what}: ${ago(at)}`;
  return `${part("this desktop", s.localAt, s.discovering.local)} · ${part("cloud", s.cloudAt, s.discovering.cloud)}`;
}

/** The words a row is found by: name, address, repo, env, project, process, port, kind. */
function hay(r: { label: string; repo: string | null; env: string; url?: string | null; openUrl?: string | null; project?: string; proc?: string; port?: number; kind?: FoundLink["kind"] }): string {
  return [r.label, r.repo, r.env, r.url, r.openUrl, r.project, r.proc, r.port == null ? null : `:${r.port}`, r.kind ? kindWord[r.kind] : null]
    .filter(Boolean).join(" ").toLowerCase();
}

/** The search box's cut: every word typed must appear somewhere in the row. Blank = every row. */
export function matching<T extends Parameters<typeof hay>[0]>(rows: readonly T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? rows.filter((r) => { const h = hay(r); return words.every((w) => h.includes(w)); }) : [...rows];
}

export const chipTitle = (n: number) => `${n} pinned link${n === 1 ? "" : "s"} for this repo`;

/**
 * A repo's chip: its pins, or — with none pinned — what was found for it and not hidden, so a repo
 * nobody has pinned anything for still points at the sheet. The count is what the sheet, opened cut
 * to the repo (no search, no chips, hidden rows hidden), lists: `inRepo` and `foundCut`, not a copy.
 */
export function repoChipCount(s: LinksState, repo: string): { n: number; label: string; title: string } | null {
  const cut = { repo };
  const pins = inRepo(s.pinned, cut).length;
  if (pins > 0) return { n: pins, label: "links", title: chipTitle(pins) };
  const found = foundCut(s, cut, false).shown.length;
  return found > 0 ? { n: found, label: "found", title: `${found} link${found === 1 ? "" : "s"} found for this repo, none pinned yet` } : null;
}

/**
 * Both lists under the chip filters — the ONE function the chips count with and the sheet lists with.
 * A found row has never been checked, so while up/down cuts, the found list is empty (and the sheet
 * says why) rather than counted into a "not checked" it never had.
 */
export function cutBoth<P extends FacetRow, F extends FacetRow>(pins: readonly P[], found: readonly F[], f: Facets): { pins: P[]; found: F[]; n: number } {
  const p = facetCut(pins, f);
  const fo = f.health ? [] : facetCut(found, f, false);
  return { pins: p, found: fo, n: p.length + fo.length };
}
