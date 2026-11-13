/**
 * Every writer of the skills store, the doors into the sheet, and the one save path. Nothing here
 * applies itself: `saveChanges` runs on a tap, writes the ONE file the screen named, and the host
 * refuses what it cannot write safely.
 */
import type { SkillChange, SkillInventoryDoc, SkillRecommendResponse, SwitchLevel } from "@waterplane/shared";
import { api } from "../../api";
import { core } from "../../sdk";
import { initialSkills, skillsState } from "./store";
import { changeCount, globalDraftOf, levelFor, moveDraft, parkKeyOf, reconcileSuggestions, suggestionChanges, receiptWords, withChoice, withPin, withoutSent, type FilterKey, type Row, type SortKey, type Target, type Want } from "./logic";

/** Bumped whenever the sheet is aimed at another repo, so a Recommend still out cannot land in it. */
let askSeq = 0;

/** The sheet's own mount: a different repo starts with an empty draft, the same one keeps its unsaved draft. */
export function aimSkills(repoId: string, backend?: string): void {
  const cur = skillsState.get();
  if (cur.repoId === repoId) { if (cur.backend !== backend) skillsState.set({ ...cur, backend }); return; }
  // The old repo's unsaved draft is set aside under it, never dropped; its suggestions and any call still out are not carried.
  const moved = moveDraft(cur.parked, { repoId: cur.repoId, level: levelFor(cur.target, cur.shared), draft: cur.draft }, { repoId, level: levelFor("repo", false) });
  askSeq++;
  skillsState.set({ ...initialSkills(), repoId, backend, ...moved });
}

export function closeSkills(): void {
  core().nav.close("skills");
}

const patch = (p: Partial<ReturnType<typeof skillsState.get>>) => skillsState.set({ ...skillsState.get(), ...p });

// The level is a different file: a draft made against one file is not a draft for another, so each
// file keeps its own and is shown again when it comes back (nothing typed is dropped).
function moveLevel(target: Target, shared: boolean): void {
  const s = skillsState.get();
  const moved = moveDraft(s.parked, { repoId: s.repoId, level: levelFor(s.target, s.shared), draft: s.draft }, { repoId: s.repoId, level: levelFor(target, shared) });
  skillsState.set({ ...s, target, shared, ...moved });
}
export const setTarget = (target: Target): void => moveLevel(target, skillsState.get().shared);
/**
 * Which repo file the save writes. The draft COMES ALONG (the choice sits on the save bar, beside the
 * draft it is about); a draft set aside for the other file is merged under it, never dropped.
 */
export function setShared(shared: boolean): void {
  const s = skillsState.get();
  if (s.shared === shared || s.target !== "repo") return;
  const there = levelFor("repo", shared);
  const parked = { ...s.parked };
  const waiting = parked[parkKeyOf(s.repoId, there)] ?? {};
  delete parked[parkKeyOf(s.repoId, there)];
  skillsState.set({ ...s, shared, parked, draft: { ...waiting, ...s.draft } });
}
export const setFilter = (filter: FilterKey | null): void => patch({ filter });
export const setSort = (sort: SortKey): void => patch({ sort });
export const setQuery = (query: string): void => patch({ query });
export const discardDraft = (): void => patch({ draft: {} });

export function choose(row: Row, to: Want): void {
  const s = skillsState.get();
  const level = levelFor(s.target, s.shared);
  patch({ draft: withChoice(s.draft, row, level, to, globalDraftOf(s.parked, s.repoId, level, s.draft)) });
}

/** Keep what a repo row follows as its own value, so a later All-repos change leaves this repo alone. */
export function pin(row: Row): void {
  const s = skillsState.get();
  const level = levelFor(s.target, s.shared);
  patch({ draft: withPin(s.draft, row, level, globalDraftOf(s.parked, s.repoId, level, s.draft)) });
}

/** The door back to the readings: what every turn of this repo carries, skills included. */
export function openCarried(repoId: string): void {
  core().say.track("action:skills.carried");
  core().nav.openSetup(repoId, { region: "agents" });
}

export type SaveResult = { ok: true; doc: SkillInventoryDoc } | { ok: false; error: string; stale: boolean };

/** The one write. A refusal keeps the draft and says why; a stale rev (409) says to choose again. */
export async function saveChanges(repoId: string, doc: SkillInventoryDoc, level: SwitchLevel, changes: SkillChange[], clearDraft = true, toast = true): Promise<SaveResult & { receipt?: string }> {
  const layer = doc.layers.find((l) => l.level === level);
  if (!layer) return { ok: false, error: "This desktop did not say which file that is.", stale: false };
  let r;
  try {
    r = await api.skillsWrite(repoId, { level, revs: { [level]: layer.rev }, changes });
  } catch {
    return { ok: false, error: "Nothing was written: the desktop did not answer.", stale: false };
  }
  if (!r.ok) return { ok: false, error: r.error, stale: r.status === 409 };
  // Clear only what was sent and is still what the person chose: taps made during the round trip stay.
  if (clearDraft) {
    patch({ draft: withoutSent(skillsState.get().draft, changes) });
  }
  const note = r.ignoredNote ? ` ${r.ignoredNote}` : "";
  const receipt = receiptWords(r.changed.length, r.file) + note;
  if (toast) core().say.toast(receipt);
  return { ok: true, doc: r.doc, receipt };
}

/** Ask the desktop for suggestions. One cheap call, on a tap; the answer is a list, never a change. */
export async function recommend(repoId: string): Promise<void> {
  if (skillsState.get().asking) return;
  const seq = ++askSeq;
  patch({ asking: true, suggest: null, unticked: [] });
  let r: SkillRecommendResponse;
  try {
    r = await api.skillsRecommend(repoId);
  } catch {
    r = { ok: false, suggestions: [], dropped: 0, error: "Nothing was suggested: the desktop did not answer." };
  }
  // The sheet was aimed at another repo while this was out: the answer is that repo's, not this one's.
  if (seq !== askSeq || skillsState.get().repoId !== repoId) return;
  patch({ asking: false, suggest: r });
}

export function dismissSuggest(): void { patch({ suggest: null, unticked: [] }); }

export function toggleSuggest(key: string): void {
  const u = skillsState.get().unticked;
  patch({ unticked: u.includes(key) ? u.filter((k) => k !== key) : [...u, key] });
}

/**
 * Apply = the same one write, once per file a ticked lever touches: All repos first, then this
 * repo's file (named by the save bar's choice), each with the rev the screen read. The typed draft
 * is left alone. A refusal of the second write says the first one landed.
 */
export async function applySuggestions(repoId: string, doc: SkillInventoryDoc, level: SwitchLevel): Promise<SaveResult | null> {
  const s = skillsState.get();
  if (!s.suggest) return null;
  // Only what is still true of the rows as they are now (a Save since the answer may have moved them).
  const c = suggestionChanges(reconcileSuggestions(s.suggest.suggestions, doc.rows), s.unticked);
  if (!changeCount(c)) return null;
  let cur = doc;
  const receipts: string[] = [];
  if (c.all.length) {
    const r = await saveChanges(repoId, cur, "global", c.all, false, false);
    if (!r.ok) return r;
    cur = r.doc;
    if (r.receipt) receipts.push(r.receipt);
  }
  if (c.here.length) {
    const r = await saveChanges(repoId, cur, level, c.here, false, false);
    if (!r.ok) return receipts.length ? { ...r, error: `All repos was saved; this repo's file was not. ${r.error}` } : r;
    cur = r.doc;
    if (r.receipt) receipts.push(r.receipt);
  }
  core().say.toast(receipts.join(" "));
  dismissSuggest();
  return { ok: true, doc: cur };
}
