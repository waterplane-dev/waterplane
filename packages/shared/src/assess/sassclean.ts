/** A slice of assess.ts — moved whole from assess.ts, see docs/notes/shared-architecture.md. */
import type { ItemCategory } from "../naming.js";
import { categoryDropNote, cleanCategory, cleanHeadline, headlineDropNote } from "../naming.js";
import { ASSESS_VERDICTS, type AssessVerdict, MAX_ASSESS_NOTES, MAX_EVIDENCE_CHARS, MAX_MERGE_GROUPS, MAX_MERGE_SIZE, MAX_NEW, MAX_PROMPT_CHARS, MAX_RANK, MAX_RATIONALE_CHARS, MIN_MERGE_SIZE } from "./sassvocab.js";
import { type AssessDowngrade, type AssessItem, type AssessMerge, type AssessNew, type AssessProposal, type AssessRow } from "./sassio.js";

// ── Cleaning ─────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

const rankOf = (v: unknown): number | undefined => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(MAX_RANK, Math.max(0, n));
};

const verdictOf = (v: unknown): AssessVerdict | null => {
  const s = str(v).toLowerCase().replace(/[\s-]/g, "_");
  const hit = ASSESS_VERDICTS.find((x) => x === s);
  return hit ?? null;
};

/** Prose the CLI wrote, read from any of the field names it plausibly used. */
const promptOf = (v: Record<string, unknown>): string =>
  (typeof v.prompt === "string" ? v.prompt : typeof v.text === "string" ? v.text : "").trim();

interface Draft {
  verdict: AssessVerdict;
  evidence: string;
  rank?: number;
  by?: string;
  gid?: string;
  down?: AssessDowngrade;
  headline?: string;
  category?: ItemCategory;
  /** The CLI named a verdict for this id (as opposed to it being invented by
   *  the "nobody mentioned it" rule) — which is what makes it a CONFLICT when
   *  the same id also turns up in a merge group. */
  stated: boolean;
}

/**
 * Whatever the CLI wrote, plus the items it was asked about, in — a proposal
 * that cannot retire anything on nothing, out.
 *
 * Tolerant about SHAPE and strict about CLAIMS, and the asymmetry is the point.
 * A document that is an array rather than an object, a verdict spelled
 * `NOT-DONE`, a rank as a string, a rationale under `note` — all of that is
 * cosmetics, and refusing the run over it just means the user taps the button
 * again and pays twice. What is never tolerated is a conclusion that would
 * retire someone's words with nothing behind it.
 */
export function cleanAssessment(raw: unknown, input: readonly AssessItem[]): AssessProposal {
  const notes: string[] = [];
  const note = (s: string): void => { if (notes.length < MAX_ASSESS_NOTES) notes.push(s); };

  // ── The two naming drops, counted rather than narrated ───────────────────
  // A run names EVERY row it was given, so one note per bad name would be a
  // scroll in place of a sheet — sixty sentences saying the same thing about
  // sixty rows, and the fact worth showing is how many, not which. So each kind
  // of drop is counted here and said once at the end.
  //
  // Only a name with something in it is counted: an empty string is not a title
  // anybody lost, and reporting it would inflate the one number a reader uses
  // to judge whether the naming was any good.
  let headlineDrops = 0;
  let categoryDrops = 0;
  const headlineOf = (raw: unknown, text: string): string | undefined => {
    const out = cleanHeadline(raw, text);
    if (out === undefined && typeof raw === "string" && raw.trim()) headlineDrops++;
    return out;
  };
  const categoryOf = (raw: unknown): ItemCategory | undefined => {
    const out = cleanCategory(raw);
    if (out === undefined && typeof raw === "string" && raw.trim()) categoryDrops++;
    return out;
  };
  /** The naming, spread onto a row only when there IS one — an explicit
   *  `undefined` key is a field a reader has to look past. */
  const naming = (d?: Draft): { headline?: string; category?: ItemCategory } => ({
    ...(d?.headline ? { headline: d.headline } : {}),
    ...(d?.category ? { category: d.category } : {}),
  });

  // ── The input index ──────────────────────────────────────────────────────
  // `items` is everything the CLI was allowed to READ; `assessable` is the
  // subset it is allowed to DECIDE about.
  const items = new Map<string, AssessItem>();
  const assessable: string[] = [];
  for (const it of input) {
    if (!it || typeof it.id !== "string" || !it.id || items.has(it.id)) continue;
    items.set(it.id, it);
    if (!it.context) assessable.push(it.id);
  }
  const canDecide = new Set(assessable);

  const doc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const rawRows = Array.isArray(raw) ? arr(raw) : arr(doc.items).length ? arr(doc.items) : arr(doc.rows);
  const rawMerges = arr(doc.merges);
  const rawNew = arr(doc.new).length ? arr(doc.new) : arr(doc.newItems);

  // ── 1. The stated verdicts ───────────────────────────────────────────────
  const draft = new Map<string, Draft>();
  const duplicated = new Set<string>();
  for (const r of rawRows) {
    const id = str(r.id);
    if (!id) continue;
    if (!canDecide.has(id)) {
      note(items.has(id)
        ? `“${id}” was given as context only, so the verdict on it was ignored.`
        : `a verdict for “${id}”, which was not in the list, was dropped.`);
      continue;
    }
    if (draft.has(id)) { duplicated.add(id); continue; }
    const v = verdictOf(r.verdict);
    draft.set(id, {
      verdict: v ?? "unclear",
      down: v ? undefined : "unknown-verdict",
      stated: true,
      evidence: clip(str(r.evidence) || str(r.reason) || str(r.note), MAX_EVIDENCE_CHARS),
      rank: rankOf(r.rank),
      by: str(r.supersededBy) || str(r.by) || undefined,
      gid: str(r.gid) || str(r.group) || undefined,
      // Judged against the item's OWN words, so a "title" that is just the
      // opening of the sentence below it is recognised as the truncation it is.
      headline: headlineOf(r.headline ?? r.title, items.get(id)?.text ?? ""),
      category: categoryOf(r.category ?? r.kind),
    });
  }
  // Two verdicts for one id say two different things about what happens to it.
  // Neither is trustworthy, so neither is used.
  for (const id of duplicated) {
    const d = draft.get(id);
    if (!d) continue;
    d.verdict = "unclear";
    d.down = "duplicate";
    // The naming goes with the verdict. Two rows were written about this id and
    // only one of them is in hand; keeping its title would be picking one of the
    // two answers at random, which is the thing the duplicate rule refuses.
    d.headline = undefined;
    d.category = undefined;
    note(`“${id}” was given more than one verdict, so none of them was used.`);
  }

  // ── 2. Candidate merge groups ────────────────────────────────────────────
  const candidates: AssessMerge[] = [];
  const gids = new Set<string>();
  for (const m of rawMerges) {
    if (candidates.length >= MAX_MERGE_GROUPS) {
      note(`only the first ${MAX_MERGE_GROUPS} merge groups were considered.`);
      break;
    }
    // A missing group id is bookkeeping, not substance — the ids and the prompt
    // are the group. Minting one keeps a real merge alive; refusing over it
    // would throw away work to protect a label.
    const gid = clip(str(m.gid) || str(m.id) || `m${candidates.length + 1}`, 40);
    if (gids.has(gid)) { note(`a second merge group called “${gid}” was dropped.`); continue; }

    const prompt = promptOf(m);
    if (!prompt) { note(`merge group “${gid}” had no prompt, so it was dropped.`); continue; }
    if (prompt.length > MAX_PROMPT_CHARS) {
      note(`merge group “${gid}” proposed a prompt over ${MAX_PROMPT_CHARS} characters; it was dropped rather than cut short.`);
      continue;
    }

    const cited = (Array.isArray(m.ids) ? m.ids : []).filter((x: unknown): x is string => typeof x === "string");
    const ids = [...new Set(cited.map((x) => x.trim()).filter(Boolean))].filter((id) => canDecide.has(id));
    if (ids.length < cited.length) {
      note(`merge group “${gid}” named ${cited.length - ids.length} item(s) that were not in the list; they were dropped from it.`);
    }
    if (ids.length > MAX_MERGE_SIZE) {
      note(`merge group “${gid}” had ${ids.length} items — over the limit of ${MAX_MERGE_SIZE} — so it was dropped and its items kept their own words.`);
      continue;
    }

    gids.add(gid);
    candidates.push({
      gid,
      ids,
      prompt,
      rank: rankOf(m.rank),
      rationale: clip(str(m.rationale) || str(m.reason) || str(m.note), MAX_RATIONALE_CHARS),
      // Judged against the group's OWN prompt, which is the text the posted row
      // will carry — the same "is this a name or a truncation" test every other
      // row gets, asked about the words that will actually sit under it.
      ...headlineNaming(headlineOf(m.headline ?? m.title, prompt), categoryOf(m.category ?? m.kind)),
    });
  }

  // ── 3. Which ids a group may not have ────────────────────────────────────
  // An id in two groups, or in a group while also carrying a verdict of its
  // own, is ambiguous about what happens to it. It is downgraded EVERYWHERE and
  // the group loses it — which may then take the group under two.
  const seenIn = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const g of candidates) {
    for (const id of g.ids) {
      const prev = seenIn.get(id);
      if (prev && prev !== g.gid) { conflicted.add(id); continue; }
      seenIn.set(id, g.gid);
      const d = draft.get(id);
      if (!d || !d.stated) continue;
      // `merged` naming this very group is the consistent case, and the only one.
      if (d.verdict === "merged" && (!d.gid || d.gid === g.gid)) continue;
      conflicted.add(id);
    }
  }
  for (const id of conflicted) {
    note(`“${id}” was claimed by more than one outcome, so it was left undecided and taken out of the merge.`);
  }

  const merges: AssessMerge[] = [];
  const memberOf = new Map<string, AssessMerge>();
  const orphaned = new Set<string>();
  for (const g of candidates) {
    const ids = g.ids.filter((id) => !conflicted.has(id));
    if (ids.length < MIN_MERGE_SIZE) {
      if (ids.length) note(`merge group “${g.gid}” was left with ${ids.length} item(s), which is not a merge, so it was dropped.`);
      else if (!g.ids.length) note(`merge group “${g.gid}” named no known items, so it was dropped.`);
      for (const id of ids) orphaned.add(id);
      continue;
    }
    const kept: AssessMerge = {
      gid: g.gid, ids, prompt: g.prompt, rank: g.rank, rationale: g.rationale,
      ...headlineNaming(g.headline, g.category),
    };
    merges.push(kept);
    for (const id of ids) memberOf.set(id, kept);
  }

  // ── 4. The supersede graph, flattened ────────────────────────────────────
  // Only rows that survive every earlier rule may be links: a `superseded` with
  // no citation is already on its way to `unclear`, and following it would let
  // an unusable verdict decide where a usable one points.
  const links = new Map<string, string>();
  for (const [id, d] of draft) {
    if (d.verdict !== "superseded" || conflicted.has(id) || memberOf.has(id)) continue;
    if (!d.evidence) continue;
    const to = d.by;
    if (!to || to === id || !canDecide.has(to)) continue;
    links.set(id, to);
  }

  // ── 5. One row per assessable item, in the order they were given ─────────
  const rows: AssessRow[] = [];
  for (const id of assessable) {
    const d = draft.get(id);
    const group = memberOf.get(id);

    if (group) {
      rows.push({ id, verdict: "merged", evidence: group.rationale, gid: group.gid, rank: group.rank, ...naming(d) });
      continue;
    }
    // The merge rules are asked FIRST, and about ids that never carried a
    // verdict of their own as well: a group's member is claimed by that group
    // whether or not the items array also mentioned it, so "the group lost you"
    // is the true sentence for it and "nobody mentioned you" is not.
    if (conflicted.has(id)) { rows.push(unclear(id, d, "merge-conflict")); continue; }
    if (orphaned.has(id)) { rows.push(unclear(id, d, "merge-dropped")); continue; }
    if (!d) {
      // Silence about a row is not a decision about it.
      // Nothing to name it with either: the run did not write about this row at
      // all, and a title invented for a row nobody judged would be the one thing
      // this module never does.
      rows.push({ id, verdict: "unclear", evidence: "", downgraded: "unmentioned" });
      continue;
    }
    if (d.down) { rows.push(unclear(id, d, d.down)); continue; }

    switch (d.verdict) {
      case "merged":
        // The groups are the authority on membership; a `merged` row with no
        // surviving group behind it is a retirement into nothing.
        rows.push(unclear(id, d, "merge-unknown"));
        break;

      case "done":
      case "obsolete":
      case "superseded": {
        // THE rule: a claim without a citation is not a verdict.
        if (!d.evidence) { rows.push(unclear(id, d, "no-evidence")); break; }
        if (d.verdict !== "superseded") {
          rows.push({ id, verdict: d.verdict, evidence: d.evidence, ...naming(d) });
          break;
        }
        const to = d.by;
        if (!to || !canDecide.has(to)) { rows.push(unclear(id, d, "supersede-unknown")); break; }
        if (to === id) { rows.push(unclear(id, d, "supersede-self")); break; }
        const end = terminalOf(id, links);
        if (!end) { rows.push(unclear(id, d, "supersede-cycle")); break; }
        rows.push({ id, verdict: "superseded", evidence: d.evidence, supersededBy: end, ...naming(d) });
        break;
      }

      case "wanted":
        rows.push({ id, verdict: "wanted", evidence: d.evidence, rank: d.rank, ...naming(d) });
        break;

      case "unclear":
        rows.push({ id, verdict: "unclear", evidence: d.evidence, ...naming(d) });
        break;
    }
  }

  // A `wanted` row with no rank still has to sit somewhere, so it takes the
  // next position after the ones that named theirs. Missing a rank is not a
  // reason to downgrade: `wanted` retires nothing, and the safe direction here
  // is to keep the row exactly as it is.
  let next = 0;
  for (const r of rows) if (r.verdict === "wanted" && r.rank != null) next = Math.max(next, r.rank);
  for (const r of rows) if (r.verdict === "wanted" && r.rank == null) r.rank = Math.min(MAX_RANK, ++next);

  // ── 6. The pad notes this run says are still worth doing ─────────────────
  //
  // `wanted` on an intent row is a rank. On a pad note it was NOTHING: the note
  // was read, judged and left where it was, because the pad is a synced
  // document the host does not own — so the one verdict that says "this is
  // still worth doing" had no route into the backlog at all.
  //
  // The offer is synthesised HERE, from the note's OWN text, and that is the
  // whole design: "it carries the note's words" is true by construction rather
  // than because the CLI was asked to copy them and did. It is an OFFER — a row
  // in `news` somebody has to tick — so nothing applies itself, and the note
  // itself is still never touched by anything on this side.
  const offers: AssessNew[] = [];
  /** trimmed note text → the note's id, for the duplicate rule below. */
  const offeredText = new Map<string, string>();
  for (const r of rows) {
    if (r.verdict !== "wanted") continue;
    const it = items.get(r.id);
    // A context row was given to be read, and an intent row that is still
    // wanted already has a row of its own — posting a second one carrying the
    // same words is how a prompt runs twice.
    if (!it || it.context || it.source !== "note") continue;
    const text = typeof it.text === "string" ? it.text : "";
    if (!text.trim()) continue;
    offers.push({
      prompt: text,
      ...(r.rank != null ? { rank: r.rank } : {}),
      // Whatever the run called the row it judged. A naming is a reading of the
      // words, and these are the same words.
      ...headlineNaming(r.headline, r.category),
      fromNote: r.id,
    });
    offeredText.set(text.trim(), r.id);
  }

  // ── 7. New items ─────────────────────────────────────────────────────────
  const news: AssessNew[] = [];
  for (const n of rawNew) {
    const prompt = promptOf(n);
    if (!prompt) { note("a proposed new item had no prompt, so it was dropped."); continue; }
    // The CLI was told not to restate a note under `new`, and a run that does it
    // anyway would put the same sentence on the sheet twice — once as the
    // person's words and once as the machine's, ticked separately, posting two
    // rows. The note's own copy is the one that is kept, because it is the one
    // that can clear the note it came from.
    const repeated = offeredText.get(prompt);
    if (repeated) {
      note(`a proposed new item repeated pad note “${repeated}” word for word; the note itself is offered instead.`);
      continue;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      note(`a proposed new item was over ${MAX_PROMPT_CHARS} characters; it was dropped rather than cut short.`);
      continue;
    }
    if (news.length >= MAX_NEW) {
      note(`only the first ${MAX_NEW} new items were kept — the rest were dropped, not shortened.`);
      break;
    }
    news.push({
      prompt,
      rank: rankOf(n.rank),
      ...headlineNaming(headlineOf(n.headline ?? n.title, prompt), categoryOf(n.category ?? n.kind)),
    });
  }

  // AFTER the loop, and deliberately not counted against `MAX_NEW`: that cap is
  // there to stop a run that INVENTS thirty things, and these are sentences the
  // person already wrote and can already see. Appended rather than prepended so
  // the indices `AssessChoices.news` names stay the ones a client built from
  // the CLI's own list.
  news.push(...offers);

  // One sentence per kind of drop, carrying the count — see the counters above.
  if (headlineDrops) note(headlineDropNote(headlineDrops));
  if (categoryDrops) note(categoryDropNote(categoryDrops));

  return { rows, merges, news, notes };
}

/** The same "only when there is one" spread as `naming`, for the two places
 *  that hold the pair as loose values rather than on a draft. */
export function headlineNaming(headline?: string, category?: ItemCategory): { headline?: string; category?: ItemCategory } {
  return {
    ...(headline ? { headline } : {}),
    ...(category ? { category } : {}),
  };
}

/** A downgrade keeps whatever the CLI managed to say — the sentence is built
 *  from both halves, so "why is this unclear" never loses the model's own
 *  wording. */
function unclear(id: string, d: Draft | undefined, down: AssessDowngrade): AssessRow {
  // The naming survives the downgrade. Every downgrade here is about a CLAIM —
  // no citation, an unknown verdict, a merge that did not stand — and none of
  // them is a reason to disbelieve the run about what the row is called, which
  // it read off the words rather than off the repo.
  return {
    id, verdict: "unclear", evidence: d?.evidence ?? "", downgraded: down,
    ...headlineNaming(d?.headline, d?.category),
  };
}

/**
 * Walk a supersede chain to the row nothing supersedes.
 *
 * `null` means the walk came back round. A chain a→b→c is legitimate — c is
 * where the work actually is — so it is FLATTENED rather than refused: both a
 * and b end up pointing at c, and the phone renders one hop it can check
 * instead of a graph it cannot.
 */
function terminalOf(id: string, links: ReadonlyMap<string, string>): string | null {
  const seen = new Set<string>([id]);
  let cur = links.get(id);
  while (cur != null) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const nxt = links.get(cur);
    if (nxt == null) return cur;
    cur = nxt;
  }
  return null;
}