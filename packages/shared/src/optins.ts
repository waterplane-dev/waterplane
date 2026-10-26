/**
 * **Opt-ins** — the advanced things a repo can turn on, as one catalog both ends
 * read.
 *
 * The repo-setup checklist is hygiene: a fact against a line, pass/warn/fail,
 * counted in the badge. Most of what waterplane can do for a repo is not that —
 * a requirements list, a weekly security review, a pre-push hook are worth
 * having, and a repo without them is not BROKEN. Putting them on the checklist
 * would make a warn nobody can close (`compliance.ts`'s `visual-check` note
 * argues the same), so they live here instead: a list of offers, each with
 * three states the person controls — **on**, **off**, **not for me** — and
 * counted in nothing.
 *
 * One registry, so the host's probe (`host/optins.ts`) and the phone's card
 * (`OptInRegion.tsx`) are keyed by the same id and worded by the same strings.
 *
 * **Nothing here applies itself.** Every action is a tap: a `fix` runs the
 * host's existing idempotent setup fix, `open` lands on the screen that already
 * does the job, `agent` and `schedule` SEED the Send sheet — the words, the
 * repo, and for a schedule the clock and the model — and nothing is sent until
 * the person sends it there, where all of it can still be changed.
 *
 * **A probe answers `on`, `off` or `unknown`, never a guess.** `unknown` is an
 * offer the desktop cannot check (a cloud registry's policy); the person can
 * mark it done, and that is stored as THEIR word (`choice: "done"`) and shown as
 * such, never as a probe that passed.
 */
import { BRAND } from "./brand.js";
import type { ScheduleRule } from "./schedule.js";

/** What the probe found. `unknown` = this desktop cannot tell. */
export type OptInState = "on" | "off" | "unknown";

/** What the PERSON said about one offer in one repo. Absent = nothing. */
export type OptInChoice = "declined" | "done";

/**
 * What became of the last time this offer's own words were sent in this repo,
 * as far as this desktop can see — found by the marker (`optInMarker`), never
 * by a label or a guess:
 *
 * - `waiting` / `running` / `done` / `failed` / `canceled` — a posted work row
 *   (backlog item or schedule) carrying the marker, by its own lifecycle.
 * - `open` — a live session in this repo was sent the words.
 * - `ended` — this desktop saw the words sent once, and nothing it holds now
 *   still carries them (the session closed, the row was cleared).
 */
export type OptInSentStatus = "waiting" | "running" | "done" | "failed" | "canceled" | "open" | "ended";

export interface OptInSent {
  /** When the words were sent or the row was posted (ms epoch). */
  at: number;
  status: OptInSentStatus;
}

const SENT_STATUSES: readonly OptInSentStatus[] = ["waiting", "running", "done", "failed", "canceled", "open", "ended"];

/** What a tap on the offer's verb does. */
export type OptInAction =
  /** Run the host's own setup fix with this id (`POST …/compliance/fix`). */
  | { kind: "fix"; fix: string }
  /** Open the screen that already does this job. */
  | { kind: "open"; to: "series" | "capture" }
  /** Seed the Send sheet: these words, a new session in this repo. */
  | { kind: "agent" }
  /** Seed the Send sheet with a standing weekly rule and a model. */
  | { kind: "schedule"; days: number[]; hour: number; minute: number; graceMin: number; model: string };

export interface OptInDef {
  id: string;
  title: string;
  /** What it is and why someone would want it — one or two sentences. */
  pitch: string;
  /** What it spends, said plainly. Never a dollar figure nobody measured. */
  cost: string;
  /** The verb on the card, lower case. */
  verb: string;
  action: OptInAction;
  /** The words handed to the agent (`agent`/`schedule` only), with `{repo}`
   *  for the repo's name. Ends with the marker line where the host probes for
   *  it (`optInMarker`). */
  prompt?: string;
}

/** One offer as one repo answers it — the host's half. */
export interface OptInRow {
  id: string;
  /** False = this offer does not fit this repo (no package.json for an npm
   *  policy, say). Shown only behind a count, never as an offer. */
  relevant: boolean;
  state: OptInState;
  /** What the probe saw, one sentence — names the file it read. */
  detail: string;
  choice?: OptInChoice;
  /** The last send of this offer's words in this repo. Absent = this desktop
   *  never saw one, which is not proof nobody did it by hand. */
  sent?: OptInSent;
  /** The probe saw the work begun but not finished (written, not committed).
   *  `state` stays `off`: half done is not on. */
  partial?: true;
}

/** `GET /api/repos/:id/optins`. */
export interface OptInReport {
  repoId: string;
  repoName: string;
  rows: OptInRow[];
  checkedAt: number;
}

/** `POST /api/repos/:id/optins/choice` `{ id, choice }` (`choice: null` clears). */
export interface OptInChoiceResult {
  ok: boolean;
  error?: string;
  report?: OptInReport;
}

/**
 * The line a seeded prompt ends with, so the host can tell a standing schedule
 * this card made from any other one without matching on a label a person may
 * have retyped. It is in the words on purpose: the person sees it before
 * sending, and deleting it only means the card reads "off" — a reading that
 * degrades to absent, never to a wrong "on".
 */
export function optInMarker(id: string): string {
  return `(${BRAND.slug} opt-in: ${id})`;
}

/**
 * The offers whose marker one text carries — the host's reader of "was this
 * sent". A text carrying more than one is the walk-through (it quotes every
 * prompt it offers) and answers `[]`: an interview about an offer is not the
 * offer being sent.
 */
export function optInMarkedIds(text: string): string[] {
  if (!text.includes(`(${BRAND.slug} opt-in: `)) return [];
  const ids = OPT_INS.filter((d) => text.includes(optInMarker(d.id))).map((d) => d.id);
  return ids.length === 1 ? ids : [];
}

const SECURITY_PROMPT = `Weekly security review of {repo}. Read-only: change no file, commit nothing, push nothing.

1. Read what changed since the last review (\`git log --since="8 days ago" --stat\`, then the diffs that touch auth, input handling, file paths, shell/process spawning, network listeners, secrets or dependencies).
2. Check the dependency manifests and lockfiles for new or bumped packages, install scripts and known-vulnerable versions (\`npm audit --omit=dev\` or the ecosystem's equivalent, if it runs offline-safe).
3. Look for secrets committed by accident (keys, tokens, .env files) in the changed files.

Write the findings to \`.claude/outbox/security-review-<YYYY-MM-DD>.md\`: each finding with severity (high/medium/low), the file and line, why it matters, and a proposed fix as words. If nothing was found, write that and what you checked. Do not fix anything — the person decides.

${"{marker}"}`;

/**
 * The catalog, in the order the cards are drawn. Add an offer here, give it a
 * probe in `host/optins.ts`, and both ends pick it up.
 */
export const OPT_INS: readonly OptInDef[] = [
  {
    id: "requirements",
    title: "Requirements list",
    pitch: "A list of what this repo is expected to do, rebuilt from your own prompts and commits, so an agent checks it before changing behaviour you rely on.",
    cost: "Setting it up writes two files and spends nothing. Each later build is one paid run, and the setup checklist's row says when one is due.",
    verb: "set it up",
    action: { kind: "fix", fix: "requirements" },
  },
  {
    id: "repo-health",
    title: "Repo health series",
    pitch: "Size, complexity, churn and test readings for this repo, measured weekly and drawn as a trend, so a slow slide shows up before it hurts.",
    cost: "Spends no tokens: a local tool runs once a week while the desktop is up. The first measurement is a tap on the series screen.",
    verb: "open the series",
    action: { kind: "open", to: "series" },
  },
  {
    id: "repo-health-own",
    title: "Your own health readings",
    pitch: "Numbers only this repo knows about itself (test count, bundle size, open TODOs), measured beside the standard ones in the same weekly series.",
    cost: "One agent session to propose them. The readings themselves spend no tokens.",
    verb: "propose readings",
    action: { kind: "agent" },
    prompt: `Propose 2-4 repo-specific health readings for {repo}: numbers this repo knows about itself that a generic metric cannot (for example test count, bundle size, number of TODO/FIXME, count of skipped tests).

They are declared in \`{shared}/health.json\` as
{ "readings": [ { "key": "testCount", "name": "Tests", "means": "one sentence", "better": "higher" | "lower", "unit": "tests", "run": ["node", "tools/health/testcount.mjs"] } ] }
\`run\` is an argv array (no shell), run from the repo root, and must print ONE JSON number or {"value": n} to stdout; anything else makes the reading absent.

Show me the readings you propose and the small scripts behind them before writing anything. Only declarations that are committed run, so after I agree, write the files and tell me to commit them.

{marker}`,
  },
  {
    id: "security-review",
    title: "Weekly security review",
    pitch: "Every Monday a session reads the week's changes and dependency bumps and writes its findings to the outbox. It changes nothing; you decide what to fix.",
    cost: "One Fable session a week, the most capable and most expensive model, picked on purpose. You can change the model, day and time before you save it, and each run's cost shows on its row.",
    verb: "schedule it",
    action: { kind: "schedule", days: [1], hour: 9, minute: 0, graceMin: 12 * 60, model: "fable" },
    prompt: SECURITY_PROMPT,
  },
  {
    id: "local-ci",
    title: "Checks before every push",
    pitch: "A git pre-push hook that runs this repo's tests and lint on your desktop, so a broken push is caught without paying for hosted CI minutes.",
    cost: "One agent session to set it up. After that the hook runs locally and spends no tokens.",
    verb: "set it up",
    action: { kind: "agent" },
    prompt: `Set up a local pre-push check for {repo}, so tests and lint run on this desktop before every push instead of in hosted CI.

1. Find the commands this repo already uses to lint, type-check and test (package.json scripts, Makefile, pyproject, CI config).
2. Propose one pre-push hook: what it runs, in what order, roughly how long it takes. Keep it fast enough that people will not skip it; slow suites can be a separate command.
3. Show me the hook before installing it. Prefer a committed hooks directory (\`git config core.hooksPath\`) so it survives a fresh clone, and say how to bypass it in an emergency.

Do not change the tests or the lint rules themselves.

{marker}`,
  },
  {
    id: "npm-supply-chain",
    title: "Safer npm installs",
    pitch: "An .npmrc that stops dependencies running code at install time and waits a few days before taking a freshly published version, when most hijacked releases are caught.",
    cost: "One short agent session. It spends nothing afterwards.",
    verb: "set it up",
    action: { kind: "agent" },
    prompt: `Harden npm installs in {repo} with a committed \`.npmrc\`:

- \`ignore-scripts=true\`: no dependency runs code at install time. First list which dependencies have install scripts (preinstall/install/postinstall) and say, per one, whether it works without it (prebuilds) or needs a replacement step in our own build.
- \`min-release-age=7\`: a version must be a week old before \`npm install\` picks it. Check the installed npm version supports it and say so if it does not.

Show me the file and the list before writing. \`npm ci\` from the lockfile is unaffected; say that in a comment in the file.

{marker}`,
  },
  {
    id: "gcp-cleanup",
    title: "Registry cleanup policy (GCP)",
    pitch: "Cloud Run scales to zero; its Artifact Registry does not. One image per deploy piles up and bills as storage until a cleanup policy deletes the old ones.",
    cost: "One agent session. The policy usually lowers the storage bill. The desktop cannot check it from here, so mark it done once it is set.",
    verb: "set it up",
    action: { kind: "agent" },
    prompt: `{repo} deploys to Google Cloud. Check its Artifact Registry repositories and set a cleanup policy so images stop piling up:

1. List the registry repos this project deploys to and their size (\`gcloud artifacts repositories list\`, and describe each one).
2. Propose a policy (keep the 5 most recent versions, delete older than 7 days) and show it with \`--dry-run\` first.
3. Never delete the image the live Cloud Run revision serves; a keep-recent rule protects it. Name that digest.

Apply with \`--no-dry-run\` only after I agree. The size metric lags about 24h after a delete; say so.

{marker}`,
  },
  {
    id: "screenshots",
    title: "Screenshots of your app",
    pitch: "Let an agent (and you, from the phone) capture this app's screens on the desktop and check them, instead of describing what it probably looks like.",
    cost: "Setting up a capture target spends nothing. Each screenshot an agent looks at costs tokens on every later turn, and the checklist then offers the skill that keeps that cheap.",
    verb: "open captures",
    action: { kind: "open", to: "capture" },
  },
  {
    id: "exposure-watch",
    title: "Exposure watch",
    pitch: "Once a day this desktop looks up what the outside world now says about this repo: published advisories on its dependencies, deprecations and, for a private repo, a local Scorecard run. Findings land under watch.",
    cost: "Spends no tokens and makes no AI call: a daily job runs gh and npm audit-type lookups and, for a private repo, Scorecard locally. A tap only adds this repo to the list it reads.",
    verb: "watch this repo",
    action: { kind: "fix", fix: "exposure-watch" },
  },
];

const BY_ID = new Map(OPT_INS.map((d) => [d.id, d]));

export function optInDef(id: string): OptInDef | undefined {
  return BY_ID.get(id);
}

/** The words for an `agent`/`schedule` offer, for one repo — `null` for an
 *  offer the agent does not run. */
export function optInPrompt(id: string, repoName: string): string | null {
  const d = BY_ID.get(id);
  if (!d?.prompt) return null;
  return d.prompt.replaceAll("{repo}", repoName).replaceAll("{marker}", optInMarker(id))
    .replaceAll("{shared}", BRAND.sharedDirName).replaceAll("{skill}", BRAND.skillName);
}

/** The standing weekly rule a `schedule` offer seeds, in the phone's zone. */
export function optInRule(id: string, tz: string): ScheduleRule | null {
  const a = BY_ID.get(id)?.action;
  if (a?.kind !== "schedule") return null;
  return { kind: "weekly", days: [...a.days], hour: a.hour, minute: a.minute, tz };
}

/**
 * Which offers the sheet draws where — ONE function feeding every count and
 * every cut, so the number on a control and the list it opens cannot disagree.
 *
 * - `offered`: relevant, not on, not declined, not marked done, and never
 *   started here — the untouched cards.
 * - `started`: the same, but its words were sent here or the probe saw it
 *   half done — the cards a person has to be told they already began.
 * - `active`: on by probe, or marked done by the person.
 * - `declined`: the person said *not for me*.
 * - `unfit`: does not fit this repo. Behind a count, never an offer.
 *
 * Rows the phone has no definition for (a newer desktop) are dropped: a card
 * with no words is not an offer.
 */
export interface OptInCut {
  offered: OptInRow[];
  started: OptInRow[];
  active: OptInRow[];
  declined: OptInRow[];
  unfit: OptInRow[];
}

export function optInCut(rows: readonly OptInRow[]): OptInCut {
  const cut: OptInCut = { offered: [], started: [], active: [], declined: [], unfit: [] };
  for (const r of rows) {
    if (!BY_ID.has(r.id)) continue;
    if (r.choice === "declined") cut.declined.push(r);
    else if (r.state === "on" || r.choice === "done") cut.active.push(r);
    else if (!r.relevant) cut.unfit.push(r);
    else if (r.sent || r.partial) cut.started.push(r);
    else cut.offered.push(r);
  }
  return cut;
}

/** How an active row says it is on — the probe's word or the person's, never
 *  one dressed as the other. */
export function optInActiveWords(r: OptInRow): string {
  return r.state === "on" ? "on" : "marked done by you";
}

/**
 * The *walk me through it* prompt: an agent that INTERVIEWS and then posts
 * each picked offer as its OWN piece of work — never one long session doing
 * all of them, which would re-send every earlier step on every turn of the
 * next (`sessioncost.ts`).
 *
 * Only `agent`/`schedule` offers can be posted by an agent; `fix`/`open` ones
 * are a tap on the phone, so they are named as such and left alone.
 */
export function optInWalkPrompt(offered: readonly OptInRow[], repoName: string): string | null {
  const defs = offered.map((r) => BY_ID.get(r.id)).filter((d): d is OptInDef => !!d);
  if (defs.length === 0) return null;
  const postable = defs.filter((d) => d.action.kind === "agent" || d.action.kind === "schedule");
  const taps = defs.filter((d) => d.action.kind === "fix" || d.action.kind === "open");
  const lines: string[] = [
    `Walk me through the optional features ${BRAND.displayName} offers for ${repoName}. Do NOT set any of them up in this session.`,
    "",
    "1. For each one below, look at the repo briefly and tell me in one or two lines whether it fits here and what it would take. Then ask me which ones I want, in ONE question.",
    `2. For each one I pick, post its prompt (quoted below, unchanged) as its own new-session work item in this repo, using the ${BRAND.skillName} skill's way of posting work for later. A schedule one is posted as a weekly schedule with the model named. Do not run them here.`,
    "3. Finish with a list of what you posted, and nothing else.",
    "",
  ];
  for (const d of postable) {
    const when = d.action.kind === "schedule"
      ? ` — weekly, ${dayName(d.action.days)} ${pad2(d.action.hour)}:${pad2(d.action.minute)}, model ${d.action.model}`
      : "";
    lines.push(`## ${d.title}${when}`, d.pitch, d.cost, "", "Prompt:", "```", optInPrompt(d.id, repoName) ?? "", "```", "");
  }
  if (taps.length) {
    lines.push("These are a tap on the phone's Opt-ins screen, not something to post. Just say whether they fit:");
    for (const d of taps) lines.push(`- ${d.title}: ${d.pitch}`);
  }
  return lines.join("\n").trimEnd();
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function dayName(days: number[]): string {
  return days.length === 0 ? "every day" : days.map((d) => DAYS[d] ?? "?").join(", ");
}
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Strict reader for a row off the wire: unknown state/choice dropped, never rounded. */
export function cleanOptInRow(x: unknown): OptInRow | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.relevant !== "boolean") return null;
  if (o.state !== "on" && o.state !== "off" && o.state !== "unknown") return null;
  const row: OptInRow = { id: o.id, relevant: o.relevant, state: o.state, detail: typeof o.detail === "string" ? o.detail : "" };
  if (o.choice === "declined" || o.choice === "done") row.choice = o.choice;
  const sent = o.sent as Record<string, unknown> | null | undefined;
  if (sent && typeof sent === "object" && typeof sent.at === "number" && Number.isFinite(sent.at) && sent.at > 0
    && SENT_STATUSES.includes(sent.status as OptInSentStatus)) {
    row.sent = { at: sent.at, status: sent.status as OptInSentStatus };
  }
  if (o.partial === true) row.partial = true;
  return row;
}
