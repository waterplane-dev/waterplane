/**
 * **Opt-ins, as this desktop can see them** — one row per offer in the shared
 * catalog (`OPT_INS`), answering "is this already on in this repo?".
 *
 * Offers are NOT findings. A repo without a pre-push hook is not broken, so
 * nothing here touches `compliance.ts`'s checks, the setup badge, `summarize()`
 * or `ComplianceCheck`; `inspectRepo` neither calls this nor learns of it.
 *
 * **Probes are filesystem + local git, cheap and bounded, and never paid:** no
 * network, no model, no gcloud, no spawning the repo's own code. Each `detail`
 * is one sentence naming what was read. A probe that cannot read answers
 * `unknown` with the reason — never a guessed on/off. `gcp-cleanup` is always
 * `unknown`: the registry's policy lives in the cloud and this desktop cannot
 * see it; the person's own word (`choice: "done"`) is how it is closed.
 *
 * The person's word (`declined` / `done`) is stored apart in `setupprefs.ts`
 * and only STAMPED onto the row here; it never changes `state`.
 *
 * `security-review` needs the intent store, which this module must not import:
 * the route hands in `standingPrompts`. `requirements` asks the plugin registry
 * through `setupcontrib.ts` whether its fix is registered.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPT_INS, REPOHEALTH_OWN_FILE, isStandingSchedule, optInMarker, ruleRecurs, type Intent, type OptInRow, type OptInState } from "@waterplane/shared";
import { isAndroidRepo } from "./androidenv.js";
import { repoSharedDir } from "./branddirs.js";
import { captureTargetCount } from "./compliance.js";
import { seriesPathOf } from "./healthwatch.js";
import { contributedFixIds } from "./plugins/setupcontrib.js";
import { canReadRepoHealth } from "./repohealth.js";
import { optInChoices } from "./setupprefs.js";

export interface OptInDeps {
  /** Prompt text of every standing (recurring, live) schedule aimed at this
   *  worktree; `null` = the intent store cannot be read. */
  standingPrompts(worktree: string): string[] | null;
  /** Fix ids registered right now. Defaults to the plugin registry's. */
  fixIds?(): string[];
  /** The person's words. Defaults to the prefs store. */
  choices?(worktree: string): Record<string, "declined" | "done">;
}

const FILE_CAP = 256 * 1024;
const SCAN_FILES = 50;

type Probe = { relevant: boolean; state: OptInState; detail: string };

function read(p: string): string | null {
  try {
    if (statSync(p).size > FILE_CAP) return null;
    return readFileSync(p, "utf8");
  } catch { return null; }
}

function git(wt: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch { return null; }
}

const isGitRepo = (wt: string) => git(wt, ["rev-parse", "--git-dir"]) !== null;

function unfit(detail: string): Probe { return { relevant: false, state: "off", detail }; }

function requirements(wt: string, deps: OptInDeps): Probe {
  const ids = (deps.fixIds ?? contributedFixIds)();
  if (!ids.includes("requirements")) return unfit("The requirements extension is not loaded on this desktop, so the offer cannot be set up.");
  // The extension's own "set up" rule (`isSetUp`): its skill file or its build state.
  const skill = ".claude/skills/requirements/SKILL.md";
  const state = "docs/requirements/.state.json";
  if (existsSync(join(wt, skill))) return { relevant: true, state: "on", detail: `${skill} exists.` };
  if (existsSync(join(wt, state))) return { relevant: true, state: "on", detail: `${state} exists.` };
  return { relevant: true, state: "off", detail: `Neither ${skill} nor ${state} exists.` };
}

function repoHealth(wt: string): Probe {
  if (!canReadRepoHealth(wt)) return unfit("No repo-health engine is available for this repo on this desktop.");
  const p = seriesPathOf(wt);
  return p
    ? { relevant: true, state: "on", detail: `A measured series exists (${p.slice(wt.length + 1)}).` }
    : { relevant: true, state: "off", detail: "No series file has been written yet; nothing has been measured." };
}

function repoHealthOwn(wt: string): Probe {
  if (!canReadRepoHealth(wt)) return unfit("No repo-health engine is available for this repo on this desktop.");
  const rel = REPOHEALTH_OWN_FILE;
  const onDisk = existsSync(join(repoSharedDir(wt), "health.json"));
  const committed = git(wt, ["show", `HEAD:${rel}`]);
  if (committed === null) {
    if (!isGitRepo(wt)) return { relevant: true, state: "unknown", detail: `${rel} could not be read from git: this is not a git repo.` };
    return onDisk
      ? { relevant: true, state: "off", detail: `${rel} is written but not committed, and only committed readings run.` }
      : { relevant: true, state: "off", detail: `${rel} does not exist at HEAD.` };
  }
  try {
    const o = JSON.parse(committed) as { readings?: unknown };
    if (Array.isArray(o?.readings) && o.readings.length > 0) {
      return { relevant: true, state: "on", detail: `${rel} is committed at HEAD with ${o.readings.length} reading${o.readings.length === 1 ? "" : "s"}.` };
    }
    return { relevant: true, state: "off", detail: `${rel} is committed at HEAD but declares no readings.` };
  } catch {
    return { relevant: true, state: "unknown", detail: `${rel} at HEAD is not valid JSON, so its readings could not be counted.` };
  }
}

function securityReview(wt: string, deps: OptInDeps): Probe {
  const marker = optInMarker("security-review");
  const prompts = deps.standingPrompts(wt);
  if (prompts === null) return { relevant: true, state: "unknown", detail: "The schedule store could not be read, so a standing review could not be looked for." };
  return prompts.some((t) => t.includes(marker))
    ? { relevant: true, state: "on", detail: "A recurring schedule in this repo carries the security-review marker." }
    : { relevant: true, state: "off", detail: "No recurring schedule in this repo carries the security-review marker." };
}

function localCi(wt: string): Probe {
  if (!isGitRepo(wt)) return unfit("This is not a git repo, so there is no push to check.");
  const hooksPath = git(wt, ["config", "core.hooksPath"]);
  if (hooksPath) {
    const dir = hooksPath.startsWith("/") ? hooksPath : join(wt, hooksPath);
    if (existsSync(join(dir, "pre-push"))) return { relevant: true, state: "on", detail: `core.hooksPath (${hooksPath}) contains a pre-push hook.` };
  }
  const gp = git(wt, ["rev-parse", "--git-path", "hooks"]);
  if (gp && existsSync(join(gp.startsWith("/") ? gp : join(wt, gp), "pre-push"))) {
    return { relevant: true, state: "on", detail: "The git hooks directory contains a pre-push hook." };
  }
  if (existsSync(join(wt, ".husky", "pre-push"))) return { relevant: true, state: "on", detail: ".husky/pre-push exists." };
  for (const f of ["lefthook.yml", "lefthook.yaml"]) {
    if ((read(join(wt, f)) ?? "").includes("pre-push")) return { relevant: true, state: "on", detail: `${f} configures a pre-push hook.` };
  }
  if ((read(join(wt, ".pre-commit-config.yaml")) ?? "").includes("pre-push")) {
    return { relevant: true, state: "on", detail: ".pre-commit-config.yaml mentions pre-push." };
  }
  return { relevant: true, state: "off", detail: "No pre-push hook found in the git hooks, .husky, lefthook or pre-commit config." };
}

function npmSupplyChain(wt: string): Probe {
  if (!existsSync(join(wt, "package.json"))) return unfit("There is no package.json at the root.");
  const rc = read(join(wt, ".npmrc"));
  if (rc === null) return { relevant: true, state: "off", detail: existsSync(join(wt, ".npmrc")) ? ".npmrc is too large to read." : "There is no root .npmrc." };
  const lines = rc.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith(";"));
  const val = (k: string) => {
    for (const l of lines) {
      const m = /^([^=\s]+)\s*=\s*(.*)$/.exec(l);
      if (m && m[1].replace(/_/g, "-") === k) return m[2].trim();
    }
    return null;
  };
  const scripts = val("ignore-scripts") === "true";
  const age = val("min-release-age") !== null;
  if (scripts && age) return { relevant: true, state: "on", detail: "The root .npmrc sets ignore-scripts=true and min-release-age." };
  const missing = [!scripts && "ignore-scripts=true", !age && "min-release-age"].filter(Boolean).join(" and ");
  return { relevant: true, state: "off", detail: `The root .npmrc is missing ${missing}.` };
}

const DEPLOY_RE = /gcloud\s+(run\s+deploy|builds\s+submit|artifacts)/;

function gcpCleanup(wt: string): Probe {
  const found: string[] = [];
  for (const f of ["cloudbuild.yaml", "cloudbuild.json"]) if (existsSync(join(wt, f))) found.push(f);
  const files = ["package.json", "Makefile"];
  try {
    for (const n of readdirSync(join(wt, "scripts"), { withFileTypes: true })) {
      if (n.isFile() && files.length < SCAN_FILES) files.push(`scripts/${n.name}`);
    }
  } catch { /* no scripts dir */ }
  for (const f of files) {
    const t = read(join(wt, f));
    if (t && DEPLOY_RE.test(t)) found.push(f);
  }
  if (!found.length) return unfit("No sign of a Google Cloud deploy (cloudbuild file, or gcloud run deploy / builds submit in package.json, Makefile or scripts/).");
  return { relevant: true, state: "unknown", detail: `Deploys to Google Cloud (found in ${found.join(", ")}); this desktop cannot see the registry's cleanup policy, so say when it is done.` };
}

const WEB_DEPS = ["vite", "next", "react", "vue", "svelte", "@angular/core"];

function screenshots(wt: string): Probe {
  let web = false;
  const pkg = read(join(wt, "package.json"));
  if (pkg) {
    try {
      const o = JSON.parse(pkg) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      const names = Object.keys({ ...(o.dependencies ?? {}), ...(o.devDependencies ?? {}) });
      web = names.some((n) => WEB_DEPS.includes(n) || n.startsWith("@capacitor/"));
    } catch { /* unreadable package.json is not a web app */ }
  }
  let android = false;
  try { android = isAndroidRepo(wt); } catch { /* not readable */ }
  if (!web && !android) return unfit("Neither a web app dependency in package.json nor an Android project was found.");
  const n = captureTargetCount(wt);
  return n > 0
    ? { relevant: true, state: "on", detail: `${n} capture target${n === 1 ? "" : "s"} configured.` }
    : { relevant: true, state: "off", detail: "No capture targets are configured." };
}

/** One row per catalog entry, in catalog order. Never throws: a probe that does becomes `unknown`. */
export function inspectOptIns(worktree: string, deps: OptInDeps): OptInRow[] {
  const choices = (deps.choices ?? optInChoices)(worktree);
  const probes: Record<string, () => Probe> = {
    "requirements": () => requirements(worktree, deps),
    "repo-health": () => repoHealth(worktree),
    "repo-health-own": () => repoHealthOwn(worktree),
    "security-review": () => securityReview(worktree, deps),
    "local-ci": () => localCi(worktree),
    "npm-supply-chain": () => npmSupplyChain(worktree),
    "gcp-cleanup": () => gcpCleanup(worktree),
    "screenshots": () => screenshots(worktree),
  };
  return OPT_INS.map((d) => {
    let p: Probe;
    try { p = probes[d.id]?.() ?? { relevant: false, state: "unknown", detail: "This desktop has no probe for this offer." }; }
    catch (err) { p = { relevant: true, state: "unknown", detail: `The probe failed: ${err instanceof Error ? err.message : String(err)}` }; }
    const row: OptInRow = { id: d.id, ...p };
    const c = choices[d.id];
    if (c) row.choice = c;
    return row;
  });
}

function realOf(p: string): string { try { return realpathSync(p); } catch { return p; } }

/** The prompt texts of the live recurring schedules whose cwd is `worktree` — the route's `standingPrompts`. */
export function standingPromptsOf(intents: readonly Intent[], worktree: string, now = Date.now()): string[] {
  const wt = realOf(worktree);
  const out: string[] = [];
  for (const i of intents) {
    if (i.archived || i.payload.kind !== "prompt" || i.trigger.kind !== "at") continue;
    if (!ruleRecurs(i.trigger.rule) || !isStandingSchedule({ rule: i.trigger.rule, nextAt: i.nextAt, lastOccurrence: i.lastOccurrence }, now)) continue;
    if (realOf(i.cwd) !== wt) continue;
    out.push(i.payload.steps.join("\n"));
  }
  return out;
}
