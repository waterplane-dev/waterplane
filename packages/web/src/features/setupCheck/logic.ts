/**
 * The Setup check's pure half: which rows each scope chip, the badge cut and the folds show. ONE
 * bucketing function (`@waterplane/shared` `findingCut`) feeds a chip's number and the rows under
 * it, so a count and the list it opens cannot disagree (CLAUDE.md: a count is a filter).
 */
import { checkedCut, findingCut, rankFindings } from "@waterplane/shared";
import type { Finding, FindingScope, NotChecked, PassedCheck } from "@waterplane/shared";
import type { SetupCheckResponse } from "../../setupCheckTypes";
import { CLAUDE_MD_KEY, DESC_KEY } from "../../repoHealthPlot.ts";

/** The chips: the all-repos overview beside the three scopes. */
export type SetupCheckView = FindingScope | "all";

export const SCOPES: readonly FindingScope[] = ["repo", "machine", "account"];

export interface SetupCheckAim {
  repoId: string | null;
  scope: SetupCheckView;
  /** The repo badge opened this: cut to exactly what the badge counts. */
  weight?: "finding";
  /** This repo cut to one rule (a repo row of the all-repos view opened it). */
  rule?: string;
  /** Cut to the findings whose evidence is this screen, across scopes (the usage sheet's "about this spend"). */
  screen?: string;
  /** All repos: the group whose repos are listed (a tap on "in 7 of 33 repos"). Survives a drill-down and Back. */
  openRule?: string;
  /** Opened from the all-repos view: Back returns there, with `openRule` still open. */
  from?: "all";
}

export const initialAim = (): SetupCheckAim => ({ repoId: null, scope: "repo" });

/**
 * Which scope to open on: the one asked for, else this repo when there is one, else this machine. A cut (a
 * spend screen, the badge's findings) is a filter only a repo or machine view draws, so it never lands on all repos.
 */
export function landingScope(asked: FindingScope | undefined, repoId: string | null, primaryRepos = 0, cut = false): SetupCheckView {
  if (asked) return asked === "repo" && !repoId ? "machine" : asked;
  if (repoId) return "repo";
  if (cut) return "machine";
  return primaryRepos >= 2 ? "all" : "machine";
}

/** The main-menu line's target: all repos with two or more primary repos, else that repo, else this machine. */
export function menuAim(primaryIds: readonly string[]): SetupCheckAim {
  if (primaryIds.length >= 2) return { repoId: null, scope: "all" };
  if (primaryIds.length === 1) return { repoId: primaryIds[0]!, scope: "repo" };
  return { repoId: null, scope: "machine" };
}

export interface ScopeView {
  /** Findings to fix, ranked, install rows apart. */
  rows: Finding[];
  /** Plumbing: waterplane's own install checks that fail. */
  install: Finding[];
  /** Waived on purpose (moved to the checked-off list by the engine), each takeable back. */
  waived: PassedCheck[];
  /** Ran and found nothing. */
  passed: PassedCheck[];
  notChecked: NotChecked[];
  /** Rows in this scope with the badge cut off — the "N of" against the cut. */
  all: number;
  /** Rows with the badge cut on. */
  count: number;
}

/** The ONE cut: a scope, optionally the badge's weight. Chip number = `count`, list = `rows` + `install`. */
export function viewOf(doc: SetupCheckResponse, scope: FindingScope, weight?: "finding", rule?: string, screen?: string): ScopeView {
  // A screen cut spans every scope: the spend findings are machine and repo rows alike.
  const base = findingCut(doc.findings, screen ? {} : { scope });
  const cut = findingCut(doc.findings, { ...(screen ? { screen } : { scope }), ...(weight ? { weight } : {}), ...(rule ? { rule } : {}) });
  const ranked = rankFindings(cut.rows);
  const checked = checkedCut(doc, screen ? {} : { scope });
  return {
    rows: ranked.filter((f) => f.kind !== "install"),
    install: ranked.filter((f) => f.kind === "install"),
    waived: checked.passed.filter((p) => p.waived !== undefined),
    passed: checked.passed.filter((p) => p.waived === undefined),
    notChecked: checked.notChecked,
    all: base.count,
    count: cut.count,
  };
}

/** The scope chip's count (never the badge cut: a chip counts what the scope holds). */
export const chipCountOf = (doc: SetupCheckResponse, scope: FindingScope): number => findingCut(doc.findings, { scope }).count;

/** Nothing is drawn for a scope with no repo chosen. */
export const scopeChips = (hasRepo: boolean, manyRepos = false): SetupCheckView[] => [
  ...(manyRepos ? ["all" as const] : []),
  ...(hasRepo ? SCOPES : SCOPES.filter((k) => k !== "repo")),
];

/** The three counts the head line says, over the scope on screen. */
export const headCounts = (v: ScopeView): { findings: number; passed: number; notChecked: number } => ({
  findings: v.rows.length + v.install.length,
  passed: v.passed.length + v.waived.length,
  notChecked: v.notChecked.length,
});

/** The finding a waived row came from, as the waive route wants it. A repo row needs its repo id. */
export function waiveBody(id: string, waive: boolean, repoId: string | null, reason?: string, via?: "ignore" | "accept" | "none"): { id: string; waive: boolean; repo?: string; reason?: string; via?: "ignore" | "accept" } {
  return { id, waive, ...(id.startsWith("repo.") && repoId ? { repo: repoId } : {}), ...(reason ? { reason } : {}), ...(via === "ignore" || via === "accept" ? { via } : {}) };
}

/** The evidence door a card draws: none when its remedy is a door to the very same place (one button, not two with one label). */
export function evidenceDoorOf<R extends object>(f: { evidence: R | null; remedy: { kind: string; route?: R } }): R | null {
  if (!f.evidence) return null;
  return f.remedy.kind === "door" && f.remedy.route && JSON.stringify(f.remedy.route) === JSON.stringify(f.evidence) ? null : f.evidence;
}

/** Lines in the block a write would add: what the confirm says. */
export const blockLines = (block: string): number => block.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "")).length;

/**
 * Where a `fix` remedy runs: a machine finding's fix is the desktop's own (`/api/host/setup/fix`,
 * needs no repo); every other scope's is a repo's compliance fix.
 */
export function fixRoute(scope: string): "host" | "repo" { return scope === "machine" ? "host" : "repo"; }


/** The finding whose evidence is the always-on weight on its second clock. */
export const WEIGHT_FINDING_ID = "repo.context-weight";

/** The minimal series shape `weightClocksOf` reads (a `RepoHealthPlotSeries` fits). */
interface WeightSeries { key: string; last: number | null; points: ReadonlyArray<{ sha7?: string | null }> }

/**
 * The always-on weight as the series measured it at the last commit: the two halves, their sum and
 * the commit. Null when the series holds neither half. The sum is claimed only when BOTH halves
 * have a reading (a half alone is not the total). The working-tree figure is the finding's own
 * sentence and is never repeated or reconciled with this one.
 */
export function weightClocksOf<S extends WeightSeries>(series: ReadonlyArray<S> | null | undefined): { claudeMd: S | null; desc: S | null; at: string | null; total: number | null } | null {
  const claudeMd = series?.find((s) => s.key === CLAUDE_MD_KEY) ?? null;
  const desc = series?.find((s) => s.key === DESC_KEY) ?? null;
  if (!claudeMd && !desc) return null;
  const at = claudeMd?.points[claudeMd.points.length - 1]?.sha7 ?? desc?.points[desc.points.length - 1]?.sha7 ?? null;
  const total = claudeMd?.last != null && desc?.last != null ? claudeMd.last + desc.last : null;
  return { claudeMd, desc, at, total };
}

/** The not-checked rows as plain sentences: no rule id (the fold says "not checked"), one line per distinct reason. */
export function notCheckedSentences(rows: ReadonlyArray<{ why: string }>): string[] {
  return [...new Set(rows.map((n) => `${n.why.charAt(0).toUpperCase()}${n.why.slice(1)}.`))];
}

/**
 * The repo id an evidence door means. The host's findings carry the repo's KEY (its worktree path,
 * `repoOfWorktree`) in `evidence.repoId`, while every screen a door opens takes an id; handing the path
 * on made Files say "not in the listing" and the readings/permissions doors fall back to the active repo.
 * An id wins, then a worktree path; a route that names no repo means the repo the check is drilled into.
 * A route that names a repo this phone does not know is null — never the drilled repo's: the door would
 * open another repo's file or readings under the first one's words (the caller says so in a toast).
 */
export function doorRepoId(repos: ReadonlyArray<{ id: string; worktreePath: string }>, raw: string | undefined, drilled: string | null): string | null {
  const trim = (p: string): string => {
    let end = p.length;
    while (end > 1 && p[end - 1] === "/") end--;
    return p.slice(0, end);
  };
  if (raw) {
    const hit = repos.find((r) => r.id === raw) ?? repos.find((r) => trim(r.worktreePath) === trim(raw));
    return hit ? hit.id : null;
  }
  return drilled && repos.some((r) => r.id === drilled) ? drilled : null;
}

/** The names the desktop sent for its backends, by id: how a finding's backends line names one a plugin added. */
export const backendLabels = (list: ReadonlyArray<{ id: string; label: string }> | null | undefined): Record<string, string> =>
  Object.fromEntries((list ?? []).map((b) => [b.id, b.label]));

/** Which scope chips a Setup & health tab draws: This repo has the repo and all-repos views, This desktop the machine and account ones. */
export function scopesOfTab(tab: "repo" | "desktop"): readonly SetupCheckView[] {
  return tab === "desktop" ? ["machine", "account"] : ["repo", "all"];
}

/** The tab a Setup check view sits on. */
export function tabOfScope(scope: SetupCheckView): "repo" | "desktop" {
  return scope === "machine" || scope === "account" ? "desktop" : "repo";
}

const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Every check of one scope with its state, keyed so a finding that became a pass is the same check. */
function statesOf(doc: SetupCheckResponse, scope: FindingScope): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of doc.findings) if (f.scope === scope) m.set(f.id, `finding:${f.weight}:${f.what}`);
  for (const p of doc.passed) if (p.scope === scope) m.set(p.id, p.waived !== undefined ? "waived" : "passed");
  for (const n of doc.notChecked) if (n.scope === scope) m.set(`${n.scope}.${n.rule}:not`, "not");
  return m;
}

/**
 * The line `Check again` always ends on (whole-app journey spec T17): when the desktop's check is
 * from, and how many checks of this scope changed against the read on screen before the tap.
 * "Checked 14:02. No change." / "Checked 14:02. 2 checks changed." With nothing read before, just
 * the time.
 */
export function checkAgainWords(before: SetupCheckResponse | null, after: SetupCheckResponse, scope: FindingScope): string {
  const head = `Checked ${hhmm(after.at)}.`;
  if (!before || before.pending) return head;
  const a = statesOf(before, scope), b = statesOf(after, scope);
  let n = 0;
  for (const [k, v] of b) if (a.get(k) !== v) n++;
  for (const k of a.keys()) if (!b.has(k)) n++;
  return n === 0 ? `${head} No change.` : `${head} ${n} ${n === 1 ? "check" : "checks"} changed.`;
}
