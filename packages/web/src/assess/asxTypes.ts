/**
 * The sheet's props.
 * Part of `AssessSheet.tsx`, the facade every caller imports; map and rules: docs/notes/assess-architecture.md.
 */
import type { AssessChoices, AssessItem, AssessRun } from "@waterplane/shared";
import type { AssessReadyRow } from "../assessRows";
import type { OutboxEntry } from "../outbox";
import type { ResourceState } from "../useRemoteResource";

export interface AssessSheetProps {
  /** The worktree the run was about, and the name a person reads. */
  repoDir: string;
  repoName: string;
  /**
   * The same repo as an ID, which is what a file lookup takes.
   *
   * Two fields for one repo because they answer different questions: the host
   * addresses a worktree by PATH (`repoDir`, what a run is scoped to) and
   * addresses a file inside one by repo id (`api.artifactUrl`, `api.inbox`).
   * `AttachStrip` wants the second, so every picture on this screen needs it.
   */
  repoId: string;
  /** The live send queue — what `AttachStrip` reads to decide `sending`, so a
   *  file still on its way out of this phone is drawn as that and not as
   *  missing. Handed down unchanged; this sheet never writes it. */
  outbox: readonly OutboxEntry[];
  /**
   * The newest run for this repo, or `null` when none has ever run here.
   *
   * The proposal rides on it (`AssessRun.proposal`), which is why there is one
   * prop and not two: a proposal without the run that produced it cannot say
   * when it was made or whether it has already been applied.
   *
   * So do the WORDS (`AssessRun.input`). There was an `items` prop here, meant
   * to be assembled by the caller out of the state it already holds, and it was
   * wrong for a reason that only shows up later: the proposal's ids name the
   * snapshot that was ASSESSED, and current state drifts the moment anything is
   * posted, edited or sent mid-run — so the caller's array would render today's
   * sentence under yesterday's verdict, in the one screen whose entire job is
   * that you approve what you read. The run holds what it judged; this sheet
   * reads it; the caller holds nothing.
   */
  run: AssessRun | null;
  /** false = no socket. Applying and running both happen on the desktop. */
  online: boolean;
  /**
   * How this device's copy of `run` was obtained, for `Empty`'s ladder.
   *
   * Optional: with it absent the sheet says "loading" while online and nothing
   * has arrived, and "offline" otherwise. Pass it when the caller knows better
   * — in particular `cached` with an `age`, which is the one state a screen must
   * never claim to be current in.
   */
  res?: { state: ResourceState; age?: number | null; error?: string | null };
  /** A run or an apply this device has already asked for and not seen answered.
   *  Keeps the two buttons from being pressed twice into the same durable op. */
  busy?: boolean;
  /** The host's own sentence when the usage budget is closed, or null. Rendered
   *  as the run button's refusal verbatim — the budget is the host's rule and
   *  restating it here would make two wordings of one fact. */
  budgetNote?: string | null;

  /**
   * **The cut the sheet was opened with**, or null for the whole repo — what
   * *run again* will be scoped to.
   *
   * Deliberately NOT read off `run.scopedIds`: that says what the run ON SCREEN
   * judged, which is a fact about the past, and re-running is a decision about
   * now. The two differ exactly when somebody filters the backlog and taps
   * assess with an older, wider proposal already on file — the case this field
   * exists for, and the one where reusing the old run's scope would silently
   * answer a different question than the button says.
   */
  scope?: string[] | null;
  /** Start an assessment for this repo (`assess.run`, durable). Must say
   *  something: a toast, or the row appearing in Activity. */
  onRun: () => void;
  /** Apply exactly these approvals (`assess.apply`, durable). Everything not in
   *  here stays as it is; nothing is deleted either way. */
  onApply: (choices: AssessChoices) => void;
  /** Throw the proposal away without applying any of it. Optional: with it
   *  absent the button is not drawn. */
  onDiscard?: () => void;
  /**
   * **Open** the run's `.waterplane/plan.md` in the viewer — the document worth
   * having in a week — given the repo-relative path the run recorded.
   *
   * It READS the document. It used to put the path into the compose box, which
   * is the right act for "here is a file" everywhere else in this app and the
   * wrong one here: the person holding this screen has just been asked whether
   * they agree with eighty-four verdicts, and the thing that would settle it is
   * the run's own write-up — not a path pasted into a prompt they were not
   * writing. Nothing is run, and the ticks are kept (see the header).
   */
  onOpenPlan?: (planPath: string) => void;
  /** Show one item where its words actually live (its Activity row, its pad
   *  note). Optional; the "open" button appears only when it is given. */
  onOpenItem?: (item: AssessItem) => void;
  /**
   * **This repo's LIVE backlog rows** — the only live state this sheet reads,
   * and it reads it for exactly one thing.
   *
   * The proposal is deliberately a snapshot (`run.input.items`, see `run`
   * above): today's sentence under yesterday's verdict is the one thing this
   * screen must never draw. This is the other side of that rule rather than an
   * exception to it — the route out of the sheet is a claim about what is on
   * the desktop NOW, after the apply, and a snapshot cannot make it. Nothing
   * else on the screen touches this array.
   *
   * Scoped to this repo by the caller, in the order the backlog draws — and it
   * is the BACKLOG list, not the intent list: the cut's ids have to be ids
   * `Backlog` can filter to, and an intent that is a build, a launch or a
   * schedule is not a row waiting in anybody's backlog.
   */
  backlog?: readonly AssessReadyRow[];
  /**
   * Open the Backlog focused on exactly these rows. Optional: with it absent
   * the route after an apply is not drawn at all.
   */
  onOpenBacklog?: (ids: string[], label: string) => void;
  onClose: () => void;
}
