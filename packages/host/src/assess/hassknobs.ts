/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/assess-architecture.md (host). */
import { env } from "../env.js";

/**
 * How long one assessment may take.
 *
 * `review.ts` allows 180 s to judge ONE task, usually against a diff. This
 * reads a whole repo — git history, the code the items name, the tests — and
 * then writes two documents, so the same number would fail every run on any
 * repo worth assessing and report it as "the CLI wrote no file". Twenty
 * minutes, overridable, because the honest bound is "how big is your repo" and
 * this daemon cannot know that.
 */
export const ASSESS_TIMEOUT_MS = Math.max(60_000, Number(env("ASSESS_TIMEOUT_MS")) || 20 * 60_000);

/**
 * `HeadlessRequest` asks every caller for one, and this is `review.ts`'s.
 *
 * Nothing here can reach it, and that is deliberate rather than lucky: this
 * caller is ALWAYS streamed (`runClaude` passes `onOut` unconditionally), and a
 * streamed run is spawned, not buffered. The gate used to be "watched ⇒
 * streamed", which made a call with no watcher — a future caller of
 * `runAssessment` that simply does not want the readings — put a `stream-json`
 * run through `execFile`'s buffer and get killed for succeeding loudly, with
 * the row reporting it as "the assessment wrote no file". Closing the hole
 * costs one folded object per chunk that nobody reads; documenting it would
 * have cost the next caller a repo read.
 */
export const ASSESS_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * How much of a watched run's stdout is KEPT.
 *
 * A stream-json run prints every tool result it takes, which for a repo read is
 * megabytes of file contents this daemon has no use for: the steps are folded
 * as they arrive and the file is the answer. What has to survive is the end —
 * the envelope, and any usage-limit notice printed with it.
 */
export const ASSESS_KEEP_BYTES = 256 * 1024;

/**
 * How many FINISHED rows the run go in as context.
 *
 * Finished work is how the CLI tells that the thing next to it was already
 * built, so it earns its place — but a repo with nine hundred done rows would
 * put nine hundred prompts into a file whose whole point is that it is cheap to
 * read. The newest are the ones that explain the current state of the code.
 */
export const ASSESS_CONTEXT_MAX = 60;

/**
 * How many runs the sidecar keeps.
 *
 * A proposal is worth having until it is applied or a newer one replaces it,
 * and worth nothing much after that. Eviction never touches a run that is still
 * `running` — the store's rule, not a timer's — and never the newest run for a
 * repo, which is the one the sheet opens.
 */
export const ASSESS_MAX_RUNS = 40;

/** Which lifecycle states a row is asked ABOUT, and which it merely provides. */
/**
 * Which rows an assessment may judge — and, because it is the same question,
 * which rows a naming pass may title (`naming.ts` imports this rather than
 * spelling it again).
 *
 * Two spellings of "open work" is two lists that drift, and the one that drifted
 * would be the one nobody reads: a naming pass that titled `done` rows would put
 * a machine's words on work nobody is going to look at again, and one that
 * missed `blocked` would leave the rows a person is most likely to be staring at
 * as the only untitled ones in the list.
 */
export const ASSESSABLE_STATES = new Set(["queued", "blocked", "failed"]);
export const CONTEXT_STATES = new Set(["running", "starting", "done", "canceled"]);