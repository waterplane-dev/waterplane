/**
 * Every writer of the Setup check's aim, and everything a tap on a row does. Nothing here applies
 * itself: a `seed` opens the Send sheet and sends nothing, a `fix` and a `write` run only after the
 * second tap of a ConfirmButton (or a plain fix the host already treats as idempotent), a waive is
 * one reversible tap.
 */
import { DEFAULT_CONTEXT_LIMITS, remedyPrompt } from "@waterplane/shared";
import type { EvidenceRoute, Finding, FindingScope, RemedyFacts, RepoTarget } from "@waterplane/shared";
import { api } from "../../api";
import type { SendSeed } from "../../sendIntent";
import { aimEvidence, armStep, core, featureSheetId, isExtensionEnabled } from "../../sdk";
import { REMEDY_NEEDS_REPO } from "../../setupCheckWords";
import { doorRepoId, landingScope, menuAim, waiveBody, type SetupCheckAim, type SetupCheckView } from "./logic";
import { setupCheckAim } from "./store";

const primaryIds = (): string[] => core().world.repos.filter((r) => r.isPrimary).map((r) => r.id);

/**
 * **The sheet's own Back steps.** All repos → a rule's repos → a repo (or this machine) is a drill-down,
 * and each level is ONE step Back undoes (`armStep`: a history entry above the sheet). They are armed
 * HERE, at the tap, not by the sheet while it is mounted: an evidence door opened over a drilled card
 * unmounts the sheet, and a step that died with it sent the Back from the door one level too far down.
 * A step's `close` runs when a Back (gesture or arrow) pops it; `disarm` takes it away by a tap.
 * A scope switch among this repo / this machine / account is NOT a step — a view, as the regions of
 * Repo readings and the segments of the usage sheet are — but leaving the overview for one is.
 */
const steps: { rule: (() => void) | null; card: (() => void) | null } = { rule: null, card: null };
function arm(slot: "rule" | "card", undo: () => void): void {
  if (steps[slot]) return;
  steps[slot] = armStep(() => { steps[slot] = null; undo(); });
}
function disarm(slot: "rule" | "card"): void {
  const retire = steps[slot];
  steps[slot] = null;
  retire?.();
}
const forgetSteps = (): void => { steps.rule = null; steps.card = null; };

/** Open the sheet on a repo (or none), on a scope, optionally cut to what the repo badge counts. */
export function openSetupCheck(repoId: string | null, aim: { scope?: FindingScope; weight?: "finding"; screen?: string } = {}): void {
  forgetSteps();
  const next: SetupCheckAim = { repoId, scope: landingScope(aim.scope, repoId, primaryIds().length, !!(aim.weight || aim.screen)), ...(aim.weight ? { weight: "finding" as const } : {}), ...(aim.screen ? { screen: aim.screen } : {}) };
  setupCheckAim.set(next);
  core().nav.open("setupcheck");
}

/** The main menu's `setup check` line: needs no repo. All repos with two or more, else this repo, else this machine. */
export function openSetupCheckFromMenu(): void {
  forgetSteps();
  setupCheckAim.set(menuAim(primaryIds()));
  core().nav.open("setupcheck");
}

export function closeSetupCheck(): void {
  setupCheckAim.set({ repoId: null, scope: "repo" });
  core().nav.close("setupcheck");
}

const patch = (p: Partial<SetupCheckAim>) => setupCheckAim.set({ ...setupCheckAim.get(), ...p });

/** The overview again, its open group untouched. Idempotent: a step closed after the sheet was closed finds nothing to do. */
function toOverview(): void {
  const a = setupCheckAim.get();
  if (a.from !== "all") return;
  const { from: _f, rule: _r, weight: _w, screen: _s, ...rest } = a;
  setupCheckAim.set({ ...rest, scope: "all", repoId: null });
}

/** Drill out of the overview into a repo or this machine: one step, the overview kept under it. */
function drillFromAll(next: Partial<SetupCheckAim>): void {
  const { weight: _w, ...rest } = setupCheckAim.get();
  setupCheckAim.set({ ...rest, ...next, from: "all" });
  arm("card", toOverview);
}

/** The scope chips. Leaving the overview is a drill (Back returns to it); among the other scopes it is a view, no step. */
export const setScope = (scope: SetupCheckView): void => {
  const a = setupCheckAim.get();
  if (scope === "all") {
    if (a.from === "all") leaveDrill();
    else { const { from: _f, rule: _r, screen: _s, ...rest } = a; setupCheckAim.set({ ...rest, scope: "all", repoId: null }); }
    return;
  }
  // "this repo" from the overview with no repo yet: the first primary repo, so the chip lands on something.
  const repoId = scope === "repo" && !a.repoId ? primaryIds()[0] ?? null : a.repoId;
  if (a.scope === "all") { drillFromAll({ scope, repoId }); return; }
  const { rule: _r, screen: _s, ...rest } = a;
  setupCheckAim.set({ ...rest, scope, repoId });
};
export const setRepo = (repoId: string): void => patch({ repoId });
export const clearCut = (): void => { const { weight: _w, rule: _r, screen: _s, ...rest } = setupCheckAim.get(); setupCheckAim.set(rest); };

/** All repos: list one rule's repos (the count is a control; one step), or clear back to every group. */
export const openRule = (rule: string | undefined): void => {
  if (rule) {
    patch({ openRule: rule });
    arm("rule", () => { const { openRule: _o, ...rest } = setupCheckAim.get(); setupCheckAim.set(rest); });
    return;
  }
  const { openRule: _o, ...rest } = setupCheckAim.get();
  setupCheckAim.set(rest);
  disarm("rule");
};
/** A repo row of the overview: that repo's check, cut to the rule when one is open. */
export function openRepoFromAll(repoId: string, rule?: string): void { drillFromAll({ repoId, scope: "repo", ...(rule ? { rule } : {}) }); }
/** "this machine · N" from the overview. */
export function openMachineFromAll(): void { drillFromAll({ scope: "machine" }); }
/** The sheet's arrow from a drill-down: the same step a Back gesture takes. */
export function leaveDrill(): void { disarm("card"); toOverview(); }
/** The sheet's arrow: undo the step on top (a drilled card, then an open group), else close the sheet. */
export function stepBack(): void {
  const a = setupCheckAim.get();
  if (a.from === "all" && a.scope !== "all") leaveDrill();
  else if (a.scope === "all" && a.openRule) openRule(undefined);
  else closeSetupCheck();
}

const repoOf = (repoId: string | null): RepoTarget | null => (repoId ? core().world.repos.find((r) => r.id === repoId) ?? null : null);

/**
 * The evidence door: the existing screen that holds the proof. Back comes back here — the aim stays
 * in the store until the sheet's own close. The target screen reads the aim (`sdk/evidence.ts`) and
 * lands on the item: a span, a scrolled box, or a cut that says what it hides.
 */
/** Whether a door can land: the permissions door needs its extension on, and a repo to read. */
export const permissionsDoorOn = (): boolean => isExtensionEnabled("permissions");

export function openEvidence(rawRoute: EvidenceRoute, repoId: string | null): void {
  const c = core();
  c.say.track(`action:setupcheck.door.${rawRoute.screen}`);
  // The route names its repo by worktree path; every door below takes the id (see `doorRepoId`).
  const rid = "repoId" in rawRoute ? doorRepoId(c.world.repos, rawRoute.repoId, repoId) : repoId;
  // A route that names a repo this phone does not list opens nothing: it would land on another repo's screen under this one's finding.
  if ("repoId" in rawRoute && rawRoute.repoId && !rid) { c.say.toast("That repo is not in the launcher's list, so this evidence cannot open from here."); return; }
  const route = "repoId" in rawRoute && rid ? { ...rawRoute, repoId: rid } as EvidenceRoute : rawRoute;
  switch (route.screen) {
    case "alwayson": aimEvidence(route); c.nav.openSetup(rid, { region: "agents" }); return;
    case "readings": c.nav.openSetup(rid, { region: route.region }); return;
    case "tokens": aimEvidence(route); c.nav.open("tokens"); return;
    case "skills": {
      // Aim first: the sheet reads it at its first render. A machine-scope route names no repo and lands on All repos.
      aimEvidence(route);
      c.nav.openSkills(rid ?? c.world.activeRepo?.id ?? "", route.repoId ? "repo" : "all");
      return;
    }
    case "context": c.nav.openContext(route.sessionId); return;
    case "file":
      if (!rid) { c.say.toast("That finding names no repo, so its file cannot open from here."); return; }
      c.files.browseTo(rid, route.path, "setupcheck"); return;
    case "permissions": {
      // The engine reads one repo's files; a machine-scope route (user settings) reads through the one on hand.
      const repo = repoOf(rid) ?? c.world.activeRepo ?? null;
      if (!repo) return;
      aimEvidence({ ...route, repoId: repo.worktreePath });
      c.nav.open(featureSheetId("permissions", "main"));
      return;
    }
  }
}

/** A `seed` remedy: the words for the agent, typed into the Send sheet. Sends nothing. */
export function seedRemedy(f: Finding, repoId: string | null): { ok: true } | { ok: false; why: string } {
  if (f.remedy.kind !== "seed") return { ok: false, why: "no prompt" };
  const c = core();
  const repo = repoOf(repoId) ?? c.world.activeRepo ?? c.world.repos.find((r) => r.isPrimary) ?? null;
  if (!repo) return { ok: false, why: REMEDY_NEEDS_REPO };
  const facts = f.remedy.facts;
  const num = (k: string): number | undefined => (typeof facts[k] === "number" ? (facts[k] as number) : undefined);
  const src = facts.warnSource;
  const rf: RemedyFacts = {
    warnChars: num("warnChars") ?? DEFAULT_CONTEXT_LIMITS.maxChars,
    ...(src === "repo" || src === "env" || src === "default" ? { warnSource: src } : {}),
    ...(num("claudeMdChars") !== undefined ? { claudeMdChars: num("claudeMdChars") } : {}),
    ...(num("alwaysOnChars") !== undefined ? { alwaysOnChars: num("alwaysOnChars") } : {}),
    ...(num("skillCount") !== undefined ? { skillCount: num("skillCount") } : {}),
  };
  const prompt = remedyPrompt(f.remedy.prompt, rf).join("\n\n");
  c.say.track("action:setupcheck.remedy");
  const seed: SendSeed = {
    prompts: [prompt],
    target: { kind: "repo", cwd: repo.worktreePath },
    cwdHint: repo.worktreePath,
    repoId: repo.id,
    origin: `From the Setup check — ${f.what.slice(0, 60)}`,
  };
  c.nav.openSend(seed);
  return { ok: true };
}

/** Waive or take back one finding. Answers the host's sentence on refusal. */
export async function waive(id: string, on: boolean, repoId: string | null, reason?: string, via?: "ignore" | "accept" | "none"): Promise<{ ok: true } | { ok: false; error: string }> {
  core().say.track("action:setupcheck.waive");
  try {
    const r = await api.setupCheckWaive(waiveBody(id, on, repoId, reason, via));
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? "the desktop refused" };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

/** A compliance `fix`. A confirm-gated fix carries the token of the report it was drawn from. */
export async function runFix(repoId: string, fixId: string, confirm?: string): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }> {
  core().say.track("action:setupcheck.fix");
  try {
    const r = await api.complianceFix(repoId, [fixId], confirm);
    return r.ok ? { ok: true, notes: r.notes ?? [] } : { ok: false, error: r.error || "the fix did not apply" };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

/** A desktop (machine-scope) fix: the host runs it on this desktop and says what it did. */
export async function runHostFix(fixId: string): Promise<{ ok: true; notes: string[] } | { ok: false; error: string }> {
  core().say.track("action:setupcheck.hostfix");
  try {
    const r = await api.hostSetupFix([fixId]);
    return r.ok ? { ok: true, notes: r.notes ?? [] } : { ok: false, error: "the desktop did not apply the fix" };
  } catch (e) {
    return { ok: false, error: `The fix could not reach the desktop: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The efficiency-rules write: the second tap, over the exact bytes the plan was drawn from. */
export async function writeRules(repoId: string, target: string, confirm: string, baseSha: string): Promise<{ ok: true } | { ok: false; error: string }> {
  core().say.track("action:setupcheck.write");
  try {
    const r = await api.efficiencyRulesWrite(repoId, { target, confirm, baseSha });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}
