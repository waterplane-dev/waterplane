/**
 * A slice of assess.ts: the slot check's two proposal kinds (2026-10-16),
 * cleaned. `cleanAssessment` (sassclean.ts) calls both once the rows and the
 * merges are settled. Layout: docs/notes/shared-architecture.md.
 */
import { transportPaths } from "../itempaths.js";
import { type AssessVerdict, MAX_CONFLICT_IDS, MAX_CONFLICTS, MAX_EVIDENCE_CHARS, MAX_PROMPT_CHARS, MAX_RATIONALE_CHARS, MAX_SPLITS, SPLIT_PARTS, clip, str } from "./sassvocab.js";
import { type AssessConflict, type AssessItem, type AssessMerge, type AssessRow, type AssessSplit } from "./sassio.js";


// ── 8. Conflicts — words, never a mutation ───────────────────────────────────

/**
 * A contradiction has to name at least two rows this run could decide about
 * and say why. Unknown ids are dropped (and said); one left is not a conflict.
 * Nothing here can change a row, so the rules are only about the card being
 * something a person can act on.
 */
export function cleanConflicts(raw: Record<string, unknown>[], canDecide: ReadonlySet<string>, note: (s: string) => void): AssessConflict[] {
  const out: AssessConflict[] = [];
  const cids = new Set<string>();
  const sets = new Set<string>();
  for (const c of raw) {
    if (out.length >= MAX_CONFLICTS) { note(`only the first ${MAX_CONFLICTS} conflicts were kept.`); break; }
    const cid = clip(str(c.cid) || str(c.id) || `c${out.length + 1}`, 40);
    if (cids.has(cid)) { note(`a second conflict called “${cid}” was dropped.`); continue; }
    const cited = (Array.isArray(c.ids) ? c.ids : []).filter((x: unknown): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
    const uniq = [...new Set(cited)];
    const ids = uniq.filter((id) => canDecide.has(id));
    if (ids.length < uniq.length) note(`conflict “${cid}” named ${uniq.length - ids.length} item(s) that were not in the list; they were dropped from it.`);
    if (ids.length < 2) { note(`conflict “${cid}” was left naming fewer than two items, so it was dropped.`); continue; }
    if (ids.length > MAX_CONFLICT_IDS) { note(`conflict “${cid}” named ${ids.length} items — over the limit of ${MAX_CONFLICT_IDS} — so it was dropped.`); continue; }
    const why = clip(str(c.why) || str(c.reason) || str(c.rationale) || str(c.evidence), MAX_EVIDENCE_CHARS);
    if (!why) { note(`conflict “${cid}” did not say what contradicts what, so it was dropped.`); continue; }
    const setKey = [...ids].sort().join("\n");
    if (sets.has(setKey)) { note(`conflict “${cid}” repeated another conflict's items, so it was dropped.`); continue; }
    sets.add(setKey);
    cids.add(cid);
    out.push({ cid, ids, why });
  }
  return out;
}

// ── 9. Splits — one row, two texts, no file lost ─────────────────────────────

/** The verdicts a split cannot stand beside: each already retires the row. */
const RETIRING: ReadonlySet<AssessVerdict> = new Set<AssessVerdict>(["done", "obsolete", "superseded", "merged"]);

/**
 * A split replaces somebody's words with two texts the run wrote, so it is
 * held to the merge's standard plus one: exactly two non-empty texts, neither
 * the original verbatim nor each other, none over `MAX_PROMPT_CHARS` (dropped,
 * never cut), on an INTENT row (a pad note is not the host's to archive), on a
 * row no other outcome retires, once per row — and every file path the
 * original named (`transportPaths`) still named by one of the two. A split
 * that loses a path is REFUSED, never repaired: appending the path to a text
 * would be this module writing the instruction.
 */
export function cleanSplits(
  raw: Record<string, unknown>[],
  items: ReadonlyMap<string, AssessItem>,
  canDecide: ReadonlySet<string>,
  rows: readonly AssessRow[],
  memberOf: ReadonlyMap<string, AssessMerge>,
  note: (s: string) => void,
): AssessSplit[] {
  const out: AssessSplit[] = [];
  const sids = new Set<string>();
  const seen = new Set<string>();
  const twice = new Set<string>();
  const verdict = new Map(rows.map((r) => [r.id, r.verdict] as const));
  for (const s of raw) {
    if (out.length >= MAX_SPLITS) { note(`only the first ${MAX_SPLITS} splits were considered.`); break; }
    const sid = clip(str(s.sid) || `s${out.length + 1}`, 40);
    if (sids.has(sid)) { note(`a second split called “${sid}” was dropped.`); continue; }
    const id = str(s.id) || str(s.source);
    const it = items.get(id);
    if (!id || !it || !canDecide.has(id)) { note(`split “${sid}” named an item that was not in the list, so it was dropped.`); continue; }
    if (it.source !== "intent") { note(`split “${sid}” was about a pad note, which is not split here — it was dropped.`); continue; }
    if (seen.has(id)) { twice.add(id); continue; }
    seen.add(id);
    const v = verdict.get(id);
    if (memberOf.has(id) || (v && RETIRING.has(v))) {
      note(`split “${sid}” was about “${id}”, which another outcome already retires, so it was dropped.`);
      continue;
    }
    const rawTexts = Array.isArray(s.texts) ? s.texts : Array.isArray(s.parts) ? s.parts : [];
    const texts = rawTexts.map((t: unknown) => (typeof t === "string" ? t.trim() : ""));
    if (texts.length !== SPLIT_PARTS || texts.some((t) => !t)) {
      note(`split “${sid}” did not give exactly ${SPLIT_PARTS} texts, so it was dropped.`);
      continue;
    }
    if (texts.some((t) => t.length > MAX_PROMPT_CHARS)) {
      note(`split “${sid}” proposed a text over ${MAX_PROMPT_CHARS} characters; it was dropped rather than cut short.`);
      continue;
    }
    const orig = (it.text ?? "").trim();
    if (texts[0] === texts[1] || texts.includes(orig)) {
      note(`split “${sid}” did not actually divide “${id}” into two different jobs, so it was dropped.`);
      continue;
    }
    const kept = new Set(texts.flatMap((t) => transportPaths(t)));
    const lost = transportPaths(orig).filter((p) => !kept.has(p));
    if (lost.length) {
      note(`split “${sid}” would lose ${lost.join(", ")} from “${id}”, so it was refused.`);
      continue;
    }
    sids.add(sid);
    out.push({ sid, id, texts, rationale: clip(str(s.rationale) || str(s.reason) || str(s.why), MAX_RATIONALE_CHARS) });
  }
  // Two splits of one row are two different answers to how it divides.
  for (const id of twice) note(`“${id}” was split more than one way, so none of the splits was used.`);
  return twice.size ? out.filter((s) => !twice.has(s.id)) : out;
}
