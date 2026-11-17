/**
 * The demo's Setup check (`numbers.skills`, scenario `skills-switch`): the same `GET /api/setupcheck`
 * shape the host sends, small and fictional. A repo asked for gets one finding behind each evidence
 * door (always-on list, token stats cut, skills cut, permissions cut), one seed remedy, one failing
 * install row, a checked-off list and a not-checked row; the machine scope has one finding of its own.
 */
import { findingCut, repoRollup, type Finding, type FindingsResult, type NotChecked, type PassedCheck, type RollupInput } from "@waterplane/shared";

/** The shape `GET /api/setupcheck` answers (the phone's `SetupCheckResponse`, which the demo may not import). */
interface SetupCheckDoc { findings: Finding[]; passed: PassedCheck[]; notChecked: NotChecked[]; absent: { what: string; why: string }[]; at: number }

const claude = { understood: ["claude"], unread: [] as { id: string; why: string }[] };
const base = { backends: claude, waive: { via: "ignore" as const } };

export function demoSetupCheck(repoId: string | null, repoName: string | null, now: number): SetupCheckDoc {
  const findings: Finding[] = [
    {
      id: "machine.cold-cache", rule: "cold-cache", scope: "machine", kind: "cost", weight: "consider",
      what: "Some conversations paid for a cold cache after a gap of more than an hour.", backends: claude,
      evidence: { screen: "tokens", span: "30", box: "cold" }, remedy: { kind: "howto", text: "Keep a long session warm, or end it and start a new one." },
      waive: { via: "none" },
    },
  ];
  const passed: PassedCheck[] = [
    { id: "machine.price-list", rule: "price-list", scope: "machine", what: "The price list covers every model in the logs.", backends: claude, at: now },
  ];
  const notChecked: NotChecked[] = [
    { rule: "claude-signin", scope: "machine", why: "the claude sign-in could not be read from here" },
  ];
  if (repoId && repoName) {
    const r = { repo: repoName };
    findings.push(
      { ...base, ...r, id: "repo.context-weight", rule: "context-weight", scope: "repo", kind: "quality", weight: "finding",
        what: "The always-on text is about 2k tokens a request, over this repo's line.", evidence: { screen: "alwayson", repoId },
        remedy: { kind: "seed", prompt: "groom", facts: { warnChars: 16000 } } },
      { ...base, ...r, id: "repo.skills-unused", rule: "skills-unused", scope: "repo", kind: "cost", weight: "consider",
        what: "Two skills loaded into every session were never used.", evidence: { screen: "skills", repoId, ids: ["release-notes", "tidy-imports"] },
        remedy: { kind: "door", route: { screen: "skills", repoId, ids: ["release-notes", "tidy-imports"] } } },
      { ...base, ...r, id: "repo.costly-sessions", rule: "costly-sessions", scope: "repo", kind: "cost", weight: "consider",
        what: "Three conversations in this repo cost most of its week.", evidence: { screen: "tokens", span: "week", box: "top" },
        remedy: { kind: "howto", text: "Open the costliest and see what it carried." } },
      { ...base, ...r, id: "repo.permissions-broad", rule: "permissions-broad", scope: "repo", kind: "quality", weight: "consider",
        what: "One allow rule covers every shell command.", evidence: { screen: "permissions", repoId, ruleKeys: ["allow:Bash(*)"] },
        remedy: { kind: "door", route: { screen: "permissions", repoId, ruleKeys: ["allow:Bash(*)"] } } },
      { ...base, ...r, id: "repo.hooks-installed", rule: "hooks-installed", scope: "repo", kind: "install", weight: "finding",
        what: "The setup hook is not installed in this repo.", evidence: null, remedy: { kind: "howto", text: "Run the installer in this repo." } },
    );
    passed.push({ id: "repo.auto-compact", rule: "auto-compact", scope: "repo", repo: repoName, what: "Auto-compact is set below the window.", backends: claude, at: now });
    notChecked.push({ rule: "efficiency-rules", scope: "repo", repo: repoName, why: "the instruction file could not be read in the demo" });
  }
  return { findings, passed, notChecked, absent: [], at: now };
}

/**
 * `GET /api/setupcheck/repos` in the demo: the first repo and the second share one rule
 * (context-weight), the third has nothing open, and a fourth, fictional one could not be checked.
 */
export function demoAllRepos(repos: readonly { id: string; name: string }[], now: number): unknown {
  const [a, b, c] = repos;
  const mk = (r: { id: string; name: string }, rule: string, what: string, weight: "finding" | "consider"): Finding => ({
    ...base, repo: r.name, id: `repo.${rule}`, rule, scope: "repo", kind: "quality", weight, what, evidence: null, remedy: { kind: "howto", text: "Open this repo's check." },
  });
  const ok = (r: { id: string; name: string }, rule: string): PassedCheck => ({ id: `repo.${rule}`, rule, scope: "repo", repo: r.name, what: "checked, nothing to fix", backends: claude, at: now });
  const inputs: RollupInput[] = [];
  const res = (findings: Finding[], passed: PassedCheck[]): FindingsResult => ({ findings, passed, notChecked: [] });
  if (a) inputs.push({ repoId: a.id, name: a.name, at: now, result: res([mk(a, "context-weight", "The always-on text is over this repo's line.", "finding"), mk(a, "permissions-broad", "One allow rule covers every shell command.", "consider")], [ok(a, "env-gitignored")]) });
  if (b) inputs.push({ repoId: b.id, name: b.name, at: now, result: res([mk(b, "context-weight", "The always-on text is over this repo's line.", "finding")], [ok(b, "permissions-broad"), ok(b, "env-gitignored")]) });
  if (c) inputs.push({ repoId: c.id, name: c.name, at: now, result: res([], [ok(c, "context-weight"), ok(c, "permissions-broad"), ok(c, "env-gitignored")]) });
  inputs.push({ repoId: "demo-legacy", name: "legacy-tools", notChecked: "the path is gone" });
  const machine = demoSetupCheck(null, null, now).findings;
  return { rollup: repoRollup(inputs), machine: { count: findingCut(machine, { scope: "machine" }).count }, done: inputs.length, total: inputs.length, hidden: 0, at: now };
}
