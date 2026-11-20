/**
 * The Setup check's collector: gathers `FindingFacts` from what the daemon already keeps, runs the
 * three rule sets and returns one ranked result with its checked-off list.
 *
 * Never in a request path: every source here is a cache or a file read the sweep already does. Each
 * source is wrapped, so one that throws is an `absent` entry (and the rule that needed it says "not
 * checked"), never a failed answer. Every source is injected, so a test hands in fakes.
 */
import {
  accountRules, checkedOffOf, docInput, machineRules, rankFindings, repoRules,
  type BillingProfile, type ComplianceCheck, type Finding, type FindingFacts, type FindingsResult, type InstructionFile, type InstructionOverlap, type SeriesPoint, type TokenStatsDoc, type UsageInfo,
} from "@waterplane/shared";
import { backendsOf, globalInstructionsOf, skillFactsOf, trendOf, weekPaceFact, autoCompactFact } from "./readers.js";
import type { AutoCompactResolution } from "@waterplane/shared";

export interface SetupCheckAbsent { what: string; why: string }

export interface SetupCheckDoc extends FindingsResult {
  /** Sources that could not be read this time, each with its sentence. */
  absent: SetupCheckAbsent[];
  at: number;
}

export interface CollectDeps {
  now(): number;
  /** The repo key of a worktree (`repoOfWorktree`). */
  repoKey(worktree: string): string;
  inspect(worktree: string): Promise<ComplianceCheck[]>;
  hostChecks(): ComplianceCheck[] | Promise<ComplianceCheck[]>;
  /** The claude CLI row, or `null` when the probe could not answer. */
  claudeCli(): Promise<ComplianceCheck | null>;
  instructions(worktree: string): { files: InstructionFile[]; overlaps: InstructionOverlap[]; desktop: InstructionFile[] | null };
  warn(worktree: string): { warnChars: number; warnSource: "repo" | "env" | "default"; globalWarnChars: number };
  /** Every repo's points. Throws when the first sweep is still running. */
  points(): Promise<SeriesPoint[]>;
  ledger(): Promise<TokenStatsDoc>;
  skills(worktree: string): Promise<readonly { kind: string }[]>;
  autoCompact(worktree: string): AutoCompactResolution;
  /** The window this desktop decides with no repo layer; absent = the repo's own reading stands in. */
  autoCompactMachine?(): AutoCompactResolution;
  /** The auto-compact window the person chose as their default (the line both the repo and the machine reading are judged by). */
  autoCompactDefault?(): string;
  usage(): UsageInfo | null;
  /** Severe health alerts of the repo's latest scored week; `undefined` when it has no series. */
  health?(worktree: string): FindingFacts["health"];
  /** The capped dollar periods' pace; `null` = nothing to judge. */
  period?(now: number): NonNullable<FindingFacts["usage"]>["period"];
  /** The Copilot source's reading, from the usage registry; `null` = none. */
  copilot?(now: number): NonNullable<FindingFacts["usage"]>["copilot"];
  billing(): BillingProfile;
  backends(): readonly { id: string; label: string; kind?: string }[];
  /** Waived finding ids: the desktop's and account's, and this repo's own. */
  waived(worktree: string): Record<string, { reason?: string; at: string }>;
  /** The repo's efficiency-rules block (`efficiencywrite.ts`). Absent ⇒ that rule says "not checked". */
  /** Findings extensions and plugins contribute (`api.setupFinding`). Absent ⇒ none were asked. */
  contributed?(worktree: string): Promise<{ findings: Finding[]; answered: string[] }>;
  efficiency?(worktree: string): { present: boolean; target: "CLAUDE.md" | "AGENTS.md" };
}

/** Run one source: a throw (or a rejection) is an `absent` entry. */
async function guard<T>(absent: SetupCheckAbsent[], what: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (e) { absent.push({ what, why: e instanceof Error ? e.message : String(e) }); return undefined; }
}

export async function collectFacts(d: CollectDeps, worktree: string): Promise<{ facts: FindingFacts; absent: SetupCheckAbsent[]; cli: ComplianceCheck | null | undefined }> {
  const absent: SetupCheckAbsent[] = [];
  const now = d.now();
  const [checks, instr, points, doc, skills, cli] = await Promise.all([
    guard(absent, "this repo's setup checklist", () => d.inspect(worktree)),
    guard(absent, "the instruction files", () => d.instructions(worktree)),
    guard(absent, "the session history", () => d.points()),
    guard(absent, "the token ledger", () => d.ledger()),
    guard(absent, "the skill inventory", () => d.skills(worktree)),
    guard(absent, "the claude CLI probe", () => d.claudeCli()),
  ]);
  const hostRows = await guard(absent, "this desktop's checklist", () => d.hostChecks());
  const limits = await guard(absent, "the context thresholds", () => d.warn(worktree));
  const ac = await guard(absent, "where auto-compact is decided", () => d.autoCompact(worktree));
  const acMachine = d.autoCompactMachine ? await guard(absent, "where this desktop decides auto-compact", () => d.autoCompactMachine!()) : undefined;
  const usage = await guard(absent, "the usage reading", () => d.usage());
  const health = d.health ? await guard(absent, "the repo-health series", () => d.health!(worktree)) : undefined;
  const period = d.period ? await guard(absent, "the budget periods", () => d.period!(now)) : undefined;
  const copilot = d.copilot ? await guard(absent, "the Copilot reading", () => d.copilot!(now)) : undefined;
  const billing = await guard(absent, "the billing profile", () => d.billing());
  const infos = await guard(absent, "the backend list", () => d.backends());
  const waived = await guard(absent, "your waived findings", () => d.waived(worktree));
  const efficiency = d.efficiency ? await guard(absent, "the efficiency-rules block", () => d.efficiency!(worktree)) : undefined;

  const facts: FindingFacts = { now, repo: d.repoKey(worktree) };
  if (billing) facts.billing = billing;
  if (infos) facts.backends = backendsOf(infos);
  if (checks) facts.checks = checks;
  if (hostRows) facts.hostChecks = cli ? [...hostRows, cli] : hostRows;
  if (instr && limits) facts.instructions = { overlaps: instr.overlaps, warnChars: limits.warnChars, warnSource: limits.warnSource };
  if (points) facts.points = points;
  if (doc) { facts.ledger = docInput(doc); facts.trend = trendOf(doc.days, now); }
  if (skills) facts.skills = skillFactsOf(skills);
  if (ac && checks) { const f = autoCompactFact(ac, checks.find((c) => c.id === "auto-compact"), acMachine, d.autoCompactDefault?.()); if (f) facts.autoCompact = f; }
  if (instr && limits) { const g = globalInstructionsOf(instr.desktop, limits.globalWarnChars); if (g) facts.globalInstructions = g; }
  if (usage !== undefined) facts.usage = { week: weekPaceFact(usage, now) };
  // period and copilot are separate sources: one that was not read leaves its own key out ("not checked"), never the week's.
  if (period !== undefined || copilot !== undefined) facts.usage = { ...facts.usage, ...(period !== undefined ? { period } : {}), ...(copilot !== undefined ? { copilot } : {}) };
  if (health) facts.health = health;
  if (waived) facts.waived = waived;
  if (efficiency) facts.efficiency = efficiency;
  return { facts, absent, cli };
}

/** Rules the permissions extension answers; its clean answer is a passed row, its failure a "not checked". */
const PERMISSION_RULES: Record<"repo" | "machine", string[]> = {
  repo: ["permissions-broad", "permissions-shadowed", "permissions-duplicate"],
  machine: ["permissions-broad", "permissions-shadowed", "permissions-duplicate"],
};
const PERMISSION_WORDS: Record<string, string> = {
  "permissions-broad": "No allow rule opens a whole tool.",
  "permissions-shadowed": "No allow rule is overruled by a deny or ask.",
  "permissions-duplicate": "No rule is repeated in another settings file.",
};

/**
 * Fold what extensions contributed into the result. Their findings take the repo key, the waive
 * state and the repo id on a door; an id the core already produced is not doubled. A rule the core
 * could only call "not checked" is answered by the extension: a finding replaces it, a clean answer
 * (the extension ran without a throw and found nothing) becomes a passed row.
 */
export function foldContributed(res: FindingsResult, got: { findings: Finding[]; answered: string[] }, ctx: { repo: string; waived: Record<string, { reason?: string; at: string }>; at: number }): void {
  const have = new Set(res.findings.map((f) => f.id));
  for (const f of got.findings) {
    if (have.has(f.id)) continue;
    have.add(f.id);
    const w = ctx.waived[f.id];
    const ev = f.evidence && "repoId" in f.evidence ? f.evidence : null;
    const evidence = f.scope === "repo" && f.evidence && (f.evidence.screen === "permissions" || f.evidence.screen === "skills" || f.evidence.screen === "alwayson") && !ev?.repoId ? { ...f.evidence, repoId: ctx.repo } : f.evidence;
    res.findings.push({ ...f, ...(f.scope === "repo" ? { repo: ctx.repo } : {}), evidence, waive: w ? { ...f.waive, waived: w } : f.waive });
  }
  if (!got.answered.includes("permissions")) return;
  for (const scope of ["repo", "machine"] as const) {
    for (const rule of PERMISSION_RULES[scope]) {
      const id = `${scope}.${rule}`;
      const i = res.notChecked.findIndex((n) => n.scope === scope && n.rule === rule);
      if (i >= 0) res.notChecked.splice(i, 1);
      if (have.has(id) || res.passed.some((x) => x.id === id)) continue;
      // Only rules the core rule set knows how to word get a passed row: duplicate is the extension's own.
      res.passed.push({ id, rule, scope, ...(scope === "repo" ? { repo: ctx.repo } : {}), what: PERMISSION_WORDS[rule]!, backends: { understood: ["claude"], unread: [] }, at: ctx.at });
    }
  }
}

/** One pass: facts, the three rule sets, the claude-CLI "not checked" line, ranking, waived moved to checked-off. */
export async function runSetupCheck(d: CollectDeps, worktree: string): Promise<SetupCheckDoc> {
  const { facts, absent, cli } = await collectFacts(d, worktree);
  const parts = [repoRules(facts), machineRules(facts), accountRules(facts)];
  const merged: FindingsResult = {
    findings: parts.flatMap((p) => p.findings),
    passed: parts.flatMap((p) => p.passed),
    notChecked: parts.flatMap((p) => p.notChecked),
  };
  if (d.contributed) {
    try { foldContributed(merged, await d.contributed(worktree), { repo: d.repoKey(worktree), waived: facts.waived ?? {}, at: facts.now }); }
    catch (e) { absent.push({ what: "findings from extensions", why: e instanceof Error ? e.message : String(e) }); }
  }
  if (cli === null) merged.notChecked.push({ rule: "install.claude-cli", scope: "machine", why: "claude's sign-in state could not be read just now (the probe did not answer)" });
  const at = facts.now;
  const done = checkedOffOf(merged, at);
  return { ...done, findings: rankFindings(done.findings), absent, at };
}

/** The sources that do not depend on the worktree, memoized for ONE sweep: N repos read them once, not N times. */
export function sharedOnce(d: CollectDeps): CollectDeps {
  const once = <A extends unknown[], T>(fn: (...a: A) => T): ((...a: A) => T) => {
    let box: { v: T } | { e: unknown } | null = null;
    return (...a: A): T => {
      if (!box) { try { box = { v: fn(...a) } } catch (e) { box = { e }; } }
      if ("e" in box) throw box.e;
      return box.v;
    };
  };
  const out: CollectDeps = {
    ...d,
    hostChecks: once(() => d.hostChecks()),
    claudeCli: once(() => d.claudeCli()),
    points: once(() => d.points()),
    ledger: once(() => d.ledger()),
    // Only machine rules read the skill inventory (it cost 0.7 s per worktree cold): the first worktree's reading stands for all.
    skills: once((wt: string) => d.skills(wt)),
    usage: once(() => d.usage()),
    billing: once(() => d.billing()),
    backends: once(() => d.backends()),
    // Per repo: a repo finding is waived for that repo only. A plain read of the prefs file, no memo.
    waived: (wt: string) => d.waived(wt),
  };
  if (d.period) out.period = once((now: number) => d.period!(now));
  if (d.copilot) out.copilot = once((now: number) => d.copilot!(now));
  if (d.autoCompactMachine) out.autoCompactMachine = once(() => d.autoCompactMachine!());
  return out;
}

export interface SweepRepo { id: string; name: string; worktree: string }
/** One repo's outcome in an all-repos sweep: its document, or the sentence for why it could not be checked. */
export type RepoOutcome = { doc: SetupCheckDoc } | { why: string };

/** A promise that gives up: a repo whose run outlasts its own timeout is "not checked", never dropped and never a hang. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const late = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(what)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

/**
 * Check every repo, `concurrency` at a time, writing each outcome into `into` as it lands (so a
 * partial map is readable while the sweep runs). A throwing or too-slow repo is a `why`, not an
 * exception: the sweep always finishes.
 */
export async function sweepRepos(d: CollectDeps, repos: readonly SweepRepo[], into: Map<string, RepoOutcome>, o: { concurrency?: number; timeoutMs?: number } = {}): Promise<void> {
  const shared = sharedOnce(d);
  const timeoutMs = o.timeoutMs ?? 60_000;
  let next = 0;
  const lane = async () => {
    for (;;) {
      const r = repos[next++];
      if (!r) return;
      try { into.set(r.id, { doc: await within(runSetupCheck(shared, r.worktree), timeoutMs, `the check of this repo took longer than ${Math.round(timeoutMs / 1000)} s`) }); }
      catch (e) { into.set(r.id, { why: e instanceof Error ? e.message : String(e) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, repos.length)) }, lane));
}
