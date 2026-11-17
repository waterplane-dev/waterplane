/**
 * The Setup check's two routes (`setupcheck/`): the ranked findings with the checked-off and
 * not-checked lists, and the waive.
 */
import { findingCut, repoRollup, repoShown, type RollupInput } from "@waterplane/shared";
import { discoverTargets, findTarget } from "../repos.js";
import { setCheckAccepted, setCheckIgnored } from "../compliance.js";
import { isExposureAccepted } from "../exposure.js";
import { setupPrefsStore } from "../setupprefs.js";
import { waiveRepoFinding } from "../setupcheck/waive.js";
import { invalidateSetupCheck, liveDeps, setupCheckStore } from "../setupcheck/store.js";
import { json, readJson } from "./apiio.js";
import { recordSetupWrite } from "./apijobs.js";
import { route, type ApiEntry } from "./apitable.js";

type Ctx = Parameters<Parameters<typeof route>[2]>[1];
const storeOf = (ctx: Ctx) => setupCheckStore(() => liveDeps({
  root: ctx.root, tokenStats: ctx.tokenStats,
  usage: () => ctx.usageNow?.().usage ?? null,
  billing: () => ctx.usageNow?.().billing?.profile ?? "unknown",
  ...(ctx.health ? { health: (w: string) => ctx.health!.respond(w) } : {}),
  ...(ctx.budgetStanding ? { periods: ctx.budgetStanding } : {}),
  ...(ctx.usageReadings ? { usageReadings: ctx.usageReadings } : {}),
}));

export const SETUP_CHECK_ROUTES: readonly ApiEntry[] = [
  // The all-repos overview: every primary repo's check rolled up into rule groups. Doors only: no
  // remedy and no evidence route is read here. Reads the caches the per-repo route reads; a first
  // sweep that outlasts the wait answers what is in so far with `pending`, `done` of `total`.
  // `hidden` = repo ids the phone hides from its launcher (left out, and counted back).
  route("GET", "/api/setupcheck/repos", async ({ res, url }, ctx) => {
    const hidden = new Set((url.searchParams.get("hidden") || "").split(",").filter(Boolean));
    const targets = (await discoverTargets(ctx.root)).filter((t) => t.isPrimary);
    const shown = targets.filter((t) => !hidden.has(t.id));
    const v = await storeOf(ctx).getAll(shown.map((t) => ({ id: t.id, name: repoShown(t), worktree: t.worktreePath })));
    const inputs: RollupInput[] = shown.flatMap((t): RollupInput[] => {
      const o = v.outcomes.get(t.id);
      if (!o) return v.pending ? [] : [{ repoId: t.id, name: repoShown(t), notChecked: "the sweep has not reached this repo" }];
      return [{ repoId: t.id, name: repoShown(t), ...("doc" in o ? { result: o.doc, at: o.doc.at } : { notChecked: o.why }) }];
    });
    const first = [...v.outcomes.values()].find((o): o is { doc: import("../setupcheck/collect.js").SetupCheckDoc } => "doc" in o);
    json(res, {
      rollup: repoRollup(inputs),
      machine: first ? { count: findingCut(first.doc.findings, { scope: "machine" }).count } : {},
      done: v.done, total: v.total, ...(v.pending ? { pending: true } : {}),
      hidden: targets.length - shown.length, at: v.at || Date.now(),
    });
    return true;
  }),
  // The Setup check: ranked findings, what passed, what could not be checked. Reads the last
  // sweep (never an engine run or a model call in the request); a first sweep that outlasts
  // the wait answers `pending`. No `repo` = this desktop and account only.
  route("GET", "/api/setupcheck", async ({ res, url }, ctx) => {
    const repoId = url.searchParams.get("repo") || "";
    const target = repoId ? await findTarget(ctx.root, repoId) : null;
    if (repoId && !target) return json(res, { error: "unknown repo" }, 404), true;
    const wt = target?.worktreePath ?? ctx.root;
    const store = storeOf(ctx);
    const r = await store.get(wt);
    if ("pending" in r) return json(res, { pending: true, findings: [], passed: [], notChecked: [], absent: [], at: Date.now() }), true;
    const keep = <T extends { scope: string }>(x: T) => target !== null || x.scope !== "repo";
    const d = r.doc;
    json(res, { findings: d.findings.filter(keep), passed: d.passed.filter(keep), notChecked: d.notChecked.filter(keep), absent: d.absent, at: d.at });
    return true;
  }),
  // Waive (or take back) one finding. Machine and account findings live in setupprefs `waived`;
  // a repo finding goes through the ignore or accept it always had, so one switch, one store.
  route("POST", "/api/setupcheck/waive", async ({ req, res }, ctx) => {
    const b = await readJson(req);
    const id = String(b?.id ?? "");
    const waive = b?.waive !== false;
    const reason = typeof b?.reason === "string" ? b.reason : undefined;
    const prefs = setupPrefsStore();
    // A finding the engine marks "no waive" (a failing, non-advisory row) is refused here too, not only hidden on the phone. A take-back is always allowed.
    if (waive) {
      const t = id.startsWith("repo.") ? await findTarget(ctx.root, String(b?.repo ?? "")) : null;
      const got = !id.startsWith("repo.") || t ? await storeOf(ctx).get(t?.worktreePath ?? ctx.root) : null;
      const f = got && "doc" in got ? got.doc.findings.find((x) => x.id === id) : undefined;
      if (f?.waive.via === "none") { json(res, { ok: false, error: "That finding cannot be set aside from here: it has to be fixed." }, 400); return true; }
    }
    let out: { ok: true } | { ok: false; error: string };
    if (id.startsWith("repo.")) {
      const target = await findTarget(ctx.root, String(b?.repo ?? ""));
      if (!target) out = { ok: false, error: "unknown repo" };
      else if (!prefs) out = { ok: false, error: "no setup-preferences store on this host" };
      else {
        // An accept changes the compliance checklist: record the re-run report so the badge moves at once, as the accept route does.
        const accept: typeof setCheckAccepted = (t, req) => {
          const r = setCheckAccepted(t, req);
          if (r.ok) recordSetupWrite(ctx, t, r.report);
          return r;
        };
        const ignore: typeof setCheckIgnored = (t, cid, on) => {
          const r = setCheckIgnored(t, cid, on);
          if (r.ok) recordSetupWrite(ctx, t, r.report);
          return r;
        };
        out = waiveRepoFinding(target, { ignore, accept, isAccepted: (t, cid) => isExposureAccepted(t.worktreePath, cid), prefs }, { id, waive, ...(reason ? { reason } : {}) });
      }
    } else if (!prefs) out = { ok: false, error: "no setup-preferences store on this host" };
    else out = prefs.setWaived(id, waive ? { at: new Date().toISOString(), ...(reason ? { reason } : {}) } : null);
    if (out.ok) invalidateSetupCheck();
    json(res, out, out.ok ? 200 : 400);
    return true;
  }),
];
