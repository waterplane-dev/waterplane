/**
 * The pure half of the skills & plugins screen: what a draft is, which rows a filter opens, the
 * weight sentences. No React, no host. Every figure is a host fact or `~chars/4`; an unmeasured row
 * is a sentence, never a 0.
 */
import { CHARS_PER_TOKEN, wordOf, SKILL_STATES, savingsOf, skillSavingsLine } from "@waterplane/shared";
import type { PluginRow, SkillChange, SkillInventoryDoc, SkillLayer, SkillRecommendResponse, SkillSuggestion, SkillRow, SkillState, SwitchLevel } from "@waterplane/shared";

export type Row = SkillRow | PluginRow;
/** What a tap on a selector wants at the level being edited. `inherit` removes the key. */
export type Want = SkillState | boolean | "inherit";
/** `kind:id` -> what the person has chosen but not saved. */
export type Draft = Readonly<Record<string, Want>>;
export type Target = "repo" | "all";
export type FilterKey = "plugins" | "skills" | "changed" | "unused30";
export type SortKey = "heaviest" | "used" | "name";

export const FILTER_KEYS: readonly FilterKey[] = ["plugins", "skills", "changed", "unused30"];
export const SORT_KEYS: readonly SortKey[] = ["heaviest", "used", "name"];
export const SORT_WORDS: Record<SortKey, string> = { heaviest: "heaviest", used: "most used", name: "name" };

/** The words on the four-way selector; the CLI's own names are in the title. */
export const STATE_WORDS: Record<SkillState, string> = { on: "on", "name-only": "names only", "user-invocable-only": "slash only", off: "off" };
export const STATE_TITLES: Record<SkillState, string> = {
  on: "listed with its description, the model can use it",
  "name-only": "listed by name only, without its description",
  "user-invocable-only": "hidden from the model; /name still works",
  off: "hidden entirely",
};
/** How a non-default state reads in a tag. */
const STATE_TAG: Record<SkillState, string> = { on: "on", "name-only": "names only", "user-invocable-only": "slash only", off: "off" };

export const keyOf = (r: { kind: string; id: string }): string => `${r.kind}:${r.id}`;

export function levelFor(target: Target, shared: boolean): SwitchLevel {
  return target === "all" ? "global" : shared ? "repo-shared" : "repo-local";
}

export const layerOf = (doc: SkillInventoryDoc | null, level: SwitchLevel): SkillLayer | undefined =>
  doc?.layers.find((l) => l.level === level);

const setAt = (r: Row, level: SwitchLevel): Want | undefined => (r.set as Partial<Record<SwitchLevel, Want>>)[level];

/** What the row reads now: the draft when there is one, else what the CLI resolves. `inherit` has no value of its own. */
export function shownState(r: SkillRow, draft: Draft): SkillState | "inherit" {
  const d = draft[keyOf(r)];
  return typeof d === "string" ? d : r.effective;
}
export function shownEnabled(r: PluginRow, draft: Draft): boolean | "inherit" {
  const d = draft[keyOf(r)];
  return typeof d === "boolean" || d === "inherit" ? d : r.enabled;
}

/**
 * A tap on a selector. A choice that changes nothing (the value the level already holds, or, with
 * no key at this level, what the row already resolves to) drops the draft entry instead of
 * writing a redundant key.
 */
export function withChoice(draft: Draft, r: Row, level: SwitchLevel, to: Want): Draft {
  const k = keyOf(r);
  const next = { ...draft };
  const held = setAt(r, level);
  const resolved: Want = r.kind === "skill" ? r.effective : r.enabled;
  // No key at this level: the tap is redundant only when nothing resolves it from ANOTHER level. A value
  // shadowed from another file still needs its key here (the tap must write), so it is compared with
  // what this level holds, not with what the row resolves to.
  const shadowed = r.from !== "default" && r.from !== "locked";
  const same = to === "inherit" ? held === undefined : held !== undefined ? held === to : !shadowed && resolved === to;
  if (same) delete next[k]; else next[k] = to;
  return next;
}

/** What is left of the draft after a save landed: only the entries that were sent AND are still what was chosen; taps made during the round trip stay. */
export function withoutSent(draft: Draft, sent: readonly SkillChange[]): Draft {
  return Object.fromEntries(Object.entries(draft).filter(([k, v]) => !sent.some((c) => keyOf(c) === k && c.to === v)));
}

/** The draft as the write's changes, in a stable order. Entries for rows that are gone are dropped. */
export function draftChanges(draft: Draft, rows: readonly Row[]): SkillChange[] {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const out: SkillChange[] = [];
  for (const [k, to] of Object.entries(draft)) {
    const r = byKey.get(k);
    if (r) out.push({ kind: r.kind, id: r.id, to });
  }
  return out.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}

/** A re-read keeps what a person chose, minus rows that are not there any more. */
export function reconcileDraft(draft: Draft, rows: readonly Row[]): Draft {
  const keys = new Set(rows.map(keyOf));
  return Object.fromEntries(Object.entries(draft).filter(([k]) => keys.has(k)));
}

/** Drafts set aside while another level or repo is on screen: `repoId\nlevel` -> draft. */
export type Parked = Readonly<Record<string, Draft>>;
const parkKey = (repoId: string | null, level: SwitchLevel): string => `${repoId ?? ""}\n${level}`;

/**
 * Switching file (level) or repo must not delete typed choices: set the current draft aside under
 * its own repo+level, and bring back the one set aside for where the screen is going (if any).
 */
export function moveDraft(parked: Parked, from: { repoId: string | null; level: SwitchLevel; draft: Draft }, to: { repoId: string | null; level: SwitchLevel }): { parked: Parked; draft: Draft } {
  const next: Record<string, Draft> = { ...parked };
  if (Object.keys(from.draft).length) next[parkKey(from.repoId, from.level)] = from.draft; else delete next[parkKey(from.repoId, from.level)];
  const k = parkKey(to.repoId, to.level);
  const draft = next[k] ?? {};
  delete next[k];
  return { parked: next, draft };
}

// closed: the three levels are this screen's own table, the loop below never reads a wire key
const LEVEL_WHERE: Record<SwitchLevel, string> = { global: "All repos", "repo-shared": "the shared repo file", "repo-local": "This repo" };
/** A sentence for choices kept for the OTHER files of this repo, null when there are none. */
export function parkedWords(parked: Parked, repoId: string | null, level: SwitchLevel): string | null {
  const where: string[] = [];
  let n = 0;
  for (const lv of Object.keys(LEVEL_WHERE) as SwitchLevel[]) {
    if (lv === level) continue;
    const c = Object.keys(parked[parkKey(repoId, lv)] ?? {}).length;
    if (c) { n += c; where.push(LEVEL_WHERE[lv]); }
  }
  return n ? `${n} unsaved ${n === 1 ? "choice is" : "choices are"} kept for ${where.join(" and ")}; switch back to see ${n === 1 ? "it" : "them"}.` : null;
}

// ── rows, filters, sort ──────────────────────────────────────────────────────

export interface Split { plugins: PluginRow[]; skills: SkillRow[]; bundled: SkillRow[]; pluginSkills: Map<string, SkillRow> }
/** Plugin cards, standalone skills, bundled skills; plugin-owned skills live inside their card. */
export function splitRows(rows: readonly Row[]): Split {
  const plugins: PluginRow[] = [], skills: SkillRow[] = [], bundled: SkillRow[] = [];
  const pluginSkills = new Map<string, SkillRow>();
  for (const r of rows) {
    if (r.kind === "plugin") plugins.push(r);
    else if (r.source === "plugin") pluginSkills.set(r.id, r);
    else if (r.source === "bundled") bundled.push(r);
    else skills.push(r);
  }
  return { plugins, skills, bundled, pluginSkills };
}

const used30 = (r: SkillRow): number | null => (r.uses ? r.uses.d30 + r.uses.typed30 : null);
const usedAll = (r: SkillRow): number | null => (r.uses ? r.uses.all + r.uses.typedAll : null);
/** Used in the last 30 days: unknown (no counts) is neither used nor unused. */
export const unused30 = (r: SkillRow): boolean => used30(r) === 0;

/** ONE bucketing function for the chip's number and the cut it opens. */
export function bucket(key: FilterKey, split: Split, draft: Draft, usageReady: boolean): { plugins: PluginRow[]; skills: SkillRow[] } {
  const changed = (r: Row) => keyOf(r) in draft;
  switch (key) { // closed: FILTER_KEYS
    case "plugins": return { plugins: split.plugins, skills: [] };
    case "skills": return { plugins: [], skills: split.skills };
    case "changed": return { plugins: split.plugins.filter(changed), skills: split.skills.filter(changed) };
    case "unused30": return { plugins: [], skills: usageReady ? split.skills.filter(unused30) : [] };
  }
}

export const chipLabel = (k: FilterKey): string => ({ plugins: "plugins", skills: "skills", changed: "changed", unused30: "unused 30d" })[k];
/** "unused 30d" is offered only when the counts exist; absent counts are said in the summary, not as a 0. */
export const chipKeys = (usageReady: boolean): FilterKey[] => FILTER_KEYS.filter((k) => k !== "unused30" || usageReady);
/** The chip's number: the length of the cut `bucket` opens, from the same call. */
export function chipCount(key: FilterKey, split: Split, draft: Draft, usageReady: boolean): number {
  const b = bucket(key, split, draft, usageReady);
  return b.plugins.length + b.skills.length;
}

export function matches(r: Row, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return r.id.toLowerCase().includes(q) || (r.kind === "plugin" && r.name.toLowerCase().includes(q));
}

const weight = (r: Row): number => r.listingChars ?? -1;
export function sortRows<T extends Row>(rows: readonly T[], sort: SortKey): T[] {
  const byName = (a: T, b: T) => a.id.localeCompare(b.id);
  const out = [...rows];
  // closed: SORT_KEYS
  switch (sort) {
    case "heaviest": return out.sort((a, b) => weight(b) - weight(a) || byName(a, b));
    case "used": return out.sort((a, b) => {
      const ua = a.kind === "skill" ? usedAll(a) ?? -1 : -1, ub = b.kind === "skill" ? usedAll(b) ?? -1 : -1;
      const u30a = a.kind === "skill" ? used30(a) ?? -1 : -1, u30b = b.kind === "skill" ? used30(b) ?? -1 : -1;
      return u30b - u30a || ub - ua || byName(a, b);
    });
    case "name": return out.sort(byName);
  }
}

// ── words ────────────────────────────────────────────────────────────────────

export const tokensOf = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);
export const tilde = (chars: number): string => `~${tokensOf(chars).toLocaleString("en-US")} tokens`;

/** The summary line: the total with its split, and what nobody could measure. */
export function summaryWords(t: SkillInventoryDoc["totals"]): string {
  const parts: string[] = [];
  if (t.skillChars !== undefined) parts.push(`skills ${tilde(t.skillChars)}`);
  if (t.pluginChars !== undefined) parts.push(`plugins ${tilde(t.pluginChars)}`);
  const un = t.unmeasured > 0 ? `${parts.length ? ", and " : ""}${t.unmeasured} item${t.unmeasured === 1 ? "" : "s"} nobody could measure` : "";
  if (!parts.length) return t.unmeasured > 0 ? `Weight not measured for ${t.unmeasured} item${t.unmeasured === 1 ? "" : "s"}.` : "Weight not measured.";
  const total = (t.skillChars ?? 0) + (t.pluginChars ?? 0);
  return `Up to ~${tokensOf(total).toLocaleString("en-US")} tokens every turn: ${parts.join(", ")}${un}.`;
}

export function usageWords(u: SkillInventoryDoc["usage"]): string {
  if (u.state === "counting") return `counting uses… ${(u.done ?? 0).toLocaleString("en-US")} of ${(u.total ?? 0).toLocaleString("en-US")} logs`;
  if (u.state === "absent") return u.why ?? "Uses are not counted on this desktop.";
  return "Uses are counted in this repo's Claude conversations on this desktop: last 30 days · all time.";
}

/** `uses 3 · 41`, or null while the counts are not there (never a 0 that was not counted). */
export function usesWords(r: SkillRow): string | null {
  const a = used30(r), b = usedAll(r);
  return a === null || b === null ? null : `used ${a} in 30 days · ${b} ever`;
}

/** A quiet tag only when the state is NOT the default. */
export function stateTag(r: SkillRow): string | null {
  if (r.locked) return r.lockedBy === "author" ? "locked by the skill itself" : "locked by policy";
  if (r.effective === "on") return null;
  const what = STATE_TAG[r.effective] ?? r.effective;
  if (r.from === "global") return `${what} for all repos`;
  if (r.from === "repo-local" || r.from === "repo-shared") return `${what} here`;
  return what;
}
export function pluginTag(r: PluginRow): string | null {
  if (r.from === "locked") return "locked by policy";
  if (r.enabled) return null;
  return r.from === "global" ? "off for all repos" : r.from === "default" ? "off" : "off here";
}

/** The Save button: short enough for a phone. The file and the saving go on the line above (`saveNote`). */
export function saveWords(n: number): string {
  return `Save ${n} change${n === 1 ? "" : "s"}`;
}

/** The line above Save: which file is written, and what it saves. */
export function saveNote(file: string, tokens: number, unmeasured: number): string {
  return tokens === 0 && unmeasured === 0 ? `Writes ${file}.` : `Writes ${file} · ${skillSavingsLine(tokens, unmeasured).replace(/\.$/, "").toLowerCase()}.`;
}

export function savingsFor(rows: readonly Row[], changes: SkillChange[]) {
  return savingsOf(rows as Row[], changes);
}

export function receiptWords(n: number, file: string): string {
  return `${n} change${n === 1 ? "" : "s"} written to ${file}; new sessions only.`;
}

/** What an inherit button removes: only offered when this level holds a key for the row. */
export const canInherit = (r: Row, level: SwitchLevel, draft: Draft): boolean =>
  setAt(r, level) !== undefined && draft[keyOf(r)] !== "inherit";

export const isState = (v: unknown): v is SkillState => (SKILL_STATES as readonly unknown[]).includes(v);

// ── suggestions (Recommend) ─────────────────────────────────────────────────
// A suggestion is only a sentence until a person taps Apply; ticking is the person's choice.

export const suggestKey = (s: { kind: string; id: string }): string => keyOf(s);

/** The write a suggestion stands for: a plugin only ever goes off (`false`), a skill to the named state. */
export const suggestionWant = (s: SkillSuggestion): Want => (s.kind === "plugin" ? false : s.to);

/** The ticked suggestions as write changes, in the list's order. Unticked ones are never sent. */
export function suggestionChanges(list: readonly SkillSuggestion[], unticked: readonly string[]): SkillChange[] {
  const off = new Set(unticked);
  return list.filter((s) => !off.has(suggestKey(s))).map((s) => ({ kind: s.kind, id: s.id, to: suggestionWant(s) }));
}

/**
 * The suggestions that are still true of these rows. The host drops a suggestion at or below the
 * state a row already holds when it answers; a Save or a re-read can make that so afterwards, and
 * Apply must never raise a skill someone has since switched further down (off -> names).
 */
export function reconcileSuggestions(list: readonly SkillSuggestion[], rows: readonly Row[]): SkillSuggestion[] {
  const by = new Map(rows.map((r) => [keyOf(r), r]));
  return list.filter((s) => {
    const r = by.get(suggestKey(s));
    if (!r) return false;
    if (r.kind === "plugin") return r.enabled;
    return SKILL_STATES.indexOf(r.effective) < SKILL_STATES.indexOf(s.to);
  });
}

const TO_WORDS: Record<SkillSuggestion["to"], string> = { "name-only": "names only", "user-invocable-only": "slash only", off: "off" };
/** "on → names": the from-state is what the row shows now. */
export function suggestionMove(s: SkillSuggestion, rows: readonly Row[]): string {
  const r = rows.find((x) => x.kind === s.kind && x.id === s.id);
  const from = !r ? "on" : r.kind === "skill" ? wordOf(STATE_WORDS, r.effective, r.effective) : r.enabled ? "on" : "off";
  return `${from} → ${wordOf(TO_WORDS, s.to, s.to)}`;
}

export function suggestionUses(s: SkillSuggestion): string | null {
  return s.uses30 === undefined || s.usesAll === undefined ? null : `used ${s.uses30} in 30 days · ${s.usesAll} ever`;
}

/** The chars the ticked suggestions free, from the host's own figures; unmeasured ones add nothing. */
export function tickedChars(list: readonly SkillSuggestion[], unticked: readonly string[]): number {
  const off = new Set(unticked);
  return list.filter((s) => !off.has(suggestKey(s))).reduce((n, s) => n + (s.savedChars ?? 0), 0);
}

/** The Apply button; the file is named once, by the file line above, and the saving by `applyNote`. */
export function applyWords(n: number): string {
  return `Apply ${n} ${n === 1 ? "suggestion" : "suggestions"}`;
}

export function applyNote(savedChars: number): string | null {
  const tokens = tokensOf(savedChars);
  return tokens > 0 ? `Up to about ${tokens.toLocaleString("en-US")} tokens fewer per turn.` : null;
}

/** What a suggestion is called: a plugin by its own name, not its raw "name@source" key. */
export function suggestionName(s: SkillSuggestion, rows: readonly Row[]): string {
  const r = rows.find((x) => x.kind === s.kind && x.id === s.id);
  return r && r.kind === "plugin" ? r.name : s.id;
}

export function spendWords(sp: SkillRecommendResponse["spend"], dropped: number): string | null {
  const parts: string[] = [];
  if (sp?.costUsd !== undefined) parts.push(`this suggestion cost ${sp.costUsd < 0.01 ? "under 1 cent" : `about $${sp.costUsd.toFixed(2)}`}${sp.model ? ` on ${sp.model}` : ""}`);
  if (dropped > 0) parts.push(`${dropped} the desktop could not use ${dropped === 1 ? "was" : "were"} left out`);
  return parts.length ? parts.join("; ") + "." : null;
}

/** What the list says when the host gave no suggestions: its own sentence, else a plain one. */
export function emptyWords(r: SkillRecommendResponse): string {
  if (r.error) return r.error;
  if (r.note) return r.note;
  return "Nothing worth switching off was found.";
}

export const RECOMMEND_COST = "Asks a model on this desktop to look at your skills and plugins: this spends one model call.";
export const SUGGEST_ONLY_LIST = "Nothing was changed by this list. Untick what you want to keep, then apply.";
