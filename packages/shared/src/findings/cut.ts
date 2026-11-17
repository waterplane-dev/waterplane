import type { Finding, FindingScope, FindingsResult, NotChecked, PassedCheck } from "./types.js";

export interface FindingCutOpts {
  scope?: FindingScope;
  repo?: string;
  weight?: "finding" | "consider";
  /** One all-repos group (`groupRuleOf`): watch rows and install rows each fold to one. */
  rule?: string;
  /** Findings whose evidence door is this screen ("tokens": the findings about spend), whatever their scope or weight. */
  screen?: string;
}

/** The all-repos group a finding belongs to: its rule, except that every watch row and every install row folds to one. */
export const groupRuleOf = (f: Pick<Finding, "kind" | "rule">): string => (f.kind === "watch" ? "watch" : f.kind === "install" ? "install" : f.rule);

const keeps = (o: { scope: FindingScope; repo?: string }, opts: FindingCutOpts): boolean =>
  (opts.scope === undefined || o.scope === opts.scope) && (opts.repo === undefined || o.repo === opts.repo);

/**
 * THE bucketing function: the rows and their count. The badge, a group head and an "n of N" bar all
 * call it. Waived findings are not findings: they leave the list (see `checkedOffOf`).
 */
export function findingCut(list: readonly Finding[], opts: FindingCutOpts = {}): { rows: Finding[]; count: number } {
  const rows = list.filter((f) => f.waive.waived === undefined && keeps(f, opts) && (opts.weight === undefined || f.weight === opts.weight) && (opts.rule === undefined || groupRuleOf(f) === opts.rule) && (opts.screen === undefined || f.evidence?.screen === opts.screen));
  return { rows, count: rows.length };
}

/** The same cut over the checked-off list and what could not run, so every view shows them. */
export function checkedCut(r: Pick<FindingsResult, "passed" | "notChecked">, opts: FindingCutOpts = {}): { passed: PassedCheck[]; notChecked: NotChecked[] } {
  return { passed: r.passed.filter((p) => keeps(p, opts)), notChecked: r.notChecked.filter((n) => keeps(n, opts)) };
}

/** A waived finding moves to the checked-off list, labelled "waived: <reason>". */
export function waivedAsPassed(f: Finding, at: number): PassedCheck {
  const reason = f.waive.waived?.reason;
  return {
    id: f.id, rule: f.rule, scope: f.scope, ...(f.repo !== undefined ? { repo: f.repo } : {}),
    what: f.what, backends: f.backends, at,
    waived: `waived: ${reason && reason.trim() ? reason.trim() : "no reason given"}`,
  };
}

/** Split a raw engine output: waived findings leave `findings` and join `passed`. */
export function checkedOffOf(r: FindingsResult, at: number): FindingsResult {
  const live = r.findings.filter((f) => f.waive.waived === undefined);
  const waived = r.findings.filter((f) => f.waive.waived !== undefined).map((f) => waivedAsPassed(f, at));
  return { findings: live, passed: [...r.passed, ...waived], notChecked: r.notChecked };
}

/** Rows whose id is named; an empty or absent list is no cut (all rows). The doors' ONE id cut. */
export function cutByIds<T>(rows: readonly T[], ids: readonly string[] | undefined | null, idOf: (r: T) => string): T[] {
  if (!ids || !ids.length) return [...rows];
  const want = new Set(ids);
  return rows.filter((r) => want.has(idOf(r)));
}

/** The "n of N" sentence of a screen cut to what a Setup check door named, against the UNFILTERED count. */
export const evidenceCutWords = (shown: number, all: number, what: string): string =>
  `${shown} of ${all} ${what} shown — only what the Setup check named`;
