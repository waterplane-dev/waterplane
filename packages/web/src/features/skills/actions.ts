/**
 * Every writer of the skills store, the doors into the sheet, and the one save path. Nothing here
 * applies itself: `saveChanges` runs on a tap, writes one named file (Save: one per scope the cards chose), and the host
 * refuses what it cannot write safely.
 */
import type { SkillChange, SkillInventoryDoc, SkillRecommendResponse, SwitchLevel } from "@waterplane/shared";
import { api } from "../../api";
import { core } from "../../sdk";
import { initialSkills, skillsState } from "./store";
import { changeCount, levelFor, moveDraft, parkKeyOf, reconcileSuggestions, scopeOf, suggestionChanges, receiptWords, withPin, withScope, withScopedChoice, withoutSent, type FilterKey, type Row, type SortKey, type Target, type Want } from "./logic";

/** The sheet's own mount: a different repo starts with empty drafts, the same one keeps its unsaved ones. */
export function aimSkills(repoId: string, backend?: string, target?: Target): void {
  const cur = skillsState.get();
  if (cur.repoId === repoId) {
    // A door that names a scope sets where a card's first tap applies; cards already changed keep their own.
    if (cur.backend !== backend || (target && target !== cur.target)) skillsState.set({ ...cur, backend, ...(target ? { target } : {}) });
    return;
  }
  // The old repo's unsaved drafts are set aside under it, never dropped; its suggestions and any call still out are not carried.
  const repo = moveDraft(cur.parked, { repoId: cur.repoId, level: levelFor("repo", cur.shared), draft: cur.draft }, { repoId, level: levelFor("repo", false) });
  const all = moveDraft(repo.parked, { repoId: cur.repoId, level: "global", draft: cur.allDraft }, { repoId, level: "global" });
  skillsState.set({ ...initialSkills(), repoId, backend, target: target ?? "repo", parked: all.parked, draft: repo.draft, allDraft: all.draft });
}

export function closeSkills(): void {
  core().nav.close("skills");
}

const patch = (p: Partial<ReturnType<typeof skillsState.get>>) => skillsState.set({ ...skillsState.get(), ...p });

/**
 * Which repo file the save writes. The draft COMES ALONG (the choice sits on the save bar, beside the
 * draft it is about); a draft set aside for the other file is merged under it, never dropped.
 */
export function setShared(shared: boolean): void {
  const s = skillsState.get();
  if (s.shared === shared) return;
  const there = levelFor("repo", shared);
  const parked = { ...s.parked };
  const waiting = parked[parkKeyOf(s.repoId, there)] ?? {};
  delete parked[parkKeyOf(s.repoId, there)];
  skillsState.set({ ...s, shared, parked, draft: { ...waiting, ...s.draft } });
}
export const setFilter = (filter: FilterKey | null): void => patch({ filter });
export const setSort = (sort: SortKey): void => patch({ sort });
export const setQuery = (query: string): void => patch({ query });
export const discardDraft = (): void => patch({ draft: {}, allDraft: {} });

/** A selector tap, written where the card's own scope says (its first tap: the screen's default). */
export function choose(row: Row, to: Want): void {
  const s = skillsState.get();
  patch(withScopedChoice(s, row, levelFor("repo", s.shared), to, scopeOf(row, s, s.target)));
}

/** The card's This repo / All repos pair: its chosen value moves to the other file. */
export function scopeCard(row: Row, scope: Target): void {
  const s = skillsState.get();
  if (scopeOf(row, s, s.target) === scope) return;
  patch(withScope(s, row, levelFor("repo", s.shared), scope));
}

/** Keep what a repo row follows as its own value, so a later All-repos change leaves this repo alone. */
export function pin(row: Row): void {
  const s = skillsState.get();
  patch({ draft: withPin(s.draft, row, levelFor("repo", s.shared), s.allDraft) });
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
    const now = skillsState.get();
    patch(level === "global" ? { allDraft: withoutSent(now.allDraft, changes) } : { draft: withoutSent(now.draft, changes) });
  }
  const note = r.ignoredNote ? ` ${r.ignoredNote}` : "";
  const receipt = receiptWords(r.changed.length, r.file) + note;
  if (toast) core().say.toast(receipt);
  return { ok: true, doc: r.doc, receipt };
}

/**
 * Save = the one write, once per file the cards' scopes name: All repos first, then this repo's
 * file, each with the rev the screen read. A refusal of the second write says the first one landed.
 */
export async function saveDrafts(repoId: string, doc: SkillInventoryDoc, repoLevel: SwitchLevel, all: SkillChange[], here: SkillChange[]): Promise<SaveResult> {
  let cur = doc;
  const receipts: string[] = [];
  if (all.length) {
    const r = await saveChanges(repoId, cur, "global", all, true, false);
    if (!r.ok) return r;
    cur = r.doc;
    if (r.receipt) receipts.push(r.receipt);
  }
  if (here.length) {
    const r = await saveChanges(repoId, cur, repoLevel, here, true, false);
    if (!r.ok) return receipts.length ? { ...r, error: `All repos was saved; this repo's file was not. ${r.error}` } : r;
    cur = r.doc;
    if (r.receipt) receipts.push(r.receipt);
  }
  if (receipts.length) core().say.toast(receipts.join(" "));
  return { ok: true, doc: cur };
}

/**
 * A finished suggestion run (`skills.recommend`, a slow job the sheet starts on a tap) put on
 * screen — once per run: a list the person closed stays closed, a new run replaces it. Never applied.
 */
export function showSuggest(runId: string, r: SkillRecommendResponse): void {
  if (skillsState.get().suggestRun === runId) return;
  patch({ suggest: r, suggestRun: runId, unticked: [] });
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
