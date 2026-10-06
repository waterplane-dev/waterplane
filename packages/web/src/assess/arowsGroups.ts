/**
 * Part of `assessRows.ts`, the barrel every caller imports — the strips, merge cards and the row head.
 * Pure, and its imports carry `.ts` because `node --test` loads it straight off the source.
 * Map of the slices: docs/notes/assess-architecture.md.
 */
import { ASSESS_VERDICTS, assessVerdictLabel, assessRowSentence, typedName, type AssessItem, type AssessMerge, type AssessProposal, type AssessRow, type AssessSource, type AssessVerdict, type ItemCategory } from "@waterplane/shared";
import { assessRetires, type AssessDisplayRow } from "./arowsDisplay.ts";
import { assessAcceptBlocker } from "./arowsAccept.ts";

/**
 * **The other answer to every row: no.**
 *
 * A screen that offers only agreement teaches one gesture, and the gesture it
 * teaches is the one that empties a backlog. Saying so explicitly costs a
 * button and buys the reading that a person who disagrees with a verdict has
 * somewhere to put that — `left alone` is then a state on the row rather than
 * the absence of a state, and the strip can count what is still undecided.
 *
 * `left alone` is the one label here that is not future tense, and it is not an
 * exception: leaving a row alone is not something `Apply` will do later, it is
 * the row's condition now and after.
 */
export const LEAVE_WORDS = {
  label: "leave it",
  picked: "left alone",
  title: "leave this one exactly as it is",
  pickedTitle: "un-mark it",
} as const;

// ── A merge ─────────────────────────────────────────────────────────────────

/**
 * The highest-stakes thing on the screen: N sentences a person wrote, replaced
 * by one a model wrote.
 *
 * So the card carries BOTH, whole — `prompt` and every original's `text` — plus
 * the ids it claims to be built from. Not a count, not a summary, and the strip
 * it lives in does not collapse.
 */
export interface AssessMergeCard {
  gid: string;
  /** The prompt that would replace them. Full text, never clipped. */
  prompt: string;
  rank?: number;
  /** Why the run says these are one job — the evidence each retired member
   *  keeps, from the shared module's own field. */
  rationale: string;
  /** Exactly what the group says it is built from, in its own order. */
  ids: string[];
  /** All N, words in full. */
  originals: AssessDisplayRow[];
  /** Ids the group cites whose words this device does not hold — stated, never
   *  quietly dropped, because a merge is approved on what it replaces. */
  missingIds: string[];
  /** What the run would CALL the row this posts. Carried on a merge for the
   *  same reason it is carried on a row — so the card shows what would be
   *  written — and absent when the run said nothing. */
  headline?: string;
  category?: ItemCategory;
}

// ── A strip ─────────────────────────────────────────────────────────────────

export interface AssessGroup {
  verdict: AssessVerdict;
  /** `assessVerdictLabel(verdict)`. */
  label: string;
  /**
   * The rows this strip draws — EMPTY on `merged`, deliberately.
   *
   * A merge card already renders every one of its originals in full, so the
   * strip drawing them as rows as well printed each original twice: once inside
   * the card it is being replaced by, and once on its own with a button that
   * refuses (`assessAcceptBlocker`'s "approve it on the merge itself"). Two
   * copies of one item, one of them dead, on the one screen whose job is to
   * make a person sure of what they are approving.
   */
  rows: AssessDisplayRow[];
  /** Only ever populated on the `merged` group. */
  merges: AssessMergeCard[];
  /**
   * **How many ITEMS this strip is about** — not how many things it draws.
   *
   * The same as `rows.length` everywhere except `merged`, where the rows are
   * empty and the items live inside the cards: there it is the members of every
   * card, deduped by id (a card may cite an id another card also cites, and a
   * head reading "5" over four items is a number nobody can reconcile). The
   * head counts items because that is what the person is deciding about; three
   * cards covering seven items is one sentence and seven is the number in it.
   */
  count: number;
  /** How many of `rows` a bulk accept would actually cover. */
  acceptable: number;
  /**
   * **How many of those a bulk accept would PUT BACK IN THE QUEUE** rather than
   * merely re-sort.
   *
   * Counted over the rows the bulk tap actually covers — the same set
   * `acceptable` counts — because it is the number that ends up in the
   * confirmation, and a count in a dialog that does not describe the tap behind
   * it is the badge-that-lies rule broken at the one moment it matters. On the
   * `wanted` strip it is what flips the bulk button to a confirmation at all
   * (`assessBulkWords`) and what makes the strip's `effect` say that a failed
   * row rejoins the queue.
   *
   * Zero on every other strip: `requeue` is the `still wanted` half alone.
   */
  failed: number;
  /** Whether a bulk accept on this strip must be confirmed first. */
  retires: boolean;
  /** Expanded on arrival: the strips that would take words away. */
  defaultOpen: boolean;
  /** Never collapsible. Merges only — see `AssessMergeCard`. */
  fixedOpen: boolean;
}

/**
 * The proposal, as strips.
 *
 * Order is `ASSESS_VERDICTS`', which is the shared module's declaration order
 * and the spec's: the retiring verdicts first, because they are the ones a
 * person has to disagree with, then what is still wanted, then what could not
 * be told. Empty strips are dropped — the header already states every count,
 * including the zeros, so a strip whose only content is "0" is a row of
 * furniture between the reader and the decisions.
 *
 * Within a strip, `wanted` is ordered by RANK — that is the entire content of
 * that verdict — and everything else keeps the order the items went in, which
 * is the order they were created in and the order the rest of the app lists
 * them in.
 */
export function assessGroups(proposal: AssessProposal, items: readonly AssessItem[]): AssessGroup[] {
  const byId = new Map<string, AssessItem>();
  for (const it of items) if (it && typeof it.id === "string" && it.id) byId.set(it.id, it);

  const display = (row: AssessRow): AssessDisplayRow => {
    const it = byId.get(row.id);
    const source: AssessSource = it?.source ?? "intent";
    const by = row.supersededBy ? byId.get(row.supersededBy) : undefined;
    return {
      id: row.id,
      verdict: row.verdict,
      source,
      text: it?.text ?? "",
      missing: !it,
      failed: it?.state === "failed",
      label: it?.label,
      headline: row.headline,
      category: row.category,
      verdictLabel: assessVerdictLabel(row.verdict),
      sentence: assessRowSentence(row),
      downgraded: row.downgraded,
      rank: row.rank,
      supersededBy: row.supersededBy,
      supersededByText: by?.text,
      gid: row.gid,
      acceptBlocked: assessAcceptBlocker(row.verdict, source, !it),
      row,
    };
  };

  const rows = proposal.rows.map(display);
  const cards = proposal.merges.map((m) => mergeCard(m, rows, byId, display));

  const out: AssessGroup[] = [];
  for (const v of ASSESS_VERDICTS) {
    const mine = rows.filter((r) => r.verdict === v);
    const merges = v === "merged" ? cards : [];
    if (!mine.length && !merges.length) continue;
    if (v === "wanted") {
      mine.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
    }
    // The cards are built from the FULL row list above, so emptying the merged
    // strip here cannot cost a card its originals — the order matters and is
    // the reason `mergeCard` is called before this loop rather than inside it.
    const shown = v === "merged" ? [] : mine;
    const members = new Set<string>();
    for (const c of merges) for (const o of c.originals) members.add(o.id);
    out.push({
      verdict: v,
      label: assessVerdictLabel(v),
      rows: shown,
      merges,
      count: v === "merged" ? members.size : mine.length,
      acceptable: shown.filter((r) => !r.acceptBlocked).length,
      failed: v === "wanted" ? shown.filter((r) => !r.acceptBlocked && r.failed).length : 0,
      retires: assessRetires(v),
      defaultOpen: assessRetires(v),
      // A merge is approved on what it replaces, so it is never behind a
      // disclosure that could be left shut.
      fixedOpen: v === "merged",
    });
  }
  return out;
}

function mergeCard(
  m: AssessMerge,
  rows: readonly AssessDisplayRow[],
  byId: ReadonlyMap<string, AssessItem>,
  display: (row: AssessRow) => AssessDisplayRow,
): AssessMergeCard {
  const originals: AssessDisplayRow[] = [];
  const missingIds: string[] = [];
  for (const id of m.ids) {
    const known = rows.find((r) => r.id === id);
    if (known) { originals.push(known); if (known.missing) missingIds.push(id); continue; }
    // A group may cite an id the ROW list does not carry (the row list is what
    // the proposal decided; the group is what it proposed). Render it from the
    // input if the input has it, and say so if nothing does.
    if (byId.has(id)) {
      originals.push(display({ id, verdict: "merged", evidence: m.rationale, gid: m.gid }));
    } else {
      missingIds.push(id);
    }
  }
  return {
    gid: m.gid, prompt: m.prompt, rank: m.rank, rationale: m.rationale, ids: [...m.ids],
    originals, missingIds, headline: m.headline, category: m.category,
  };
}

/**
 * **The line above a row's words, and everything it is allowed to say.**
 *
 * The row printed `label || id` over the full text, which on this screen — the
 * one screen whose rule is that the words are never clipped — made the FIRST
 * line of every row a clip of them. `Backlog`'s `add()` fills `label` with
 * `text.slice(0, 40)`, so the overwhelming majority of labels are a truncation
 * and not a name: "For this and all other things that need" above the sentence
 * it is the first forty characters of.
 *
 * The comparison is `@waterplane/shared`'s `typedName`, which is `backlogFilter.ts`'s
 * `realLabel` and `activityRows.ts`'s title rule — one predicate, three
 * surfaces. `realLabel` itself takes a `BacklogItem` and this is an
 * `AssessDisplayRow`, so the wrapper is not the reachable half; the 40 is
 * `add()`'s cut and is the caller's fact either way.
 *
 * `kind` is always said because the two stores are applied to differently and
 * the difference is the row's whole refusal (`assessAcceptBlocker`). `id` is
 * drawn only for a `missing` row, where it is genuinely the only handle a
 * person has on words this device cannot show — everywhere else it is a
 * database key over a sentence.
 */
export interface AssessRowHead {
  kind: "backlog item" | "pad note";
  /** A name somebody typed, never the first forty characters of the words. */
  name?: string;
  /** Only when the words are not on this phone. */
  id?: string;
  /**
   * **What this row is CALLED on this screen** — the typed name where there is
   * one, else the title this run proposes.
   *
   * `itemHeadline`'s order, said in this file's own terms: the person's words
   * win, the machine's stand where they put nothing. It is one field rather
   * than two so the head cannot draw both and make a reader work out which is
   * the row.
   */
  headline?: string;
  /** **Whose title `headline` is.** True only where it came from the run —
   *  which is what earns it the `Sparkles` mark, and what a person has to see
   *  before they read a line a model wrote as if it were their own. */
  suggested: boolean;
  /** The kind the run proposes, drawn as a chip. Absent means the run said
   *  nothing, and the head draws no chip — never a default bucket. */
  category?: ItemCategory;
}

/**
 * **The head names the row, and says whose name it is.**
 *
 * `kind` survives only where there is no headline at all. It is the weakest
 * thing the head can say — *backlog item* over a list of backlog items — and it
 * was the only thing there because there was nothing better; a title, whoever
 * wrote it, is strictly more use. Where it still matters it still appears:
 * a `pad note` with nothing to call it reads as a pad note, which is the one
 * case the word is doing work (the accept on such a row is refused, and the
 * refusal is about the store).
 */
export function assessRowHead(r: AssessDisplayRow): AssessRowHead {
  const name = typedName(r.label, r.text, 40);
  const head: AssessRowHead = {
    kind: r.source === "note" ? "pad note" : "backlog item",
    suggested: !name && !!r.headline,
  };
  if (name) head.name = name;
  const headline = name ?? (r.headline?.trim() || undefined);
  if (headline) head.headline = headline;
  if (r.category) head.category = r.category;
  if (r.missing) head.id = r.id;
  return head;
}
