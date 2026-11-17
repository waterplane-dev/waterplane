/**
 * The all-repos overview's roll-up: one list of RULE GROUPS over every primary repo. A repo rule that
 * repeats is one group with the repos it is open in, counted against the repos it RAN in.
 *
 * No ranking of repos against each other, no sum, no score: groups are ordered as `rankFindings` is
 * (counted findings first, then the highest single-repo saving, token saving, repos in the group, kind,
 * id); inside one group the repos are ordered by that rule's own saving, absent last. Only repo-scope
 * findings enter: machine and account findings are never repeated here. Waived findings are not
 * counted (they sit in each repo's own waived fold).
 */
import { BRAND } from "../brand.js";
import { groupRuleOf } from "./cut.js";
import type { FindingKind, FindingSaving, FindingsResult } from "./types.js";

export interface RollupInput {
  repoId: string;
  name: string;
  /** Absent when the repo could not be checked. */
  result?: FindingsResult;
  /** Why the repo was not checked (the collector threw, the path is gone, the sweep has not reached it). */
  notChecked?: string;
  /** Epoch ms of the repo's check. */
  at?: number;
}

export interface RollupRepo {
  repoId: string;
  name: string;
  /** The finding ids behind this row: the cut the repo's own check opens. */
  findingIds: string[];
  /** That finding's own saving line; the largest one when a repo holds several. Never a sum. */
  saving?: FindingSaving;
}

export interface RollupGroup {
  /** `groupRuleOf`: the rule, or "watch" / "install" for the two folded groups. */
  rule: string;
  kind: FindingKind;
  /** "finding" when any row is a counted finding, else "consider". */
  weight: "finding" | "consider";
  /** The rule's sentence, with no repo's number in it. */
  what: string;
  /** Repos the rule ran in (found, passed or waived there). */
  ranIn: number;
  /** Repos where the rule could not run. */
  unreadIn: number;
  repos: RollupRepo[];
}

/** A repo with nothing open: the checks that passed AND the rules that could not run (never "nothing to fix" with the reasons dropped). */
export interface RollupClear { repoId: string; name: string; passed: number; notChecked: number; at?: number }
export interface RollupNotChecked { repoId: string; name: string; why: string }

export interface Rollup { groups: RollupGroup[]; clear: RollupClear[]; notChecked: RollupNotChecked[] }

const RULE_WORDS: Record<string, string> = {
  "context-weight": "The always-on instruction files are heavier than the repo's threshold.",
  "instruction-overlap": "Two always-on instruction files repeat each other.",
  "skill-frontmatter": "A skill's front matter is missing or malformed.",
  "auto-compact": "This repo's own settings set auto-compact to an expensive size.",
  "env-gitignored": "A .env file is not in .gitignore.",
  "permissions-broad": "An allow rule in the repo's own settings opens a whole tool.",
  "permissions-shadowed": "A rule in the repo's own settings never takes effect.",
  "health-alert": "The repo-health series has a severe alert.",
  "efficiency-rules": "The instruction file does not carry the efficiency rules.",
  watch: "exposure watch",
  install: `${BRAND.displayName} install`,
};

const KIND_ORDER: Record<FindingKind, number> = { cost: 0, quality: 1, watch: 2, install: 3 };
const num = (n: number | undefined): number => (n === undefined ? -1 : n);

const savingBetter = (a: FindingSaving | undefined, b: FindingSaving | undefined): number =>
  num(b?.usd) - num(a?.usd) || num(b?.tokens) - num(a?.tokens);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function repoRollup(repos: readonly RollupInput[]): Rollup {
  const clear: RollupClear[] = [];
  const notChecked: RollupNotChecked[] = [];
  type G = { rule: string; kind: FindingKind; weight: "finding" | "consider"; whats: Set<string>; ran: Set<string>; unread: Set<string>; rows: Map<string, RollupRepo & { n: number }> };
  const groups = new Map<string, G>();
  const get = (f: { rule: string; kind: FindingKind }): G => {
    const rule = groupRuleOf(f);
    let g = groups.get(rule);
    if (!g) groups.set(rule, g = { rule, kind: f.kind, weight: "consider", whats: new Set(), ran: new Set(), unread: new Set(), rows: new Map() });
    return g;
  };
  for (const r of repos) {
    if (!r.result) { notChecked.push({ repoId: r.repoId, name: r.name, why: r.notChecked ?? "this repo was not checked" }); continue; }
    const own = (x: { scope: string }) => x.scope === "repo";
    const live = r.result.findings.filter((f) => own(f) && f.waive.waived === undefined);
    for (const f of live) {
      const g = get(f);
      g.kind = f.kind;
      g.ran.add(r.repoId);
      g.whats.add(f.what);
      if (f.weight === "finding") g.weight = "finding";
      let row = g.rows.get(r.repoId);
      if (!row) g.rows.set(r.repoId, row = { repoId: r.repoId, name: r.name, findingIds: [], n: 0 });
      row.findingIds.push(f.id);
      if (f.saving && savingBetter(row.saving, f.saving) > 0) row.saving = f.saving;
    }
    for (const p of r.result.passed) if (own(p)) get({ rule: p.rule, kind: kindOfRule(p.rule) }).ran.add(r.repoId);
    for (const n of r.result.notChecked) if (own(n)) get({ rule: n.rule, kind: kindOfRule(n.rule) }).unread.add(r.repoId);
    if (!live.length) clear.push({ repoId: r.repoId, name: r.name, passed: r.result.passed.filter(own).length, notChecked: r.result.notChecked.filter(own).length, ...(r.at !== undefined ? { at: r.at } : {}) });
  }
  const out: RollupGroup[] = [];
  for (const g of groups.values()) {
    if (!g.rows.size) continue; // a rule nobody has open is not a group
    const repos = [...g.rows.values()].map(({ n: _n, ...row }) => row)
      .sort((a, b) => savingBetter(a.saving, b.saving) || byText(a.name, b.name));
    // A repo that is both read and unread for a rule counts once, as read.
    const unread = [...g.unread].filter((id) => !g.ran.has(id));
    const sentence = RULE_WORDS[g.rule] ?? (g.whats.size === 1 ? [...g.whats][0]! : g.rule.replace(/-/g, " "));
    out.push({ rule: g.rule, kind: g.kind, weight: g.weight, what: sentence, ranIn: g.ran.size, unreadIn: unread.length, repos });
  }
  out.sort((a, b) => {
    // The install group is always last, as on "this repo".
    const inst = Number(a.rule === "install") - Number(b.rule === "install");
    if (inst) return inst;
    const w = Number(a.weight === "consider") - Number(b.weight === "consider");
    if (w) return w;
    const s = savingBetter(a.repos[0]?.saving, b.repos[0]?.saving);
    if (s) return s;
    return b.repos.length - a.repos.length || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byText(a.rule, b.rule);
  });
  clear.sort((a, b) => byText(a.name, b.name));
  notChecked.sort((a, b) => byText(a.name, b.name));
  return { groups: out, clear, notChecked };
}

function kindOfRule(rule: string): FindingKind {
  return rule.startsWith("watch.") ? "watch" : rule.startsWith("install.") ? "install" : "quality";
}

export interface RollupCut {
  /** The group a rule cut names; null when no rule was asked for or none matches. */
  group: RollupGroup | null;
  /** The repo rows of that group (empty with no rule). */
  rows: RollupRepo[];
  /** What the control said: the groups, or with a rule that group's repos. The row count is this. */
  count: number;
  /**
   * The denominator of `count`: with a rule, the repos that rule RAN in (found, passed or waived);
   * without one, the repos in the overview (open, nothing open or not checked).
   */
  of: number;
  /** With a rule: the repos where it could not run (said beside the count, never inside the denominator). */
  unread: number;
}

/** THE bucketing function of the all-repos view: a group's number, its rows and the "n of N repos" bar all call it. */
export function repoRollupCut(r: Rollup, opts: { rule?: string } = {}): RollupCut {
  const ids = new Set<string>();
  for (const g of r.groups) for (const x of g.repos) ids.add(x.repoId);
  for (const x of r.clear) ids.add(x.repoId);
  for (const x of r.notChecked) ids.add(x.repoId);
  const of = ids.size;
  if (opts.rule === undefined) return { group: null, rows: [], count: r.groups.length, of, unread: 0 };
  const group = r.groups.find((g) => g.rule === opts.rule) ?? null;
  const rows = group ? group.repos : [];
  return { group, rows, count: rows.length, of: group ? group.ranIn : 0, unread: group ? group.unreadIn : 0 };
}
