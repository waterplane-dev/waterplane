/**
 * The first-app onboarding job on the wire (`docs/analysis/first-app-plan.md`, WP6).
 *
 * One host-side job (`packages/host/src/onboard.ts`) turns three answers and one consent screen
 * into a repo, a build and a session. The phone reads the PLAN before the consent screen
 * (`GET /api/onboard/plan`), starts the job (`POST /api/onboard`), and follows it as
 * `onboard.progress` frames over the one socket, or `GET /api/onboard` after a reconnect. Every
 * step is a sentence; a stopped step names its fix.
 */

/** Which journey: an Android app (template `android-hello`) or a web page (`web-hello`). */
export type OnboardPath = "android" | "web";

/** The person's answers from the three questions. */
export interface OnboardAnswers {
  /** The app name; becomes the folder `<root>/<name>` and the package segment. */
  name: string;
  path: OnboardPath;
  /** "Describe what you want": becomes the new session's FIRST prompt, after the first build. */
  description?: string;
  /** "Set this repo up for waterplane" (default on): the setup checklist's one-tap fixes, as one step. */
  setup?: boolean;
}

/**
 * The consent screen's ticks, one per line it showed. The host REFUSES a start whose plan needs a
 * line that is not `true` (`repo` always; `toolchain` and `signingKey` when the plan lists them).
 * `session: false` is allowed: that step is then skipped, said so, and nothing runs `claude`.
 * `installApps` is the phone's own (the allow-list and Android's setting); the host records it.
 */
export interface OnboardConsent {
  repo?: boolean;
  /** Download and install the toolchain AND accept Google's SDK licence on the person's behalf. */
  toolchain?: boolean;
  signingKey?: boolean;
  installApps?: boolean;
  session?: boolean;
}

export type OnboardConsentId = "repo" | "toolchain" | "signingKey" | "installApps" | "session";

/** One line of the consent screen: shown only if it applies to this desktop. */
export interface OnboardConsentLine {
  id: OnboardConsentId;
  /** What it does, in one sentence the screen shows as is. */
  what: string;
  /** Where it lands on this desktop (a folder), when it writes anything. */
  where?: string;
  /** About how much is downloaded (derived, an estimate shown as "about"). */
  bytes?: number;
  /** The licence text, for the line that accepts one. */
  link?: string;
  /** The start is refused without this tick. */
  required: boolean;
  /** Acted on by the phone, not the desktop. */
  phone?: boolean;
}

export type OnboardStepId = "probe" | "toolchain" | "scaffold" | "signing-key" | "setup" | "build" | "session";

export type OnboardStepStatus = "pending" | "running" | "done" | "skipped" | "failed" | "needs-you" | "needs-consent";

export interface OnboardStep {
  id: OnboardStepId;
  status: OnboardStepStatus;
  /** What the step does, said before it runs ("First build: the slow one, about 5 minutes"). */
  what: string;
  /** What happened, or why it stopped. */
  note?: string;
  /** `needs-you`: the exact command the person must run; `failed`: the do-it-yourself command.
   *  Never run by the host. */
  command?: string;
  startedAt?: number;
  endedAt?: number;
}

/** What `GET /api/onboard/plan` answers: the steps that apply here, and the consent lines. */
export interface OnboardPlan {
  ok: boolean;
  /** The refusal in words (bad name, folder exists, broken key…); `ok:false`. */
  error?: string;
  path: OnboardPath;
  /** The cleaned name and the folder it becomes. */
  name: string;
  folder: string;
  /** Android only. */
  packageId?: string;
  steps: Array<{ id: OnboardStepId; needed: boolean; what: string }>;
  consent: OnboardConsentLine[];
  /** What the session's first prompt will be (the description), or the suggestion offered. */
  firstPrompt?: string;
  suggestedPrompt: string;
  /** Set when claude is NOT signed in on this desktop: the sentence saying how to sign in from
   *  the phone. The job still runs; its session would stop at the sign-in screen. Absent when
   *  signed in, when the answer could not be read, and from an older desktop. */
  signIn?: string;
  /** One-shot token for `POST /api/onboard` `{ answers, consent, confirm }`, bound to this path and
   *  to the consent ids listed above (`host/confirmgate.ts`). Absent from an older desktop. */
  confirm?: string;
}

export type OnboardJobState = "running" | "done" | "stopped";

export interface OnboardJob {
  id: string;
  state: OnboardJobState;
  answers: OnboardAnswers;
  consent: OnboardConsent;
  name: string;
  folder: string;
  packageId?: string;
  steps: OnboardStep[];
  /** Set once the scaffold step made it. */
  repoDir?: string;
  repoId?: string;
  /** The first build's run (`build.output`/`build.run` frames carry the same id). */
  buildRunId?: string;
  /** Repo-relative path of what the build left for the phone (the APK or the HTML in the outbox). */
  artifact?: string;
  /** The session opened in the new repo, once known; `intentId` when it opens through the store. */
  sessionId?: string;
  intentId?: string;
  suggestedPrompt: string;
  /** One sentence: where the job is. */
  summary: string;
  createdAt: number;
  updatedAt: number;
}
