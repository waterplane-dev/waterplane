/** Repo-scope rules (PLAN §4): pure functions from facts to findings, a checked-off list and not-checked rows. */
import { weekSavingOf } from "../saving.js";
import { overlapWords } from "../../agentfiles.js";
import { fmtCount } from "../../tokens.js";
import { isSetupFinding, setupRowKind, type ComplianceCheck } from "../../wire/repo.js";
import type { EvidenceRoute, FindingKind, FindingRemedy, FindingSaving, FindingsResult } from "../types.js";
import { Acc, FILES_ONLY, type FindingFacts } from "./facts.js";

const HANDLED = ["context-weight", "skill-frontmatter", "auto-compact", "env-gitignored"];

function savingOf(f: FindingFacts, extraChars: number): FindingSaving | undefined {
  if (!f.points || !(extraChars > 0)) return undefined;
  const s = weekSavingOf(f.points, { now: f.now, extraChars, ...(f.repo !== undefined ? { repo: f.repo } : {}) });
  return "absent" in s ? undefined : s;
}

const waiveOf = (c: ComplianceCheck, now: number): { reason?: string; at: string } | undefined =>
  c.ignored || c.accepted ? { at: new Date(now).toISOString() } : undefined;

/** One compliance check as a finding or a passed row. */
function fromCheck(a: Acc, id: string, rule: string, c: ComplianceCheck, o: {
  kind: FindingKind; evidence: EvidenceRoute | null; remedy: FindingRemedy; via: "ignore" | "accept" | "none"; saving?: FindingSaving;
}): void {
  if (c.status === "pass") { a.pass(id, rule, `${c.label}: ${c.detail}`, FILES_ONLY); return; }
  const w = waiveOf(c, a.f.now);
  a.find({
    ...(o.saving ? {} : { backends: FILES_ONLY }), id, rule, kind: o.kind, weight: c.advisory ? "consider" : "finding", what: `${c.label}: ${c.detail}`,
    evidence: o.evidence, ...(o.saving ? { saving: o.saving } : {}), remedy: o.remedy, waveVia: o.via, ...(w ? { waiveHint: w } : {}),
  });
}

export function repoRules(f: FindingFacts): FindingsResult {
  const a = new Acc(f, "repo");
  const repoId = f.repo ?? "";
  const checks = f.checks;
  const byId = (id: string) => checks?.find((c) => c.id === id);
  const need = (rule: string, id: string): ComplianceCheck | null => {
    const c = byId(id);
    if (!c) a.skip(rule, checks ? `the setup checklist has no ${id} row for this repo` : "the setup checklist was not read");
    return c ?? null;
  };

  // context-weight
  {
    const rule = "context-weight", id = "repo.context-weight";
    const c = need(rule, "context-weight");
    if (c) {
      const warn = f.instructions?.warnChars;
      const over = c.alwaysOnChars !== undefined && warn !== undefined ? c.alwaysOnChars - warn : 0;
      const saving = a.blind(rule) ? undefined : savingOf(f, over);
      // A warn that is only a repeat is the overlap finding's to say, not the weight's: the weight is lean.
      if (c.overlapOnly) a.pass(id, rule, "Agent context weight: the always-on instruction files are within the threshold.", FILES_ONLY);
      else fromCheck(a, id, rule, c, {
        kind: "cost", evidence: { screen: "alwayson", repoId }, saving,
        remedy: { kind: "seed", prompt: "groom", facts: { warnChars: warn ?? 0, ...(f.instructions?.warnSource ? { warnSource: f.instructions.warnSource } : {}) } },
        via: "ignore",
      });
    }
  }

  // instruction-overlap
  {
    const rule = "instruction-overlap";
    if (!f.instructions) a.skip(rule, "the instruction files were not read");
    else if (!f.instructions.overlaps.length) a.pass("repo.instruction-overlap", rule, "No two always-on instruction files repeat each other.", FILES_ONLY);
    else {
      for (const o of f.instructions.overlaps) {
        // A saving is read off Claude's own session history: a repeat only Copilot carries was never in a Claude request.
        const sv = o.readers.includes("claude") ? savingOf(f, o.chars) : undefined;
        a.find({
          id: `repo.instruction-overlap:${o.a}+${o.b}`, rule, kind: "cost", weight: "consider", what: overlapWords(o, fmtCount),
          evidence: { screen: "alwayson", repoId, path: o.a },
          ...(sv ? { saving: sv } : { backends: FILES_ONLY }),
          remedy: { kind: "seed", prompt: "dedupe-instructions", facts: { warnChars: f.instructions.warnChars, overlaps: f.instructions.overlaps.length } },
          waveVia: "ignore",
        });
      }
    }
  }

  // skill-frontmatter
  { const c = need("skill-frontmatter", "skill-frontmatter");
    if (c) fromCheck(a, "repo.skill-frontmatter", "skill-frontmatter", c, { kind: "quality", evidence: { screen: "file", repoId, path: ".claude/skills" }, remedy: { kind: "seed", prompt: "other-agents", facts: { warnChars: f.instructions?.warnChars ?? 0 } }, via: "ignore" }); }

  // auto-compact
  // A window from the user-level setting, the env (which beats every settings file) or none is ONE machine finding (`machine.auto-compact`); a repo finding only where this repo's own settings (or the env) decide it.
  { const c = need("auto-compact", "auto-compact");
    const ac = f.autoCompact;
    const decidedElsewhere = c !== null && c.status !== "pass" && ac !== undefined && (ac.source === "user" || ac.source === "unset" || ac.source === "env");
    if (c && !decidedElsewhere) fromCheck(a, "repo.auto-compact", "auto-compact", c, { kind: "quality", evidence: null, remedy: { kind: "fix", fixId: c.fix ?? "auto-compact" }, via: "ignore" }); }

  // env-gitignored
  { const c = need("env-gitignored", "env-gitignored");
    if (c) fromCheck(a, "repo.env-gitignored", "env-gitignored", c, { kind: "quality", evidence: { screen: "file", repoId, path: ".gitignore" }, remedy: c.fix ? { kind: "fix", fixId: c.fix } : { kind: "howto", text: "Add .env to .gitignore." }, via: "none" }); }

  // permissions
  {
    if (!f.permissions) { a.skip("permissions-broad", "the permission files were not read"); a.skip("permissions-shadowed", "the permission files were not read"); }
    else {
      const mine = f.permissions.filter((p) => p.source === "project" || p.source === "local");
      const key = (p: { list: string; rule: string }) => `${p.list}:${p.rule}`;
      const broad = mine.filter((p) => p.notes.some((n) => n.startsWith("Allows all of")));
      const shadowed = mine.filter((p) => p.notes.some((n) => n.startsWith("Never applies") || n.startsWith("Asked anyway")));
      if (!broad.length) a.pass("repo.permissions-broad", "permissions-broad", "No allow rule in this repo's own settings opens a whole tool.", FILES_ONLY);
      else a.find({ backends: FILES_ONLY, id: "repo.permissions-broad", rule: "permissions-broad", kind: "quality", weight: "consider", what: `${broad.length} allow rule${broad.length === 1 ? "" : "s"} in this repo's own settings open a whole tool: ${broad.map((p) => p.rule).join(", ")}.`, evidence: { screen: "permissions", repoId, ruleKeys: broad.map(key) }, remedy: { kind: "howto", text: "Narrow each rule to the commands this repo needs, or move it to ask." }, waveVia: "ignore" });
      if (!shadowed.length) a.pass("repo.permissions-shadowed", "permissions-shadowed", "No allow rule in this repo's own settings is overruled by a deny or ask.", FILES_ONLY);
      else a.find({ backends: FILES_ONLY, id: "repo.permissions-shadowed", rule: "permissions-shadowed", kind: "quality", weight: "consider", what: `${shadowed.length} rule${shadowed.length === 1 ? "" : "s"} in this repo's own settings never take effect: ${shadowed.map((p) => p.rule).join(", ")}.`, evidence: { screen: "permissions", repoId, ruleKeys: shadowed.map(key) }, remedy: { kind: "howto", text: "Delete the rule, or the deny or ask that overrides it." }, waveVia: "ignore" });
    }
  }

  // health alerts (severe only)
  {
    if (!f.health) a.skip("health-alert", "the repo-health series was not read");
    else {
      const severe = f.health.alerts.filter((x) => x.level === "severe");
      if (!severe.length) a.pass("repo.health-alert", "health-alert", "No repo-health reading is severely over its good line.", FILES_ONLY);
      for (const x of severe) a.find({ backends: FILES_ONLY, id: `repo.health-alert:${x.entry}`, rule: "health-alert", kind: "quality", weight: "consider", what: x.text, evidence: { screen: "readings", repoId, region: "series" }, remedy: { kind: "door", route: { screen: "readings", repoId, region: "series" } }, waveVia: "ignore" });
    }
  }

  // efficiency rules block
  {
    if (!f.efficiency) a.skip("efficiency-rules", "the instruction files were not read");
    else if (f.efficiency.present) a.pass("repo.efficiency-rules", "efficiency-rules", `${f.efficiency.target} carries the efficiency rules.`, FILES_ONLY);
    else a.find({ backends: FILES_ONLY, id: "repo.efficiency-rules", rule: "efficiency-rules", kind: "quality", weight: "consider", what: `${f.efficiency.target} does not carry the efficiency rules.`, evidence: { screen: "file", repoId, path: f.efficiency.target }, remedy: { kind: "write", target: f.efficiency.target }, waveVia: "ignore" });
  }

  // every other check: watch rows and install rows
  for (const c of checks ?? []) {
    if (HANDLED.includes(c.id) || c.scope === "host") continue;
    const kind = setupRowKind(c);
    const rule = `${kind}.${c.id}`, id = `repo.${rule}`;
    const w = waiveOf(c, a.f.now);
    const only = kind === "watch" ? {} : { backends: FILES_ONLY };
    if (c.status === "pass") { a.pass(id, rule, `${c.label}: ${c.detail}`, only.backends); continue; }
    a.find({
      ...only, id, rule, kind: kind === "watch" ? "watch" : "install",
      weight: isSetupFinding(c) || c.ignored || c.accepted ? "finding" : "consider",
      what: `${c.label}: ${c.detail}`,
      evidence: kind === "watch" ? { screen: "readings", repoId, region: "watch", rowId: c.id } : null,
      remedy: c.fix ? { kind: "fix", fixId: c.fix } : { kind: "agent", checkId: c.id, label: c.label, detail: c.detail },
      waveVia: kind === "watch" ? "accept" : c.advisory ? "ignore" : "none", ...(w ? { waiveHint: w } : {}),
    });
  }
  return a.out;
}
