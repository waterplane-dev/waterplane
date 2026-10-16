/**
 * **Titling a repo's backlog, and the one thing that is never allowed to
 * happen while it does.**
 *
 * A backlog row shows the first line of whatever somebody typed into it. That
 * is honest and it does not scan: forty rows of "I keep losing the scroll
 * position when I rotate the phone and come back to the…" is a list a person
 * reads by reading, which on a phone means not reading it at all. So this is
 * the cheapest call in the daemon — no repo, no git, no tools, one toolless
 * completion over the items' own words — writing a THREE-TO-EIGHT-WORD title
 * and one of four kinds onto rows that have none.
 *
 * ── The rule the whole file is arranged around ─────────────────────────────
 *
 * **A name a PERSON typed is never replaced.** `IntentManager.name()` enforces
 * it on the write (`*By !== "hand"`), `buildNamingInput` never even shows such
 * a field to the model, and the sentence at the end SAYS how many fields were
 * left alone because of it. Three layers for one rule, because this is the one
 * write in this app where a machine puts its words on top of a person's, in the
 * place the person looks first — CLAUDE.md's *never overwrite typed words with
 * words nobody typed*, applied to the one field that sits above the words.
 *
 * ── What it costs, and why that shape ──────────────────────────────────────
 *
 * The measurement in `sidecar/sidecarname.ts` (`runTextTask`'s
 * `--thinking disabled`): the cost of a pass like this is THINKING, not input. So `NAME_SYSTEM`
 * ends by asking for the answer straight away, `runNameTask` runs
 * `--thinking disabled`, and the task is toolless — which also makes it one of
 * the three that MAY be routed at a local model (`WATERPLANE_SIDECAR_NAME`), and the
 * one most worth routing, since it is pure text-shaping over words already in
 * the prompt.
 *
 * ── Batches, and why the words go in WHOLE ─────────────────────────────────
 *
 * `NAME_BATCH_ITEMS` / `NAME_BATCH_CHARS` cut the repo into calls. Nothing is
 * ever CLIPPED to make an item fit: an item too long for the budget goes in a
 * batch of its own, at full length. A sorter could clip and mark the
 * clip, because a clipped item can still be SORTED. A title is not like that. The half of a prompt a clip keeps is the half
 * this app already shows on the row, so a title written from it can only ever
 * be the truncation it was asked not to be, which `cleanHeadline` then refuses
 * — money spent to produce a drop.
 *
 * ── Every failure is the empty result ──────────────────────────────────────
 *
 * A refused route, a dead server, an account block, an answer nothing can be
 * parsed out of: each writes nothing and says so in one sentence. That is how
 * every other caller of `sidecar.ts` treats a failure, and here it costs
 * exactly what it costs elsewhere — the rows go on being called what they were
 * already called, which is their own first line.
 *
 * Reasoning: `docs/notes/host.md`. Pinned by `packages/host/test/naming.test.mjs`
 * and `scripts/e2e-naming.mjs`.
 */
import type { Intent, ItemName } from "@waterplane/shared";
import { cleanNamingDoc, typedName } from "@waterplane/shared";
import { ASSESSABLE_STATES } from "./assess.js";
import { runNameTask, type NameRequest, type NameRun } from "./sidecar.js";
import { env } from "./env.js";
import { promptText } from "./prompts.js";

// ── The knobs ───────────────────────────────────────────────────────────────

/** The model the claude engine runs on. `.env.example` carries the why. */
export const NAME_MODEL = env("NAME_MODEL") || "haiku";

/**
 * How long one batch may take.
 *
 * A plain constant and not an environment knob, deliberately: unlike the smart
 * pick, nothing is HELD behind this call — no item is waiting to fire, no
 * session is blocked, a person tapped a button and the backlog is still theirs
 * to use while it thinks. So the sidecar's own generous default is the right
 * number for the same reason it is the right number there (ollama cold-loads an
 * idle model), and a second variable to tune it would be a knob nobody has a
 * reason to turn.
 */
export const NAME_TIMEOUT_MS = 120_000;

/** How many items go in one call. */
export const NAME_BATCH_ITEMS = 20;

/**
 * …and how many characters, which is the cap that actually bites.
 *
 * Twenty prompts of ordinary length is a few thousand tokens; twenty prompts
 * from the repo that writes essays into its backlog is not. The count is the
 * cheap bound and this is the honest one.
 */
export const NAME_BATCH_CHARS = 40_000;

/**
 * The contract, pinned.
 *
 * Every clause is enforced somewhere else as well — the shape by
 * `cleanNamingDoc`, the caps by `cleanHeadline`, the four kinds by
 * `cleanCategory`, the id by the batch it was sent — so nothing here is the
 * only thing standing between a wrong answer and a written row. What it buys is
 * the answer being right the FIRST time, which is the difference between a pass
 * that titles eleven rows and one that titles none and writes four notes.
 *
 * The last line (*answer straight away*) is there for the measured reason:
 * cost is thinking, not input.
 */
export const NAME_SYSTEM = [
  "You title backlog items. For each item answer JSON only:",
  '{"items":[{"id":…,"headline":"3–8 words, not the item\'s first words","category":"bug|feature|enhancement|chore"}]}.',
  "Omit category when none fits.",
  "Answer straight away.",
].join("\n");

// ── What a pass is asked about ──────────────────────────────────────────────

/** One row in a batch, as this module knows it. */
export interface NamingTargetRow {
  readonly id: string;
  /** The item's own words, IN FULL — never clipped. See the header. */
  readonly text: string;
  /** A title this row already has from a person. The pass may still be asked
   *  about it (its KIND may be missing), and the write will refuse it. */
  readonly handHeadline: boolean;
  readonly handCategory: boolean;
}

/** One call's worth. */
export interface NamingBatch {
  readonly rows: readonly NamingTargetRow[];
  readonly chars: number;
}

/** The slice of the intent store a naming pass may reach.
 *
 *  Two methods, and the absence of every other one is the point: nothing here
 *  can run a row, move a row, retire a row or edit its words. The worst a
 *  naming pass can do is put a wrong title on something, which costs one tap. */
export interface NamingIntents {
  list(): Intent[];
  name(id: string, n: ItemName, by: "name"): { headline: boolean; category: boolean };
}

/**
 * Is there a field on this row a MACHINE is allowed to write?
 *
 * Both halves are asked separately, because a row whose title a person typed
 * and whose kind nobody ever set is the ordinary case: refusing the whole row
 * on one `hand` field would leave that kind unset for ever.
 *
 * The author clause reads as redundant today — the store drops the pair
 * together, so an absent value already means an absent author — and it is kept
 * because it is the RULE rather than a consequence of how the store happens to
 * clean. If a value ever survives without its author, this line is what keeps a
 * person's name out of a machine's reach.
 *
 * ── A typed `label` IS a title, and this has to agree with the display ──────
 *
 * `itemHeadline` is the ONE display rule and it says a typed `label` beats a
 * headline, ALWAYS. So a row whose label a person typed already has a title on
 * every screen, and a headline bought for it is a headline nothing will ever
 * show. With the phone's own `ids` the two agreed by accident — the cut was
 * computed under the display rule — but a pass with `ids: []`, or one run
 * against a cut a moment out of date, spent real money on rows that were
 * already named. The test is `itemHeadline`'s own (`typedName(label, text, 40)`,
 * the backlog's slice length), because two spellings of "does this row have a
 * title" is exactly the disagreement this is fixing.
 */
function needsName(i: Intent): boolean {
  const text = i.payload.kind === "prompt" ? i.payload.steps[0] ?? "" : "";
  const titled = !!i.headline || !!typedName(i.label, text, 40);
  const wantsHeadline = !titled && i.headlineBy !== "hand";
  const wantsCategory = !i.category && i.categoryBy !== "hand";
  return wantsHeadline || wantsCategory;
}

/**
 * The repo's untitled rows, cut into calls.
 *
 * `ids`, when given, is the cut a person asked about; every row in it is still
 * put through the same four filters, so a scope naming another repo's rows, a
 * finished row or an already-titled one simply produces fewer batches rather
 * than a pass that titles things nobody asked about.
 *
 * Order is the store's own (`list()` is newest first), which is the order the
 * phone shows — so a person watching a pass sees it work down the list they are
 * looking at rather than through an order only this file knows.
 */
export function buildNamingInput(
  intents: NamingIntents,
  cwd: string,
  ids?: readonly string[],
): NamingBatch[] {
  const scope = ids?.length ? new Set(ids) : null;
  const rows: NamingTargetRow[] = [];
  for (const i of intents.list()) {
    if (i.cwd !== cwd) continue;
    if (i.payload.kind !== "prompt") continue;
    if (!ASSESSABLE_STATES.has(i.state)) continue;
    if (scope && !scope.has(i.id)) continue;
    if (!needsName(i)) continue;
    rows.push({
      id: i.id,
      text: i.payload.steps[0] ?? "",
      handHeadline: i.headlineBy === "hand",
      handCategory: i.categoryBy === "hand",
    });
  }

  const batches: NamingBatch[] = [];
  let cur: NamingTargetRow[] = [];
  let chars = 0;
  const flush = (): void => {
    if (!cur.length) return;
    batches.push({ rows: cur, chars });
    cur = [];
    chars = 0;
  };
  for (const r of rows) {
    // Flushed BEFORE the row is added, and only when there is something to
    // flush: that is what puts an over-budget item in a batch of its own at
    // full length instead of clipping it or refusing it.
    if (cur.length && (cur.length >= NAME_BATCH_ITEMS || chars + r.text.length > NAME_BATCH_CHARS)) flush();
    cur.push(r);
    chars += r.text.length;
  }
  flush();
  return batches;
}

/** One batch, as the JSON the model reads. The words go in whole. */
export function namingPrompt(batch: NamingBatch): string {
  return JSON.stringify({
    items: batch.rows.map((r) => ({ id: r.id, text: r.text })),
  });
}

// ── What came back ──────────────────────────────────────────────────────────

/**
 * The JSON inside whatever the model actually answered.
 *
 * `assess/hassutil.ts`'s `parseLoose` in spirit (a fence is unwrapped, not
 * refused), plus the outermost `{…}`/`[…]` slice, and a bare ARRAY is
 * accepted: an array of `{id, headline}` objects is
 * unambiguous, `cleanNamingDoc` already reads that shape, and every entry in it
 * still has to name an id that was in the batch before anything is written.
 */
export function parseNamingText(raw: string): unknown {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const tries: string[] = [text];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fence) tries.push(fence[1].trim());
  const open = text.search(/[{[]/);
  const close = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (open >= 0 && close > open) tries.push(text.slice(open, close + 1));
  for (const t of tries) {
    try {
      const v: unknown = JSON.parse(t);
      if (v && typeof v === "object") return v;
    } catch { /* next shape */ }
  }
  return null;
}

/** What one whole pass did. */
export interface NamingResult {
  /** Rows that came out of this with at least one field written. */
  named: number;
  /** Rows the pass was asked about and did not name. */
  unnamed: number;
  /** FIELDS the pass offered and the store refused because a person had
   *  already written them. Not a failure — it is the rule working, and it is
   *  worth a number because it is the only place the rule is visible. */
  kept: number;
  /** Why NOTHING was written, when nothing was. Absent on an ordinary pass. */
  detail?: string;
}

/**
 * **The sentences, in one pure function.**
 *
 * Here rather than inline in `run()` because it is the whole of what a person
 * sees of this feature, and a string assembled inside an async method is a
 * string that can only be checked by running a pass. Every wording rule this
 * app already has is in it: a count that is zero is not mentioned, a failure
 * says what failed rather than that something did, and nothing claims a number
 * it did not measure.
 */
export function namingSentence(r: NamingResult): string {
  // A pass that wrote nothing says why, and only why: "named 0" is a sentence
  // that reads like a result when it is an explanation that went missing.
  if (!r.named) {
    return `nothing written — ${r.detail || (r.unnamed
      ? "the model gave no usable title"
      : "nothing here needed a title")}`;
  }
  const parts = [`named ${r.named}`];
  if (r.unnamed) parts.push(`${r.unnamed} left unnamed — the model gave no usable title`);
  if (r.kept) parts.push(`${r.kept} kept the name you typed`);
  // A pass that wrote SOME rows and then hit a wall says both: the rows it
  // wrote are real, and the reason the rest are missing is the only thing that
  // explains a half-titled list.
  if (r.detail) parts.push(r.detail);
  return parts.join(" · ");
}

/**
 * What the ACK says, now that the ack no longer waits for the pass.
 *
 * Here beside `namingSentence` and not inline in the route, for
 * `namingSentence`'s reason: it is what a person reads, so it is checkable
 * without spawning anything. It says the NUMBER because that is the one fact
 * the tap does not already carry — "it started" is visible in the list, "it is
 * working on eleven of these" is not — and it promises the sentence that
 * follows, because a screen that goes quiet for two minutes after a tap is a
 * screen nobody taps twice.
 */
export function namingStartedNote(rows: number): string {
  return `titling ${rows} item${rows === 1 ? "" : "s"} — this runs on, and will say what it wrote`;
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface NamingDeps {
  readonly intents: NamingIntents;
  /** Broadcast the backlog — called when a pass starts and when it ends, since
   *  the rows it is working on ride the snapshot as a TRANSIENT (`naming`). */
  readonly onChange: () => void;
  /** The completion. Injected so the tests and the e2e can drive a pass with no
   *  model at all. */
  readonly run?: (req: NameRequest) => Promise<NameRun>;
}

/**
 * One naming pass per repo at a time, and the rows each one is working on.
 *
 * `running` is the map the backlog snapshot reads: it is TRANSIENT, exactly as
 * `waiting` is — memory only, gone with a restart, and meaning "right now",
 * never "this row is being renamed and you may not touch it". Nothing is locked
 * while a pass thinks; the worst an edit mid-pass can do is have its row titled
 * a second later, and `IntentManager.name()` re-reads the live row before it
 * writes, so a title a person types in that window is `hand` by the time the
 * answer lands and is refused.
 */
export class NamingManager {
  /** repoDir → the ids a live pass is working on. */
  readonly running = new Map<string, Set<string>>();

  constructor(private deps: NamingDeps) {}

  /** Every row any live pass is working on, flattened — the snapshot's shape. */
  runningIds(): string[] {
    const out: string[] = [];
    for (const set of this.running.values()) for (const id of set) out.push(id);
    return out;
  }

  /**
   * Title what is untitled in this repo.
   *
   * **Both refusals are SENTENCES**, because both are answers a person needs
   * rather than errors: "one is already running" and "there is nothing here to
   * title" are different facts, and a tap that produced silence would be a
   * button that sometimes does nothing for reasons nobody can see
   * (`Unavailable.tsx`'s rule, reached through a verb).
   *
   * One at a time per repo, for `startAssessment`'s reason narrowed to one
   * field: two passes over one list write two titles onto the same rows in an
   * order nobody chose, and the second one wins by accident.
   */
  async start(repoDir: string, ids?: readonly string[]): Promise<string> {
    const r = this.begin(repoDir, ids);
    return "refusal" in r ? r.refusal : r.finished;
  }

  /**
   * **The refusals, decided while there is still a socket to refuse on — and
   * the pass itself, handed back rather than awaited.**
   *
   * `startAssessment`'s shape, for the reason a review measured here: the route
   * is `durable: true`, so the phone is holding an op open across this call. A
   * pass is up to ten SEQUENTIAL batches at up to `NAME_TIMEOUT_MS` (120 s)
   * each; the phone's ack deadline is 20 s and it gives up after 8 attempts.
   * So a pass that was working perfectly was re-sent eight times (suppressed by
   * `opsInFlight`, so nothing was bought twice) and then shown as FAILED while
   * it was still running — after which the host sent up to eight acks for it.
   *
   * The split is therefore not cosmetic. Everything that can answer a person
   * NOW — one already running, nothing here to title — answers now, and the
   * pass's own sentence goes back as the toast it always was, whenever it
   * lands. The rows being worked on ride the snapshot as a transient
   * (`running`), which is what the list shows in the meantime.
   */
  begin(repoDir: string, ids?: readonly string[]):
  { refusal: string } | { rows: number; finished: Promise<string> } {
    if (this.running.has(repoDir)) {
      return { refusal: "a naming pass is already running for this repo — two of them would write different titles onto the same rows" };
    }
    const batches = buildNamingInput(this.deps.intents, repoDir, ids);
    if (!batches.length) {
      return {
        refusal: ids?.length
          ? "nothing in that cut needs a title — those rows are finished, not this repo's, or already named"
          : "nothing here needs a title — every open item already has one",
      };
    }

    const live = new Set<string>();
    for (const b of batches) for (const r of b.rows) live.add(r.id);
    this.running.set(repoDir, live);
    this.deps.onChange();
    const finished = this.run(repoDir, batches)
      .then((r) => namingSentence(r))
      // A throw out of the pass is the empty result this module treats every
      // other failure as — and it must reach the same sentence, or the only
      // thing a person sees of a pass that died is the row-set going quiet.
      .catch((e: unknown) => namingSentence({
        named: 0, unnamed: live.size, kept: 0,
        detail: (e as Error)?.message || "the naming pass could not be run",
      }))
      .finally(() => {
        // In a `finally` because a throw anywhere below must not leave the repo
        // holding a pass nothing will ever release — the refusal above would
        // then be permanent, and the only way back would be a restart.
        this.running.delete(repoDir);
        this.deps.onChange();
      });
    return { rows: live.size, finished };
  }

  /**
   * The batches, one after another.
   *
   * SEQUENTIAL and not parallel: the point of the batches is that one call is
   * small, and three of them at once is one large call with extra sockets. It
   * also makes the account block below mean something — the first batch to come
   * back limited stops the rest, instead of four more calls being spent finding
   * out the same thing.
   */
  private async run(repoDir: string, batches: readonly NamingBatch[]): Promise<NamingResult> {
    const runner = this.deps.run ?? runNameTask;
    const out: NamingResult = { named: 0, unnamed: 0, kept: 0 };
    let detail: string | undefined;

    for (const batch of batches) {
      let run: NameRun;
      try {
        run = await runner({
          cwd: repoDir,
          prompt: namingPrompt(batch),
          system: promptText("tab-name", NAME_SYSTEM),
          model: NAME_MODEL,
          timeoutMs: NAME_TIMEOUT_MS,
        });
      } catch (e) {
        // The empty result, the way every other sidecar caller treats one: a
        // throw out of the runner is not different in kind from a server that
        // answered nothing, and nothing here is half-written.
        detail = (e as Error)?.message || "the naming pass could not be run";
        out.unnamed += batch.rows.length;
        break;
      }

      if (run.limited) {
        detail = run.detail || "the account is out of quota";
        out.unnamed += batch.rows.length;
        break;
      }
      if (run.failed || !run.text) {
        detail = run.detail || "the model answered nothing";
        out.unnamed += batch.rows.length;
        continue;
      }

      // `{id, text}` and nothing else: the words are what lets the "this title
      // is only the item's first line" rule run at all, and the hand flags are
      // this module's bookkeeping, not part of the judgement.
      const { names } = cleanNamingDoc(
        parseNamingText(run.text),
        batch.rows.map((r) => ({ id: r.id, text: r.text })),
      );

      for (const row of batch.rows) {
        const n = names[row.id];
        if (!n) { out.unnamed++; continue; }
        // Counted BEFORE the write, off what the pass OFFERED and what the row
        // already had: after the write both look the same, and "your title was
        // kept" is the only place this feature's one rule is visible.
        if (n.headline !== undefined && row.handHeadline) out.kept++;
        if (n.category !== undefined && row.handCategory) out.kept++;
        const wrote = this.deps.intents.name(row.id, n, "name");
        if (wrote.headline || wrote.category) out.named++;
        else out.unnamed++;
      }
    }

    if (detail) out.detail = detail;
    return out;
  }
}
