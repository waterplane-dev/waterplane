/**
 * The change brief: what a push would send and a pull would bring, explained
 * for a person who does not read the diff.
 *
 * ── Why the focus list lives here ──────────────────────────────────────────
 *
 * The phone draws one checkbox per focus and the host words one instruction per
 * focus into the prompt. Two copies of the list would be two answers to "what
 * did I ask for": a box ticked on the phone that the prompt never mentions is a
 * question silently not asked. So the ids, the labels and the instructions are
 * ONE table, and an id the table does not know is dropped on both ends.
 *
 * The answer is READING, never an action — nothing here pushes, pulls or
 * refuses anything. It is sentences a person reads before tapping Push.
 */

export interface ChangeFocus {
  /** Stable — stored on the phone. Never renamed. */
  readonly id: string;
  /** The checkbox's words. */
  readonly label: string;
  /** What the model is asked, for this focus, over both directions. */
  readonly ask: string;
}

export const CHANGE_FOCI: readonly ChangeFocus[] = [
  {
    id: "security",
    label: "Security",
    ask: "Security: anything touching sign-in, permissions, secrets or keys, input handling, file or network access, what is exposed and to whom, or new attack surface. Say plainly when nothing does.",
  },
  {
    id: "behavior",
    label: "What changes for users",
    ask: "Behaviour a user would notice: new or removed features, changed defaults, screens, wording, timing, notifications. Describe it as the user experiences it, not as code.",
  },
  {
    id: "deploy",
    label: "Deployment needed",
    ask: "Deployment: does any of this need a deploy or release before it takes effect, and of WHICH component — e.g. web app only, backend / server / cloud functions, a mobile, watch or desktop app that needs a store release, infrastructure or config, a database migration. Name the components from the paths. Say when nothing needs deploying (docs, tests, tooling only).",
  },
  {
    id: "data",
    label: "Data & migrations",
    ask: "Data: changes to stored data, schemas, file formats or migrations; anything irreversible or that touches existing users' data.",
  },
  {
    id: "breaking",
    label: "Breaking changes",
    ask: "Compatibility: changed APIs, config files, environment variables, CLI flags or URLs; whether older clients, devices or saved state keep working.",
  },
  {
    id: "deps",
    label: "Dependencies & cost",
    ask: "Dependencies and cost: packages added or upgraded, new external services, new paid API calls or anything that adds a running cost.",
  },
  {
    id: "surprises",
    label: "Surprises",
    ask: "Surprises: changes the commit messages do not mention, edits unrelated to the stated goal, debug leftovers, disabled or weakened checks and tests, TODOs left behind.",
  },
  {
    id: "check",
    label: "What to check by hand",
    ask: "Risk: how risky this is (low / medium / high, one reason), and a short list of things to try by hand afterwards. Say whether tests cover the change.",
  },
];

/** Every focus, ticked — what a phone that never chose starts with. */
export const DEFAULT_CHANGE_FOCI: readonly string[] = CHANGE_FOCI.map((f) => f.id);

/** A person's own focus, in their words. Longer is clipped on both ends alike. */
export const MAX_CHANGE_FOCUS_NOTE = 400;

/** The known ids among these, in the table's order. Unknown ids are dropped. */
export function cleanChangeFoci(ids: unknown): string[] {
  const want = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  return CHANGE_FOCI.filter((f) => want.has(f.id)).map((f) => f.id);
}

export function cleanChangeFocusNote(note: unknown): string {
  return typeof note === "string" ? note.trim().slice(0, MAX_CHANGE_FOCUS_NOTE) : "";
}

/** `POST /api/repos/:id/git/explain` — exactly one of `text` / `reason`. */
export interface ChangeBrief {
  /** The explanation, Markdown. Absent whenever there is not a real one. */
  readonly text?: string;
  /** Why there is none, in words a person reads. */
  readonly reason?: string;
  /** The ACCOUNT is out of quota — not an error, and a different sentence. */
  readonly limited?: boolean;
  /** Commits a push would send / a pull would bring, as read for this brief. */
  readonly push?: number;
  readonly pull?: number;
  /** The fetch before it failed — "to pull" is as of the last fetch that worked. Its sentence. */
  readonly fetchNote?: string;
  /** Part of a diff was cut to fit; the brief may not cover all of it. */
  readonly truncated?: boolean;
  /** What the call spent, as the CLI's envelope reported it — never estimated. */
  readonly spend?: ChangeBriefSpend;
}

/** One brief's spend. Every number is the envelope's; absent = not reported. */
export interface ChangeBriefSpend {
  /** `local`: the call went to a local model (`WATERPLANE_SIDECAR_EXPLAIN`) — no account was charged. */
  readonly engine: "claude" | "local";
  readonly model: string;
  /** `total_cost_usd` — the API list price of the call. */
  readonly usd?: number;
  /** Input tokens including cache reads and writes. */
  readonly inTok?: number;
  readonly outTok?: number;
  readonly durationMs: number;
}

/**
 * The Explain run in one worktree, as the host holds it (`explainjob.ts`): the
 * one running now, or the last one that finished — kept across a restart, so
 * reopening the sheet shows the last answer instead of asking for a new one.
 */
export interface GitExplainState {
  readonly running: boolean;
  /** Epoch ms the run started. */
  readonly startedAt: number;
  /** The foci and own-focus line it was asked under. */
  readonly foci: readonly string[];
  readonly note: string;
  /** Present once it ended. */
  readonly result?: ChangeBrief;
  readonly finishedAt?: number;
}
