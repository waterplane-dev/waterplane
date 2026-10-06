/**
 * What the first-app journey asks of the desktop and the phone. Every command is HTTP
 * (`/api/onboard*`, behind the usual Origin/Host gate); progress arrives as `onboard.progress`
 * over the one socket and is written here, and nowhere else, into `jobStore`.
 */
import type { OnboardAnswers, OnboardConsent, OnboardJob, OnboardPlan } from "@waterplane/shared";
import { core } from "../../sdk";
import { api, isOffline } from "../../api";
import { installStatus, nativeInstallSupported, openInstallSettings, readInstallAllow, writeInstallAllow } from "../../nativeInstall";
import { dismissedStore, jobStore, seededStore, startedHereStore } from "./store";
import { OLD_HOST_WORDS, handOff, withAllowed } from "./logic";

/** Open the journey's sheet (the first-run card, "Build another app" in the New sheet). */
export function openOnboard(): void {
  const c = core();
  c.say.track("overlay:onboard");
  c.nav.open("onboard");
}

export function closeOnboard(): void {
  core().nav.close("onboard");
}

/** "Build another app": the finished checklist leaves the sheet (the job stays on the desktop). */
export function forgetStartedHere(): void {
  startedHereStore.set(null);
}

export function dismissFirstRun(): void {
  dismissedStore.set(true);
}

/** A frame or a GET: the newest by `updatedAt` wins, so a late GET never rolls a frame back. */
export function takeJob(job: OnboardJob | null): void {
  jobStore.set((prev) => (prev && job && prev.id === job.id && prev.updatedAt > job.updatedAt ? prev : job));
}

/** Ask the desktop for the job (after a reconnect). A host without the route says nothing. */
export async function refreshJob(): Promise<void> {
  try {
    const r = await api.onboardJob();
    takeJob(r?.job ?? null);
  } catch {
    // An older desktop (404) or the link: no job to show, and nothing to say on the launcher.
    if (jobStore.get() === undefined) jobStore.set(null);
  }
}

/** The words a failed fetch becomes on the sheet. */
function failWords(e: unknown, what: string): string {
  if (isOffline(e)) return `No connection — ${what} needs the desktop. Nothing was started.`;
  const m = String((e as Error)?.message ?? e);
  return /^404\b/.test(m) ? OLD_HOST_WORDS : `${what} failed: ${m}`;
}

export async function fetchPlan(a: OnboardAnswers): Promise<OnboardPlan | { error: string }> {
  try {
    const p = await api.onboardPlan(a);
    if (!p.ok) return { error: p.error ?? "the desktop refused these answers" };
    return p;
  } catch (e) {
    return { error: failWords(e, "Reading the plan") };
  }
}

/**
 * Go: start the job with exactly the ticks shown. On a start that went through, the phone's own
 * line acts here and now: the new package goes on the install allow-list, so the first build's
 * APK is allowed to install itself after Android's one dialog.
 */
export async function startJob(answers: OnboardAnswers, consent: OnboardConsent, confirm?: string): Promise<{ ok: true; job: OnboardJob } | { error: string }> {
  core().say.track("action:onboard.go");
  try {
    const r = await api.onboardStart(answers, consent, confirm);
    if (!r.ok || !r.job) return { error: r.error ?? "the desktop did not start the job" };
    takeJob(r.job);
    startedHereStore.set(r.job.id);
    if (consent.installApps === true) seedAllowList(r.job.packageId);
    return { ok: true, job: r.job };
  } catch (e) {
    return { error: failWords(e, "Starting") };
  }
}

/**
 * Carry on a stopped job; `consent` adds a tick the stopped step needs (never removes one). Adding
 * consent needs the host's one-shot token, minted by its read of the stopped job — so the tap
 * reads the job first, which is also the freshest word on whether it is still stopped.
 */
export async function resumeJob(consent?: OnboardConsent): Promise<string | null> {
  core().say.track("action:onboard.resume");
  try {
    let confirm: string | undefined;
    if (consent) {
      const cur = await api.onboardJob();
      takeJob(cur?.job ?? null);
      confirm = cur?.confirm;
    }
    const r = await api.onboardResume(consent, confirm);
    if (!r.ok || !r.job) return r.error ?? "the desktop did not carry on";
    takeJob(r.job);
    return null;
  } catch (e) {
    return failWords(e, "Carrying on");
  }
}

/** Pre-add the new app's package to the allow-list (synced and mirrored into the shell). */
export function seedAllowList(pkg: string | undefined): void {
  if (!pkg) return;
  const cur = readInstallAllow();
  const next = withAllowed(cur, pkg);
  if (next.length !== cur.length) writeInstallAllow(next);
}

/** Is Android's own "install unknown apps" switch off for this app? Null = not a question here. */
export async function installSwitchOff(): Promise<boolean | null> {
  if (!nativeInstallSupported()) return null;
  const { caps } = await installStatus();
  if (!caps.supported) return null;
  return !caps.canInstall;
}

export async function openInstallSwitch(): Promise<void> {
  try { await openInstallSettings(); } catch (e) { core().say.toast(String((e as Error)?.message ?? e)); }
}

/**
 * Into the new repo's session. The suggested prompt goes into the composer as a DRAFT — appended
 * to whatever is stored there (`compose.seedDraft`, never a replace), once per job — and the
 * person sends it. Seeded before the attach: the attach's load effect reads the stored draft.
 */
export function openNewSession(job: OnboardJob): void {
  const c = core();
  const ids = new Set(c.world.sessions.map((s) => s.id));
  const h = handOff(job, ids, seededStore.get().has(job.id));
  if (h.kind === "none" || h.kind === "wait") { c.say.toast(h.why); return; }
  c.say.track("action:onboard.handoff");
  if (h.kind === "follow") {
    c.nav.followFire(h.intentId);
    c.say.toast("Your description is the first prompt; the session opens when it starts.");
    return;
  }
  const s = c.world.sessions.find((x) => x.id === h.sessionId)!;
  if (h.seed) {
    c.compose.seedDraft(s.id, h.seed);
    seededStore.set((prev) => new Set([...prev, job.id]));
  }
  c.nav.attach(s);
  if (h.seed) c.say.toast("A first prompt is in the box: change it or send it.");
}

/** The thing the job built: the web page opens in the viewer, the APK downloads (and installs). */
export function openArtifactOf(f: { repoId: string; relPath: string; name: string }, path: "android" | "web"): void {
  const c = core();
  if (path === "web") c.files.openArtifact(f);
  else c.files.downloadArtifact(f);
}
