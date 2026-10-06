/**
 * The first-app onboarding job (`docs/analysis/first-app-plan.md`, WP6): three answers and one
 * consent screen become a repo, a build the phone can hold, and a session in the new repo.
 *
 * The rules this module holds:
 *
 *  - **Deterministic steps are host steps.** Probe, toolchain, scaffold, signing key, setup
 *    checklist and the first build are pieces that already exist (`androidenv.ts`, `toolchain.ts`,
 *    `scaffold.ts`, `signkey.ts`, `compliance.ts`, `builds.ts`); this file only orders them. The
 *    agent's part starts after the first build: the session, with the person's description as its
 *    first prompt.
 *  - **One job, persisted, resumable.** The job and every step's state are written
 *    (`<STATE_DIR>/onboard.json`, tmp+rename) on every transition. A host restart mid-run
 *    resumes at the first step not yet done; every step is idempotent, so re-running the one that
 *    was interrupted finds what it already made (a toolchain is FOUND, a folder with a `.git` is
 *    adopted, a key is linked again, a finished build run is read back, the session's intent id is
 *    at-most-once in the store).
 *  - **Nothing outside the consent.** The start is refused unless every line the plan marks
 *    `required` was ticked; a step whose consent is missing at run time stops at `needs-consent`
 *    instead of acting. Licence acceptance is the toolchain tick and nothing else.
 *  - **Never sudo, never silent.** A step that needs the person stops at `needs-you` with the
 *    command; a failed step says why and how to do it by hand.
 *  - **The first prompt goes through the store.** A description is posted as a launch intent (the
 *    path a parked `session.create` takes: `sessions.create` + `startPrompt` via `deliver.ts`),
 *    keyed by the job id, so a resumed job cannot type it twice.
 *
 * Everything that touches the machine is `OnboardDeps`, so the tests run the whole job on fakes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  BRAND, CONFIRM_GATED_FIXES, androidToolchainConsent, SIGNING_KEY_CONSENT,
  type BuildConfig, type Intent, type IntentDraft, type RepoTarget, type BuildRun, type OnboardAnswers, type OnboardConsent, type OnboardConsentLine,
  type OnboardJob, type OnboardPath, type OnboardPlan, type OnboardStep, type OnboardStepId, type OnboardStepStatus,
} from "@waterplane/shared";
import { probeAndroidEnv, type AndroidEnvReport } from "./androidenv.js";
import { TOOLCHAIN_LICENCE_URL, planToolchain, realToolchainDeps, startToolchainInstall, type ToolchainPlan, type ToolchainResult } from "./toolchain.js";
import { ensureDesktopKey, findKey, keysDir, linkKey, type EnsureResult, type LinkResult } from "./signkey.js";
import { newRepo, packageId, templateName, type NewRepoOpts, type NewRepoResult, type TemplateId } from "./scaffold.js";
import { checkRepoCompliance, fixRepoCompliance } from "./compliance.js";
import { targetId } from "./repos.js";
import { createToIntent, intentToBuildRun } from "./intents/adapters.js";
import { writeTextAtomic } from "./jsonstore.js";

/** Cold Gradle build measured in WP1: 323 s. Said up front so the wait is explained. */
export const ANDROID_FIRST_BUILD_WORDS = "First build: the slow one, about 5 minutes (Gradle fetches its own dependencies once; later builds take seconds)";
/** How long the job waits on a build before it stops waiting (the build itself keeps running). */
export const BUILD_WAIT_MS = 30 * 60_000;
/** How long the session step waits for the store to open the session before it reports the intent. */
export const SESSION_WAIT_MS = 60_000;

export const SUGGESTED_PROMPT: Record<OnboardPath, string> = {
  android: "Make the button count taps and show a confetti burst.",
  web: "Add a confetti burst on every tenth tap, and show the best streak of this visit.",
};

const TEMPLATE: Record<OnboardPath, TemplateId> = { android: "android-hello", web: "web-hello" };
const STEPS: Record<OnboardPath, OnboardStepId[]> = {
  android: ["probe", "toolchain", "scaffold", "signing-key", "setup", "build", "session"],
  web: ["scaffold", "setup", "build", "session"],
};
const STOP: ReadonlySet<OnboardStepStatus> = new Set(["failed", "needs-you", "needs-consent"]);

export interface OnboardDeps {
  root: string;
  /**
   * The desktop's home folder, for WORDS only: a path under it is said `~/dev/hello-otter`, the
   * way a terminal says it, instead of the full `/Users/<name>/…` a phone row wraps three times.
   * Never used to decide anything — `folder` and every path the job acts on stay absolute.
   */
  home?: string;
  now(): number;
  /** The persisted job (null when none) and its writer. */
  readState(): string | null;
  writeState(text: string): void;
  /** A job transition, for the socket. */
  emit(job: OnboardJob): void;
  /** The host's own environment (is `JAVA_HOME` / `ANDROID_HOME` already set for builds?). */
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
  sleep(ms: number): Promise<void>;

  probe(): AndroidEnvReport;
  planToolchain(r: AndroidEnvReport): ToolchainPlan;
  runToolchain(opts: { acceptLicences: boolean }): Promise<ToolchainResult>;

  /** Is the desktop key there (and is it intact)? */
  key(): { exists: boolean; broken: boolean; jks: string; dir: string };
  ensureKey(opts: { keytool?: string }): EnsureResult;
  linkKey(repo: string): LinkResult;

  newRepo(root: string, parent: string, name: string, opts: NewRepoOpts): Promise<NewRepoResult | { error: string }>;
  repoId(dir: string): string;
  /** The setup checklist's one-tap fixes (never the confirm-gated ones), applied. */
  setup(repoDir: string): { ok: boolean; applied: string[]; notes: string[]; error?: string };

  builds: {
    list(repoDir: string): BuildConfig[];
    save(repoDir: string, builds: BuildConfig[]): BuildConfig[];
    run(repoDir: string, buildId: string): BuildRun | { error: string };
    /** The run as the store holds it now, or null when it is unknown. */
    get(runId: string): BuildRun | null;
  };
  /**
   * Open the session in the new repo. With `prompt`, through the intent store under `intentId`
   * (at-most-once); without, adopt a live session in `repoDir` or create one.
   */
  openSession(o: { repoDir: string; title: string; prompt?: string; intentId: string }): Promise<{ sessionId?: string; intentId?: string; note: string } | { error: string }>;
}

// ---------------------------------------------------------------------------------------------
// Plan (read-only)

function cleanAnswers(raw: unknown): OnboardAnswers | { error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const path = r.path === "android" || r.path === "web" ? r.path : null;
  if (!path) return { error: "choose a phone app (android) or a web page (web)" };
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return { error: "the app needs a name" };
  const description = typeof r.description === "string" && r.description.trim() ? r.description.trim().slice(0, 2000) : undefined;
  return { name, path, ...(description ? { description } : {}), setup: r.setup !== false };
}

function stepWords(d: OnboardDeps, id: OnboardStepId, a: OnboardAnswers, folder: string, tplan: ToolchainPlan | null): string {
  switch (id) {
    case "probe": return "Look for a JDK and the Android SDK on this desktop";
    case "toolchain": {
      const todo = tplan?.steps.filter((s) => s.needed).map((s) => s.what) ?? [];
      return todo.length ? `Install the Android build tools: ${todo.join("; ")}` : "Android build tools: already on this desktop";
    }
    case "scaffold": return `Create ${folder} from the ${TEMPLATE[a.path]} template, with a git repo`;
    case "signing-key": {
      const k = d.key();
      return k.exists ? `Link the desktop signing key (${k.jks}) into the new repo` : `Create the desktop signing key in ${k.dir} (mode 600) and link it into the new repo`;
    }
    case "setup": return a.setup === false ? "Setup checklist: you turned it off" : `Set the repo up for ${BRAND.displayName} (the setup checklist's one-tap fixes)`;
    case "build": return a.path === "android" ? ANDROID_FIRST_BUILD_WORDS : "Build the page into the outbox (a second or so)";
    case "session": return a.description ? "Open a claude session in the new repo and send your description as its first prompt" : "Open a claude session in the new repo";
  }
}

/** `text` with every path under `home` said from `~`. Display only (see `OnboardDeps.home`). */
export function tildeText(text: string, home: string | undefined): string {
  const h = home?.replace(/\/+$/, "");
  if (!h) return text; // unset, or `/` itself: nothing to shorten
  return text === h ? "~" : text.split(h + "/").join("~/");
}

/** What applies on this desktop for these answers, and the consent lines. Writes nothing. */
export function planOnboard(raw: unknown, d: OnboardDeps): OnboardPlan {
  const plan = planRaw(raw, d);
  const t = (x: string) => tildeText(x, d.home);
  return {
    ...plan,
    ...(plan.error ? { error: t(plan.error) } : {}),
    steps: plan.steps.map((s) => ({ ...s, what: t(s.what) })),
    consent: plan.consent.map((l) => ({ ...l, what: t(l.what), ...(l.where ? { where: t(l.where) } : {}) })),
  };
}

function planRaw(raw: unknown, d: OnboardDeps): OnboardPlan {
  const a = cleanAnswers(raw);
  const pathGuess: OnboardPath = (raw as { path?: unknown })?.path === "web" ? "web" : "android";
  const empty = (error: string, name = "", folder = ""): OnboardPlan => ({
    ok: false, error, path: pathGuess, name, folder, steps: [], consent: [], suggestedPrompt: SUGGESTED_PROMPT[pathGuess],
  });
  if ("error" in a) return empty(a.error);
  const n = templateName(a.name);
  if ("error" in n) return empty(n.error);
  const folder = join(d.root, n.name);
  if (d.exists(folder)) return empty(`${folder} already exists; choose another name`, n.name, folder);

  let tplan: ToolchainPlan | null = null;
  const consent: OnboardConsentLine[] = [
    { id: "repo", what: `Create ${folder} and a git repo in it`, where: folder, required: true },
  ];
  const needed: Partial<Record<OnboardStepId, boolean>> = {};
  if (a.path === "android") {
    const r = d.probe();
    tplan = d.planToolchain(r);
    const toolchainNeeded = tplan.steps.some((s) => s.needed);
    needed.toolchain = toolchainNeeded;
    if (toolchainNeeded) {
      consent.push({
        id: "toolchain",
        what: `${androidToolchainConsent(tplan.installBytes)}. ${tplan.consent}`,
        where: tplan.jdkRoute === "brew" && tplan.steps.find((s) => s.id === "jdk")?.needed ? `brew (openjdk@21) and ${tplan.sdkRoot}` : `${tplan.jdkDir} and ${tplan.sdkRoot}`,
        bytes: tplan.installBytes,
        link: TOOLCHAIN_LICENCE_URL,
        required: true,
      });
    }
    const k = d.key();
    if (k.broken) return empty(`${k.jks} exists without its properties file (its password is lost); restore it or move it aside first`, n.name, folder);
    needed["signing-key"] = !k.exists;
    if (!k.exists) consent.push({ id: "signingKey", what: SIGNING_KEY_CONSENT, where: k.dir, required: true });
    consent.push({
      id: "installApps",
      what: `Let this phone install apps ${BRAND.displayName} builds (${packageId(n.name)}); Android asks once for the first install`,
      required: false, phone: true,
    });
  }
  consent.push({
    id: "session",
    what: a.description ? `Run claude in ${folder} and send your description as its first prompt` : `Run claude in ${folder} (the same as any session)`,
    where: folder, required: false,
  });
  const steps = STEPS[a.path].map((id) => ({
    id, needed: id === "setup" ? a.setup !== false : needed[id] ?? true,
    what: stepWords(d, id, a, folder, tplan),
  }));
  return {
    ok: true, path: a.path, name: n.name, folder,
    ...(a.path === "android" ? { packageId: packageId(n.name) } : {}),
    steps, consent,
    ...(a.description ? { firstPrompt: a.description } : {}),
    suggestedPrompt: SUGGESTED_PROMPT[a.path],
  };
}

/** The consent line ids the plan requires that were not ticked. */
export function missingConsent(plan: OnboardPlan, c: OnboardConsent): string[] {
  return plan.consent.filter((l) => l.required && c[l.id] !== true).map((l) => l.id);
}

// ---------------------------------------------------------------------------------------------
// The job

type StepOutcome = { status: OnboardStepStatus; note: string; command?: string };

export class OnboardManager {
  private job: OnboardJob | null = null;
  private running: Promise<void> | null = null;

  constructor(private d: OnboardDeps) {
    try {
      const j = JSON.parse(d.readState() ?? "null") as OnboardJob | null;
      if (j && typeof j === "object" && typeof j.id === "string" && Array.isArray(j.steps)) this.job = j;
    } catch { /* an unreadable state file is no job */ }
  }

  current(): OnboardJob | null { return this.job; }

  /** `GET /api/onboard/plan`: read-only. */
  plan(rawAnswers: unknown): OnboardPlan { return planOnboard(rawAnswers, this.d); }

  /** After a host restart: a job that was running carries on from the first step not done. */
  boot(): boolean {
    if (this.job?.state !== "running" || this.running) return false;
    this.kick();
    return true;
  }

  /** Refused in words, or the job (already running in the background). */
  start(rawAnswers: unknown, rawConsent: unknown): { ok: true; job: OnboardJob } | { ok: false; error: string; missing?: string[]; status: number } {
    if (this.running || this.job?.state === "running") return { ok: false, error: "an onboarding job is already running", status: 409 };
    const plan = planOnboard(rawAnswers, this.d);
    if (!plan.ok) return { ok: false, error: plan.error ?? "cannot start", status: 400 };
    const consent = cleanConsent(rawConsent);
    const missing = missingConsent(plan, consent);
    if (missing.length) {
      const words = plan.consent.filter((l) => missing.includes(l.id)).map((l) => l.what.split(". ")[0]);
      return { ok: false, status: 400, missing, error: `not consented, so nothing was started: ${words.join("; ")}` };
    }
    const answers = cleanAnswers(rawAnswers) as OnboardAnswers;
    const now = this.d.now();
    const steps: OnboardStep[] = plan.steps.map((s) => ({ id: s.id, status: "pending", what: s.what }));
    this.job = {
      id: `onb_${randomUUID().slice(0, 8)}`, state: "running", answers, consent,
      name: plan.name, folder: plan.folder, ...(plan.packageId ? { packageId: plan.packageId } : {}),
      steps, suggestedPrompt: plan.suggestedPrompt, summary: "starting", createdAt: now, updatedAt: now,
    };
    this.save();
    this.kick();
    return { ok: true, job: this.job };
  }

  /** Carry on a stopped job (after the person ran the command, or ticked what was missing). */
  resume(rawConsent: unknown): { ok: true; job: OnboardJob } | { ok: false; error: string; status: number } {
    const j = this.job;
    if (!j) return { ok: false, error: "there is no onboarding job to resume", status: 404 };
    if (this.running) return { ok: false, error: "the onboarding job is already running", status: 409 };
    if (j.state === "done") return { ok: false, error: "that onboarding job already finished", status: 409 };
    // Consent only ever GROWS on a resume: a tick added now covers the step that asked for it.
    const add = cleanConsent(rawConsent);
    for (const k of Object.keys(add) as Array<keyof OnboardConsent>) if (add[k] === true) j.consent[k] = true;
    for (const s of j.steps) if (STOP.has(s.status)) { s.status = "pending"; delete s.command; }
    j.state = "running";
    this.save();
    this.kick();
    return { ok: true, job: j };
  }

  /** Resolves when the background run settles (tests; the routes never wait). */
  idle(): Promise<void> { return this.running ?? Promise.resolve(); }

  private kick(): void {
    if (this.running) return;
    const p = this.run().catch((e) => {
      const j = this.job;
      if (!j) return;
      const s = j.steps.find((x) => x.status === "running");
      if (s) { s.status = "failed"; s.note = String((e as Error)?.message || e).slice(0, 300); s.endedAt = this.d.now(); }
      j.state = "stopped";
      j.summary = `Stopped: ${s?.note ?? "an unexpected error"}`;
      this.save();
    }).finally(() => { this.running = null; });
    this.running = p;
  }

  private save(): void {
    const j = this.job;
    if (!j) return;
    j.updatedAt = this.d.now();
    try { this.d.writeState(JSON.stringify(j)); } catch { /* the emit still tells the phone */ }
    this.d.emit(structuredClone(j));
  }

  private async run(): Promise<void> {
    const j = this.job;
    if (!j) return;
    for (const step of j.steps) {
      if (step.status === "done" || step.status === "skipped") continue;
      step.status = "running";
      step.startedAt = this.d.now();
      delete step.note; delete step.command;
      j.summary = step.what;
      this.save();
      const out = await this.exec(step.id, j);
      step.status = out.status;
      step.note = tildeText(out.note, this.d.home);
      if (out.command) step.command = out.command;
      step.endedAt = this.d.now();
      if (STOP.has(out.status)) {
        j.state = "stopped";
        j.summary = `Stopped at ${step.id}: ${step.note}${out.command ? ` Run: ${out.command}` : ""}`;
        this.save();
        return;
      }
      this.save();
    }
    j.state = "done";
    j.summary = j.artifact
      ? `Ready: ${j.artifact}${j.sessionId || j.intentId ? ", and a session is open in the new repo" : ""}`
      : "Ready.";
    this.save();
  }

  private exec(id: OnboardStepId, j: OnboardJob): Promise<StepOutcome> {
    switch (id) {
      case "probe": return Promise.resolve(this.probeStep());
      case "toolchain": return this.toolchainStep(j);
      case "scaffold": return this.scaffoldStep(j);
      case "signing-key": return Promise.resolve(this.keyStep(j));
      case "setup": return Promise.resolve(this.setupStep(j));
      case "build": return this.buildStep(j);
      case "session": return this.sessionStep(j);
    }
  }

  private probeStep(): StepOutcome {
    const r = this.d.probe();
    const have = [r.jdk ? `JDK ${r.jdk.major ?? "?"} at ${r.jdk.home}` : null, r.sdk ? `SDK at ${r.sdk.root}` : null].filter(Boolean);
    return { status: "done", note: [have.length ? `Found ${have.join(", ")}.` : "Found no JDK and no Android SDK.", r.summary ?? ""].filter(Boolean).join(" ") };
  }

  private async toolchainStep(j: OnboardJob): Promise<StepOutcome> {
    const plan = this.d.planToolchain(this.d.probe());
    if (!plan.steps.some((s) => s.needed)) return { status: "skipped", note: "the JDK and the Android SDK are already here" };
    if (j.consent.toolchain !== true) return { status: "needs-consent", note: "installing the Android build tools (and accepting the SDK licence) was not consented" };
    const r = await this.d.runToolchain({ acceptLicences: true });
    if (r.ok) return { status: "done", note: r.summary };
    const bad = r.steps.find((s) => STOP.has(s.status as OnboardStepStatus));
    if (bad?.status === "needs-you") return { status: "needs-you", note: bad.note, ...(bad.command ? { command: bad.command } : {}) };
    if (bad?.status === "needs-consent") return { status: "needs-consent", note: bad.note };
    return { status: "failed", note: bad ? `${bad.id}: ${bad.note}` : r.summary };
  }

  private async scaffoldStep(j: OnboardJob): Promise<StepOutcome> {
    // Idempotent: a folder this job already made (or made before a restart cut it off) is adopted.
    if (this.d.exists(join(j.folder, ".git"))) {
      j.repoDir = j.folder; j.repoId = this.d.repoId(j.folder);
      return { status: "done", note: `${j.folder} is already there (made by this job), kept as it is` };
    }
    const r = await this.d.newRepo(this.d.root, this.d.root, j.name, {
      template: TEMPLATE[j.answers.path], ...(j.answers.description ? { description: j.answers.description } : {}),
    });
    if ("error" in r) return { status: "failed", note: `could not create the repo: ${r.error}` };
    j.repoDir = r.path; j.repoId = this.d.repoId(r.path);
    return { status: "done", note: `created ${r.path} (${r.files.length} files, branch ${r.branch})${r.warning ? `. ${r.warning}` : ""}` };
  }

  private keyStep(j: OnboardJob): StepOutcome {
    if (!j.repoDir) return { status: "failed", note: "no repo to link the key into" };
    const k = this.d.key();
    if (!k.exists && j.consent.signingKey !== true) return { status: "needs-consent", note: "creating the desktop signing key was not consented" };
    // keytool from the JDK the probe found (possibly the one just installed, not on PATH).
    const jdk = this.d.probe().jdk;
    const kt = jdk ? join(jdk.home, "bin", "keytool") : null;
    const made = this.d.ensureKey(kt && this.d.exists(kt) ? { keytool: kt } : {});
    if (!made.ok) return { status: "failed", note: made.error, command: `keytool -genkeypair -keystore ${k.jks} -storetype PKCS12 -alias sideload -keyalg RSA -keysize 2048 -validity 36500` };
    const linked = this.d.linkKey(j.repoDir);
    if (!linked.ok) return { status: "failed", note: linked.error };
    return { status: "done", note: `${made.note}; ${linked.note}` };
  }

  private setupStep(j: OnboardJob): StepOutcome {
    if (j.answers.setup === false) return { status: "skipped", note: "you turned the setup checklist off" };
    if (!j.repoDir) return { status: "failed", note: "no repo to set up" };
    const r = this.d.setup(j.repoDir);
    if (!r.ok) return { status: "failed", note: r.error ?? "the setup checklist could not run" };
    return { status: "done", note: r.applied.length ? `applied ${r.applied.join(", ")}` : "nothing left to fix: the template is already set up" };
  }

  /**
   * Point an Android build at the toolchain the probe found, when the host's own environment
   * would not: `sdk.dir` in the repo's gitignored `local.properties`, and `JAVA_HOME` prefixed
   * onto the repo's (gitignored, per-desktop) build commands. Both only ADD; idempotent.
   */
  private bindToolchain(repoDir: string): string[] {
    const notes: string[] = [];
    const r = this.d.probe();
    if (!this.d.env.ANDROID_HOME && !this.d.env.ANDROID_SDK_ROOT && r.sdk) {
      const lp = join(repoDir, "local.properties");
      const cur = this.d.readText(lp) ?? "";
      if (!/^\s*sdk\.dir\s*=/m.test(cur)) {
        this.d.writeText(lp, `${cur && !cur.endsWith("\n") ? cur + "\n" : cur}sdk.dir=${r.sdk.root}\n`);
        notes.push(`sdk.dir=${r.sdk.root} in local.properties`);
      }
    }
    if (!this.d.env.JAVA_HOME && r.jdk) {
      const list = this.d.builds.list(repoDir);
      const prefix = `JAVA_HOME='${r.jdk.home.replace(/'/g, "'\\''")}' `;
      let changed = false;
      const next = list.map((b) => (/^\.\/gradlew\b/.test(b.cmd) ? (changed = true, { ...b, cmd: prefix + b.cmd }) : b));
      if (changed) { this.d.builds.save(repoDir, next); notes.push(`JAVA_HOME=${r.jdk.home} on the build commands`); }
    }
    return notes;
  }

  private async buildStep(j: OnboardJob): Promise<StepOutcome> {
    if (!j.repoDir) return { status: "failed", note: "no repo to build" };
    const repoDir = j.repoDir;
    // A run this job already started (before a restart) is read back, never started twice
    // while it is still going; a finished one is taken as it ended, a failed one is re-run.
    let run = j.buildRunId ? this.d.builds.get(j.buildRunId) : null;
    if (run && run.status === "done") return this.built(j, run);
    const bound = j.answers.path === "android" ? this.bindToolchain(repoDir) : [];
    if (!run || run.status !== "running") {
      const list = this.d.builds.list(repoDir);
      const cfg = list.find((b) => b.id === (j.answers.path === "android" ? "release" : "publish")) ?? list[0];
      if (!cfg) return { status: "failed", note: "the new repo has no build configured" };
      const started = this.d.builds.run(repoDir, cfg.id);
      if ("error" in started) return { status: "failed", note: `the build could not start: ${started.error}`, command: `cd ${repoDir} && ${cfg.cmd}` };
      j.buildRunId = started.runId;
      const s = j.steps.find((x) => x.id === "build");
      if (s && bound.length) s.note = `using ${bound.join("; ")}`;
      this.save();
      run = started;
    }
    const deadline = this.d.now() + BUILD_WAIT_MS;
    while (run && run.status === "running") {
      if (this.d.now() > deadline) return { status: "failed", note: "the build is still running after 30 minutes; it keeps going, and its output is in the Build sheet" };
      await this.d.sleep(1000);
      run = this.d.builds.get(j.buildRunId!);
    }
    if (!run) return { status: "failed", note: "the build run disappeared from the store" };
    if (run.status !== "done") {
      const cmd = this.d.builds.list(repoDir).find((b) => b.id === run!.buildId)?.cmd ?? run.cmd;
      return {
        status: "failed",
        note: `the build ${run.status === "cancelled" ? "was cancelled" : `failed${run.exitCode != null ? ` (exit ${run.exitCode})` : ""}`}; its output is in the Build sheet`,
        command: `cd ${repoDir} && ${cmd}`,
      };
    }
    return this.built(j, run);
  }

  private built(j: OnboardJob, run: BuildRun): StepOutcome {
    const outbox = ".claude/outbox/";
    const arts = run.artifacts ?? [];
    const want = j.answers.path === "android" ? /\.apk$/i : /\.html?$/i;
    const pick = arts.find((a) => want.test(a.relPath) && a.relPath.startsWith(outbox)) ?? arts.find((a) => want.test(a.relPath));
    let artifact = pick?.relPath;
    // The web build copies into the outbox itself (`.html` is no build deliverable), so it is looked for there.
    if (!artifact && j.answers.path === "web" && j.repoDir && this.d.exists(join(j.repoDir, outbox, `${j.name}.html`))) artifact = `${outbox}${j.name}.html`;
    if (!artifact) return { status: "failed", note: "the build succeeded but left nothing for the phone (no APK / page found)" };
    j.artifact = artifact;
    const secs = run.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) : null;
    return { status: "done", note: `built ${artifact}${secs ? ` in ${secs} s` : ""}` };
  }

  private async sessionStep(j: OnboardJob): Promise<StepOutcome> {
    if (j.consent.session !== true) return { status: "skipped", note: "running claude in the new repo was not consented; open a session from the repo when you want one" };
    if (!j.repoDir) return { status: "failed", note: "no repo to open a session in" };
    const r = await this.d.openSession({
      repoDir: j.repoDir, title: j.name, intentId: `${j.id}-session`,
      ...(j.answers.description ? { prompt: j.answers.description } : {}),
    });
    if ("error" in r) return { status: "failed", note: r.error };
    if (r.sessionId) j.sessionId = r.sessionId;
    if (r.intentId) j.intentId = r.intentId;
    return { status: "done", note: r.note };
  }
}

function cleanConsent(raw: unknown): OnboardConsent {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: OnboardConsent = {};
  for (const k of ["repo", "toolchain", "signingKey", "installApps", "session"] as const) if (r[k] === true) out[k] = true;
  return out;
}

// ---------------------------------------------------------------------------------------------
// The persisted file

export function onboardStateIO(stateDir: string): Pick<OnboardDeps, "readState" | "writeState"> {
  const path = join(stateDir, "onboard.json");
  return {
    readState: () => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    writeState: (t) => writeTextAtomic(path, t),
  };
}

export const fsDeps: Pick<OnboardDeps, "exists" | "readText" | "writeText" | "sleep"> = {
  exists: (p) => existsSync(p),
  readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  writeText: (p, t) => writeFileSync(p, t),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ---------------------------------------------------------------------------------------------
// The real thing (wired in `main.ts`)

export interface OnboardHost {
  root: string;
  stateDir: string;
  builds: { list(r: string): BuildConfig[]; save(r: string, b: BuildConfig[]): BuildConfig[]; run(r: string, id: string): BuildRun | { error: string } };
  intents: {
    get(id: string): Intent | undefined;
    post(draft: IntentDraft, now?: number): { ok: boolean; intent?: Intent; existing?: boolean; reason?: string };
  };
  sessions: { list(): Array<{ id: string; cwd: string; running: boolean }>; create(cwd: string, o: { title?: string }): { id: string } };
  recomputeWatched(): void;
  broadcast(job: OnboardJob): void;
}

export function makeOnboardDeps(h: OnboardHost): OnboardDeps {
  return {
    root: h.root,
    home: homedir(),
    now: () => Date.now(),
    ...onboardStateIO(h.stateDir),
    emit: (job) => h.broadcast(job),
    env: process.env,
    ...fsDeps,
    probe: () => probeAndroidEnv(),
    planToolchain: (r) => planToolchain(realToolchainDeps(), r),
    // The single-flight entry, so a checklist fix already installing is joined, not doubled.
    runToolchain: (o) => startToolchainInstall(o).done,
    key: () => { const k = findKey(); return { exists: k.desktop.exists, broken: k.desktop.broken, jks: k.desktop.jks, dir: keysDir() }; },
    ensureKey: (o) => ensureDesktopKey(o),
    linkKey: (repo) => linkKey(repo),
    newRepo: (root, parent, name, opts) => newRepo(root, parent, name, opts),
    repoId: (dir) => targetId(dir),
    setup: (repoDir) => {
      const target: RepoTarget = { id: targetId(repoDir), repoName: basename(repoDir), branch: "main", isPrimary: true, worktreePath: repoDir, outboxCount: 0 } as RepoTarget;
      // "Fix all", exactly: every row with a fix that is not confirm-gated. The two gated rows an
      // Android repo has (toolchain, signing key) are this job's own steps, under its own consent.
      const fixes = checkRepoCompliance(target).checks
        .filter((c) => c.fix && c.status !== "pass" && !CONFIRM_GATED_FIXES.includes(c.fix))
        .map((c) => c.fix as string);
      if (!fixes.length) return { ok: true, applied: [], notes: [] };
      const r = fixRepoCompliance(target, fixes);
      return { ok: r.ok, applied: r.applied ?? [], notes: r.notes ?? [], ...(r.ok ? {} : { error: r.error }) };
    },
    builds: {
      list: (r) => h.builds.list(r),
      save: (r, b) => h.builds.save(r, b),
      run: (r, id) => h.builds.run(r, id),
      get: (runId) => { const i = h.intents.get(runId); return i ? intentToBuildRun(i) : null; },
    },
    openSession: async ({ repoDir, title, prompt, intentId }) => {
      if (!prompt) {
        // A bare open: a live session in the new repo (this job's, before a restart) is adopted.
        const live = h.sessions.list().find((s) => s.cwd === repoDir && s.running);
        if (live) return { sessionId: live.id, note: "a session is already open in the new repo" };
        const s = h.sessions.create(repoDir, { title });
        h.recomputeWatched();
        return { sessionId: s.id, note: "opened a session in the new repo; the suggested prompt is ready to send" };
      }
      // With words: the store's launch path (a `files` trigger with nothing to wait for), keyed by
      // this job, so a resumed job finds its own row instead of typing the prompt twice.
      const now = Date.now();
      const posted = h.intents.post(createToIntent({ id: intentId, cwd: repoDir, prompt, needs: [], now, title }), now);
      if (!posted.ok) return { error: `the session could not be written down: ${posted.reason ?? "refused"}` };
      for (let waited = 0; waited < SESSION_WAIT_MS; waited += 500) {
        const i = h.intents.get(intentId);
        if (i?.sessionId) return { sessionId: i.sessionId, intentId, note: "opened a session in the new repo and sent your description as its first prompt" };
        if (i && (i.state === "failed" || i.state === "canceled")) return { error: i.result?.detail ?? "the session did not open" };
        await fsDeps.sleep(500);
      }
      return { intentId, note: "the session is opening; your description is queued as its first prompt" };
    },
  };
}
