/** A slice of smartpick.ts — moved whole from smartpick.ts, see docs/notes/shared-architecture.md. */
/**
 * A merge group's floor and ceiling, reused from `assess.ts` rather than
 * restated.
 *
 * They are the same decision with the same failure mode: one id is not a merge
 * (it is a rewrite of somebody's sentence, which this does not offer), and past
 * six a "merge" stops being "these are facets of one job" and becomes a list
 * flattened into a paragraph, which is how detail dies. Two copies of those
 * numbers is two answers to "how big may a merge be". Not re-exported from here
 * either — `index.ts` already exports them out of `assess.ts`, and a second
 * export of one binding is a second place for it to be changed.
 */
import { MIN_MERGE_SIZE, MAX_MERGE_SIZE } from "../assess.js";
import { type SmartPickCandidate, type SmartPickMerge, type SmartPickProposal } from "./ssptypes.js";
import { MAX_SMARTPICK_MERGES, SMARTPICK_MAX_NOTES, SMARTPICK_MAX_WHY_CHARS, transportPaths } from "./sspconst.js";

// ── Reading what the model wrote ─────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** The merge key a group occupies in `order` until the host mints its real id. */
export const mergeKey = (k: number): string => `merge:${k}`;

/** The short name a sentence calls an item by. `label` when a person typed one,
 *  otherwise the first words of the text — never the id, which means nothing to
 *  the person reading the strip. */
export function smartpickName(c: SmartPickCandidate): string {
  const label = (c.label ?? "").trim();
  if (label) return clip(label, 60);
  const first = c.text.trim().split("\n")[0] ?? "";
  return clip(first, 60) || c.id;
}

/**
 * The JSON inside whatever the model actually answered.
 *
 * Three shapes, in order of how often they turn up: the bare object; the object
 * inside a ```json fence; and the object with prose either side of it ("Here is
 * the grooming plan: {…}. Let me know…"). The last one is a SLICE from the first
 * `{` to the last `}` — which is why a model that also writes a JSON example in
 * its prose gets one parse attempt and then `null`, rather than this file
 * guessing which object was meant.
 *
 * A bare ARRAY is not one of them. It parses, so the tolerant reading would be
 * "an order, with no merges and no pick" — and that reading turns an answer
 * nobody can interpret into a confident "change nothing", which is exactly the
 * shape of a wrong number. An object or `null`.
 */
function parseLoose(raw: string): unknown {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  const tries: string[] = [text];
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fence) tries.push(fence[1].trim());
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) tries.push(text.slice(open, close + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* next shape */ }
  }
  return null;
}

/** Ids out of whatever array-ish thing the model put them in. */
const idList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);

/**
 * Whatever the model wrote, plus the candidates it was asked about, in — a
 * proposal that cannot reorder, merge or pick anything that does not exist, out.
 *
 * Tolerant about SHAPE and strict about CLAIMS, which is `cleanAssessment`'s
 * asymmetry and it is the point. A fenced answer, `sorted` instead of `order`,
 * `prompt` instead of `text`, an id repeated twice, a rationale under `reason` —
 * all cosmetics, and refusing the pass over any of them just means the repo pays
 * for another one. What is never tolerated is a claim about an item that is not
 * there, or a merge that would lose something.
 *
 * `refused` is the id-sets a person has already UNDONE (sorted, one array per
 * undone merge). Without it the user and the machine take turns for ever: undo
 * the merge, the next pass proposes it again, undo it again. The host matches
 * the stored text hash before passing a set in, so editing one of the items
 * makes it a genuinely new proposal and it is offered again.
 *
 * Returns `null` — and only `null` — when there was no readable object at all.
 * The caller records `failed` with `SMARTPICK_UNREADABLE` and the backlog fires
 * in the order it already had.
 */
export function cleanSmartPick(
  raw: string,
  cands: readonly SmartPickCandidate[],
  refused: readonly string[][] = [],
): SmartPickProposal | null {
  const doc = parseLoose(raw) as Record<string, unknown> | null;
  if (!doc) return null;

  const notes: string[] = [];
  const note = (s: string): void => { if (notes.length < SMARTPICK_MAX_NOTES) notes.push(s); };

  // The input index. Duplicate candidate ids are the CALLER's bug, not the
  // model's; the first one wins so the proposal is still decidable.
  const byId = new Map<string, SmartPickCandidate>();
  const given: string[] = [];
  for (const c of cands) {
    if (!c || typeof c.id !== "string" || !c.id || byId.has(c.id)) continue;
    byId.set(c.id, c);
    given.push(c.id);
  }
  const slotOf = new Map(given.map((id, i) => [id, i]));

  // Refused merges, as a set of canonical keys.
  const refusedKeys = new Set(
    refused.map((ids) => [...new Set(idList(ids))].sort().join(",")).filter(Boolean),
  );

  // ── 1. The order the model asked for ─────────────────────────────────────
  // Unknown ids are dropped (never spawned as rows); duplicates collapse to
  // their first appearance; and anything the model left out is APPENDED in the
  // order it already had, because silence about a row is not a decision to move
  // it to the end.
  const wanted = idList(doc.order ?? doc.sorted ?? doc.sort);
  const seen = new Set<string>();
  const order: string[] = [];
  let unknown = 0;
  let dupes = 0;
  for (const id of wanted) {
    if (!byId.has(id)) { unknown++; continue; }
    if (seen.has(id)) { dupes++; continue; }
    seen.add(id);
    order.push(id);
  }
  if (unknown) note(`the order named ${unknown} item${unknown === 1 ? "" : "s"} that ${unknown === 1 ? "is" : "are"} not in this backlog; ${unknown === 1 ? "it was" : "they were"} dropped.`);
  if (dupes) note(`${dupes} item${dupes === 1 ? " was" : "s were"} listed twice in the order; the first place was kept.`);
  const missing = given.filter((id) => !seen.has(id));
  if (missing.length) {
    note(`${missing.length} task${missing.length === 1 ? " was" : "s were"} left out of the order — kept where they were.`);
    for (const id of missing) order.push(id);
    order.sort((a, b) => (slotOf.get(a) ?? 0) - (slotOf.get(b) ?? 0));
  }

  // ── 2. The merge groups ──────────────────────────────────────────────────
  // A group survives only under EVERY condition below. Each refusal is a note:
  // a merge dropped silently is indistinguishable from one never proposed.
  const rawMerges = (Array.isArray(doc.merges) ? doc.merges : Array.isArray(doc.merge) ? doc.merge : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const merges: SmartPickMerge[] = [];
  const claimed = new Set<string>();
  for (const m of rawMerges) {
    if (merges.length >= MAX_SMARTPICK_MERGES) {
      note(`only the first ${MAX_SMARTPICK_MERGES} merge groups were considered.`);
      break;
    }
    const cited = idList(m.ids);
    // Two different drops, counted separately. A repeated id is one item named
    // twice and nothing is lost by collapsing it; an id this backlog does not
    // hold is a claim about work that is not here, and THAT is what the note
    // reports. Counting them together made `["a","a","b"]` say the group
    // "named 1 item(s) that are not in this backlog" about a backlog holding
    // both — a sentence that sends somebody looking for a third item.
    const uniq = [...new Set(cited)];
    const ids = uniq.filter((id) => byId.has(id));
    const name = ids.length ? `“${smartpickName(byId.get(ids[0])!)}”` : "a merge group";

    if (ids.length < uniq.length) {
      note(`${name} named ${uniq.length - ids.length} item(s) that are not in this backlog; they were dropped from it.`);
    }
    if (ids.length < MIN_MERGE_SIZE) {
      note(`a merge group with fewer than ${MIN_MERGE_SIZE} known items was dropped — one item is not a merge, it is a rewrite of your sentence.`);
      continue;
    }
    if (ids.length > MAX_MERGE_SIZE) {
      note(`${name} had ${ids.length} items — over the limit of ${MAX_MERGE_SIZE} — so it was dropped and its items kept their own words.`);
      continue;
    }
    const overlap = ids.filter((id) => claimed.has(id));
    if (overlap.length) {
      note(`${name} claims ${overlap.length} item(s) another merge already took, so it was dropped.`);
      continue;
    }
    const members = ids.map((id) => byId.get(id)!);

    const clipped = members.filter((c) => c.clipped);
    if (clipped.length) {
      note(`${name} included ${clipped.length} item(s) the pass only saw the first few lines of, so it was dropped — a merge folds words, and those words were not read.`);
      continue;
    }
    const chains = members.filter((c) => (c.steps ?? 1) > 1);
    if (chains.length) {
      note(`${name} included a ${chains[0].steps}-step item; a chain's turn structure cannot survive being folded into one prompt, so the group was dropped.`);
      continue;
    }
    const resumes = new Set(members.map((c) => (c.resume ? 1 : 0)));
    if (resumes.size > 1) {
      note(`${name} mixes items that continue the repo's last conversation with items that start clean, so it was dropped — the merged row can only do one.`);
      continue;
    }
    // ── One clock, or none at all ────────────────────────────────────────
    //
    // A merged row can only wait on ONE instant, and there is no honest way to
    // choose between two: "the earliest wins" would fold *tonight 21:00* into
    // *tonight 23:00* and move somebody's work two hours, and folding a timed
    // row into an untimed one either loses the clock or puts one on words that
    // never had it. Both are the pass deciding a clock, which is the one thing
    // a person's own `at` says it may not do. Twins on the IDENTICAL clock are
    // the case that survives, and the merged row carries it.
    const clocks = new Set(members.map((c) => c.atKey ?? ""));
    if (clocks.size > 1) {
      const timed = members.find((c) => !!c.atKey)!;
      const other = members.find((c) => (c.atKey ?? "") !== timed.atKey)!;
      const when = (c: SmartPickCandidate): string =>
        (c.atKey ? `runs ${c.at || "on its own clock"}` : "does not run on a clock");
      note(`a merge was dropped: “${smartpickName(timed)}” ${when(timed)} and “${smartpickName(other)}” ${when(other)} — the pass never decides a clock.`);
      continue;
    }
    // ── One hold, or none at all ─────────────────────────────────────────
    //
    // `holdForHost` is inside `atKey` — but only for a row that HAS a clock,
    // so the check above covers exactly the members this one does not. Both
    // halves of *drop the clock* land here: the rows keep the hold and lose
    // the clock, so two of them have identical (absent) keys, and a merge of
    // them used to come out with no hold at all and fire while another repo's
    // item was mid-turn. Folding an unheld row into a held one is the same
    // guess in the other direction. Refused rather than repaired, for the
    // clock's reason: which of two answers about when work may run is the
    // person's is not something a pass can work out.
    const holds = new Set(members.map((c) => (c.holdForHost ? 1 : 0)));
    if (holds.size > 1) {
      const held = members.find((c) => c.holdForHost)!;
      const free = members.find((c) => !c.holdForHost)!;
      note(`a merge was dropped: “${smartpickName(held)}” waits until nothing else on the desktop is running and “${smartpickName(free)}” does not — the pass never drops a hold.`);
      continue;
    }
    // ── One budget answer, or none at all ────────────────────────────────
    //
    // A person's waiver is the same kind of statement about when work may run.
    // Merged anyway, the row either spent past the budget on words nobody let
    // past it or quietly waited on a budget somebody had already answered.
    const waivers = new Set(members.map((c) => (c.pastBudget ? 1 : 0)));
    if (waivers.size > 1) {
      const let_ = members.find((c) => c.pastBudget)!;
      const held = members.find((c) => !c.pastBudget)!;
      note(`a merge was dropped: “${smartpickName(let_)}” was let past the budget and “${smartpickName(held)}” was not — the pass never decides a budget.`);
      continue;
    }
    const text = str(m.text) || str(m.prompt);
    if (!text) {
      note(`${name} came with no text, so it was dropped.`);
      continue;
    }
    // The file rule (CLAUDE.md's full-path transport convention): a merged
    // prompt that loses `.claude/inbox/foo.png` will name a file that is not
    // there. Dropped, never repaired — appending the path would make this file
    // an author of somebody's prompt.
    // The host's own listing FIRST, then the regex's reading of the same words:
    // a spaced filename is invisible to the regex and an image outside the
    // transport is invisible to the listing, so the union is the only set that
    // covers both. A supplied path that the member's own text does not contain
    // is dropped rather than demanded — this field may tighten the check, never
    // invent a requirement the person never wrote.
    const need = [...new Set(members.flatMap((c) => [
      ...(Array.isArray(c.paths) ? c.paths.filter((p) => typeof p === "string" && !!p && c.text.includes(p)) : []),
      ...transportPaths(c.text),
    ]))];
    const lost = need.filter((p) => !text.includes(p));
    if (lost.length) {
      note(`${name} was dropped: the merged text no longer names ${lost.slice(0, 3).map((p) => `“${p}”`).join(", ")}${lost.length > 3 ? ` and ${lost.length - 3} more` : ""}, which one of the items it folds points at.`);
      continue;
    }
    if (refusedKeys.has([...ids].sort().join(","))) {
      note(`${name} is a merge you already undid, so it was not proposed again.`);
      continue;
    }

    for (const id of ids) claimed.add(id);
    merges.push({ ids, text, why: clip(str(m.why) || str(m.rationale) || str(m.reason), SMARTPICK_MAX_WHY_CHARS) });
  }

  // ── 3. Merged members leave the order; the group takes the earliest slot ──
  const keyFor = new Map<string, string>();
  merges.forEach((g, k) => { for (const id of g.ids) keyFor.set(id, mergeKey(k)); });
  const placed: string[] = [];
  const done = new Set<string>();
  for (const id of order) {
    const key = keyFor.get(id);
    if (!key) { placed.push(id); continue; }
    if (done.has(key)) continue;   // a later member of a group already placed
    done.add(key);
    placed.push(key);
  }

  // ── 4. The pick ──────────────────────────────────────────────────────────
  // It has to be something that still exists after the merges. A pick naming a
  // merged-away member is read as the group it went into — the model picked
  // that work, and the group IS that work.
  const asked = str(doc.pick) || str(doc.next) || str(doc.first);
  let pick: string | null = null;
  if (asked) {
    if (placed.includes(asked)) pick = asked;
    else if (keyFor.has(asked)) pick = keyFor.get(asked)!;
  }
  if (!pick && placed.length) {
    if (asked) note(`the pick named “${asked}”, which is not one of this repo's waiting items; the first of the order was used instead.`);
    pick = placed[0];
  }

  // ── …and never a row with a clock ────────────────────────────────────────
  //
  // "Next" is the one word a clock already owns: a timed row runs at the
  // instant a PERSON named, and a pass that made it the pick would be claiming
  // it should run now — either overruling that instant or, worse, saying
  // nothing while the row sits there wearing the wrong reason. So the pick is
  // moved to the first entity without a clock, and the note says so rather
  // than the correction being silent. Every item having one is a real answer:
  // there is nothing here for a pick to name, and `null` is what says that.
  const groupAt = (key: string): SmartPickMerge | undefined => {
    const k = /^merge:(\d+)$/.exec(key);
    return k ? merges[Number(k[1])] : undefined;
  };
  const entityName = (key: string): string => {
    const grp = groupAt(key);
    const c = grp ? byId.get(grp.ids[0]) : byId.get(key);
    return c ? smartpickName(c) : key;
  };
  const timedEntity = (key: string): boolean => {
    const grp = groupAt(key);
    if (grp) return grp.ids.some((id) => !!byId.get(id)?.atKey);
    return !!byId.get(key)?.atKey;
  };
  if (pick && timedEntity(pick)) {
    const next = placed.find((k) => !timedEntity(k)) ?? null;
    note(`the model picked “${entityName(pick)}”, which runs on its own clock — the clock stands, and the pick is ${next ? `“${entityName(next)}”, the first item without one` : "nothing: every item waiting here has a clock of its own"}.`);
    pick = next;
  }

  return {
    pick,
    order: placed,
    merges,
    why: clip(str(doc.why) || str(doc.rationale) || str(doc.reason), SMARTPICK_MAX_WHY_CHARS),
    notes,
  };
}