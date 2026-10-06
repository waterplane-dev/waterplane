/**
 * The first-app journey's pure half (`docs/analysis/first-app-plan.md`, WP7): when the first-run
 * card shows, the name it suggests, which consent lines are drawn and ticked, how a job's steps
 * read as a checklist, and what the hand-off does. No DOM, no `core()`: `logic.test.mjs` runs it
 * under node.
 *
 * The host words every step and every consent line (`host/onboard.ts`); nothing here re-words
 * them. What this file adds is the phone's half: the order, the icons, the fix offered on a
 * stopped step, and the sentences about the phone itself (its install switch, a browser).
 */
import { BRAND } from "@waterplane/shared";
import type {
  OnboardAnswers, OnboardConsent, OnboardConsentId, OnboardConsentLine, OnboardJob, OnboardPath, OnboardPlan,
  OnboardStep, OnboardStepId, OnboardStepStatus,
} from "@waterplane/shared";

// ── The first-run card ───────────────────────────────────────────────

export interface FirstRunFacts {
  /** The link to the host is open — the card's verbs all need it. */
  online: boolean;
  /** Live sessions, the host's recent list and the recently closed list. */
  sessions: number;
  recent: number;
  closed: number;
  /** The current (or last) onboarding job, as the host last said; undefined = not read yet. */
  job: OnboardJob | null | undefined;
  /** "Not now" was tapped on this page. */
  dismissed: boolean;
  /** The demo is on: its desktop is a scenario, not one to build on. */
  demo: boolean;
}

export type FirstRunCard = "none" | "first-run" | "job";

/**
 * Which card the launcher draws.
 *
 * `job` whenever a job is running or stopped, whatever else is open: a stopped step is waiting on
 * the person, and the launcher is where they come back to. `first-run` only when this host has
 * never opened a session — no live session, nothing recent, nothing recently closed (the cheapest
 * honest reading of "never"; the host keeps no flag of its own) — and only while online, because
 * every verb on it asks the desktop something. Never in the demo.
 */
export function firstRunCard(f: FirstRunFacts): FirstRunCard {
  if (f.demo) return "none";
  if (f.job && (f.job.state === "running" || f.job.state === "stopped")) return "job";
  if (f.dismissed || !f.online) return "none";
  if (f.sessions > 0 || f.recent > 0 || f.closed > 0) return "none";
  return "first-run";
}

// ── Question 1: the name ─────────────────────────────────────────────

/** Short, lower-case, one word each: the folder and the package segment take them as they are. */
export const NAME_WORDS: readonly string[] = [
  "otter", "maple", "comet", "pebble", "tulip", "harbor", "falcon", "meadow", "lantern", "ember",
  "willow", "quartz", "breeze", "cedar", "puffin", "sparrow", "river", "aurora", "clover", "nova",
];

/** `hello-<word>`; `rand` is `Math.random` in the sheet and a fixed number in a test. */
export function suggestName(rand: () => number = Math.random): string {
  const i = Math.min(NAME_WORDS.length - 1, Math.max(0, Math.floor(rand() * NAME_WORDS.length)));
  return `hello-${NAME_WORDS[i]}`;
}

/**
 * Which path is preselected. Android only where this phone can install what it builds (the
 * shell's installer is there); a browser gets the web page, which needs nothing installed on the
 * desktop and opens in the gallery. The person can switch either way.
 */
export function defaultPath(canInstallApps: boolean): OnboardPath {
  return canInstallApps ? "android" : "web";
}

/** What the "describe it" answer adds: nothing when the box is empty (plain hello world). */
export function answersFrom(a: { name: string; path: OnboardPath; describe: boolean; description: string; setup: boolean }): OnboardAnswers {
  const description = a.describe ? a.description.trim() : "";
  return { name: a.name.trim(), path: a.path, ...(description ? { description } : {}), setup: a.setup };
}

/** Why "Next" cannot be tapped yet, as a sentence — the button is replaced, never greyed. */
export function questionsBlocker(a: { name: string; describe: boolean; description: string }): string | null {
  if (!a.name.trim()) return "Give the app a name first.";
  if (a.describe && !a.description.trim()) return "Say in one line what it should do, or choose plain hello world.";
  return null;
}

// ── The consent screen ───────────────────────────────────────────────

export interface ConsentRow {
  id: OnboardConsentId;
  what: string;
  where?: string;
  /** "about 520 MB to download", when the host gave a size. */
  size?: string;
  link?: string;
  required: boolean;
  /** A line this phone cannot act on, with the reason (a browser cannot install an APK). */
  cant?: string;
}

/** "about 160 MB" / "about 1.2 GB": an estimate, always said as one. */
export function aboutBytes(bytes: number | undefined): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
  const mb = Math.max(1, Math.round(bytes / 1048576));
  return mb >= 1000 ? `about ${(mb / 1024).toFixed(1)} GB to download` : `about ${mb} MB to download`;
}

export const BROWSER_CANT_INSTALL =
  `This browser cannot install apps: the APK will be in the gallery to download, and the ${BRAND.displayName} app on an Android phone installs it.`;

/**
 * The lines the screen draws: exactly the plan's (the host lists only what applies on this
 * desktop), in its order. The phone's own line (`installApps`) says so where this phone cannot
 * act on it.
 */
export function consentRows(plan: OnboardPlan, canInstallApps: boolean): ConsentRow[] {
  return plan.consent.map((l: OnboardConsentLine) => ({
    id: l.id, what: l.what, required: l.required,
    // A folder the sentence already names is not said twice.
    ...(l.where && !l.what.includes(l.where) ? { where: l.where } : {}),
    ...(aboutBytes(l.bytes) ? { size: aboutBytes(l.bytes) } : {}),
    ...(l.link ? { link: l.link } : {}),
    ...(l.phone && l.id === "installApps" && !canInstallApps ? { cant: BROWSER_CANT_INSTALL } : {}),
  }));
}

/** The ticks the screen opens with: every line it draws, except one this phone cannot act on.
 *  Go is the person's tap for all of them; the optional ones can be unticked first. */
export function initialTicks(rows: readonly ConsentRow[]): OnboardConsent {
  const out: OnboardConsent = {};
  for (const r of rows) if (!r.cant) out[r.id] = true;
  return out;
}

/**
 * The consent sent with Go: EXACTLY the ticks of lines that were shown — a line the plan did not
 * list is never sent as true, whatever the state held.
 */
export function consentToSend(rows: readonly ConsentRow[], ticks: OnboardConsent): OnboardConsent {
  const out: OnboardConsent = {};
  for (const r of rows) if (ticks[r.id] === true && !r.cant) out[r.id] = true;
  return out;
}

/** Why Go is not drawn: a required line unticked. Null = Go may be drawn. */
export function goBlocker(rows: readonly ConsentRow[], ticks: OnboardConsent): string | null {
  const missing = rows.filter((r) => r.required && ticks[r.id] !== true);
  if (!missing.length) return null;
  const toolchain = missing.some((r) => r.id === "toolchain");
  return `Go needs ${missing.length === 1 ? "the line" : "the lines"} marked "needed" ticked.` +
    (toolchain ? " Without the Android build tools, a web page needs nothing installed." : "");
}

/** The plan's steps that will run, in order — "what happens after Go". */
export function plannedSteps(plan: OnboardPlan): string[] {
  return plan.steps.filter((s) => s.needed).map((s) => s.what);
}

// ── Progress ─────────────────────────────────────────────────────────

/** Which consent a step stopped at `needs-consent` is waiting for. */
export const STEP_CONSENT: Partial<Record<OnboardStepId, OnboardConsentId>> = {
  scaffold: "repo", toolchain: "toolchain", "signing-key": "signingKey", session: "session",
};

export type CheckIcon = "pending" | "running" | "done" | "skipped" | "stopped";

export interface CheckRow {
  id: OnboardStepId;
  icon: CheckIcon;
  what: string;
  note?: string;
  /** How long a running step has been at it ("1:23"), or how long a finished one took. */
  clock?: string;
  /** The stopped step's fix: carry on (`retry`), allow the missing consent (`allow`), or neither. */
  fix?: { verb: "retry" | "allow"; consent?: OnboardConsentId };
  /** "do it yourself: <command>" — the host never runs it. */
  command?: string;
}

const ICON: Record<OnboardStepStatus, CheckIcon> = {
  pending: "pending", running: "running", done: "done", skipped: "skipped",
  failed: "stopped", "needs-you": "stopped", "needs-consent": "stopped",
};

/** "0:07", "4:51", "1:02:03". */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** One checklist row per step, in the job's order, worded by the host. */
export function checklist(job: OnboardJob, now: number): CheckRow[] {
  return job.steps.map((s: OnboardStep) => {
    const row: CheckRow = { id: s.id, icon: ICON[s.status] ?? "pending", what: s.what };
    if (s.note) row.note = s.note;
    const from = s.startedAt, to = s.endedAt;
    if (s.status === "running" && typeof from === "number") row.clock = clockText(now - from);
    else if (s.status === "done" && typeof from === "number" && typeof to === "number" && to - from >= 1000) row.clock = clockText(to - from);
    if (s.status === "needs-consent") {
      const consent = STEP_CONSENT[s.id];
      row.fix = consent ? { verb: "allow", consent } : { verb: "retry" };
    } else if (s.status === "failed" || s.status === "needs-you") row.fix = { verb: "retry" };
    if (s.command && (s.status === "failed" || s.status === "needs-you")) row.command = s.command;
    return row;
  });
}

/** The stopped step's verb, worded for the button. */
export function fixLabel(fix: NonNullable<CheckRow["fix"]>, stepStatus: OnboardStepStatus | undefined): string {
  if (fix.verb === "allow") return "allow it and carry on";
  return stepStatus === "needs-you" ? "I ran it — carry on" : "retry";
}

/** The head line over the checklist. */
export function progressHead(job: OnboardJob): string {
  if (job.state === "done") return `${job.name} is ready.`;
  if (job.state === "stopped") return `Stopped: ${job.summary}`;
  return job.summary && job.summary !== "starting" ? job.summary : `Making ${job.name}…`;
}

// ── After it is done ─────────────────────────────────────────────────

/** The artifact as a gallery file, or null when the job left none. */
export function artifactFile(job: OnboardJob): { repoId: string; relPath: string; name: string } | null {
  if (!job.artifact || !job.repoId) return null;
  const name = job.artifact.split("/").pop() || job.artifact;
  return { repoId: job.repoId, relPath: job.artifact, name };
}

export type HandOff =
  | { kind: "attach"; sessionId: string; seed: string | null }
  | { kind: "follow"; intentId: string }
  | { kind: "wait"; why: string }
  | { kind: "none"; why: string };

/**
 * What "open the session" does. The session the job opened, attached; with the suggested prompt
 * put in its composer ONLY when the person gave no description (a description was already sent
 * as the first prompt) and only once per job — `seeded` says this job's words went in already, so
 * a second tap never appends them twice. A session still opening through the intent store is
 * followed (the launcher jumps to it when it runs).
 */
export function handOff(job: OnboardJob, sessionIds: ReadonlySet<string>, seeded: boolean): HandOff {
  if (job.consent.session !== true) return { kind: "none", why: "You chose not to run claude in the new repo; open a session from its row when you want one." };
  if (job.sessionId) {
    if (!sessionIds.has(job.sessionId)) return { kind: "wait", why: "The session is open on the desktop but not on this phone's list yet; try again in a moment." };
    const seed = !job.answers.description && !seeded && job.suggestedPrompt ? job.suggestedPrompt : null;
    return { kind: "attach", sessionId: job.sessionId, seed };
  }
  if (job.intentId) return { kind: "follow", intentId: job.intentId };
  return { kind: "wait", why: "The session has not opened yet." };
}

/** Add a package to the install allow-list, never removing anything (`toggleAllow` would). */
export function withAllowed(allow: readonly string[], pkg: string | undefined): string[] {
  if (!pkg || allow.includes(pkg)) return [...allow];
  return [...allow, pkg];
}

/** The line under a finished Android job when Android's own "install unknown apps" switch is off. */
export const INSTALL_SWITCH_OFF =
  `Android's "install unknown apps" is off for ${BRAND.displayName}, so the app cannot be installed yet. Turn it on once; every later build installs quietly.`;

/** The refusal the demo answers with, and what an older desktop's 404 becomes. */
export const OLD_HOST_WORDS = `This desktop's ${BRAND.displayName} does not build first apps yet: update it, then try again.`;
