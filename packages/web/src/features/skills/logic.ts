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
  on: "Claude sees its name and description every turn and may use it by itself",
  "name-only": "Claude sees only its name, so each turn carries less; it can still use it, and /name still works",
  "user-invocable-only": "Claude does not see it; it runs only when you type /name",
  off: "gone: Claude does not see it and /name does not work",
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
export function withChoice(draft: Draft, r: Row, level: SwitchLevel, to: Want, globalDraft: Draft = {}): Draft {
  const k = keyOf(r);
  // Tapping what is already chosen is no change, a "keep for this repo" included (only "follow" undoes it).
  if (draft[k] === to) return draft;
  const next = { ...draft };
  const held = setAt(r, level);
  // No key at this level: the tap is redundant when it picks what the level already follows (the next
  // file down, then the default). A repo row that follows All repos stays FOLLOWING until a person
  // picks a different value here; only then does this level get a key of its own.
  const same = to === "inherit" ? held === undefined : held !== undefined ? held === to : fallbackAt(r, level, globalDraft).value === to;
  if (same) delete next[k]; else next[k] = to;
  return next;
}

/** Keep the value a row follows as this level's own key, so a later All-repos change does not move it. */
export function withPin(draft: Draft, r: Row, level: SwitchLevel, globalDraft: Draft = {}): Draft {
  if (setAt(r, level) !== undefined) return draft;
  return { ...draft, [keyOf(r)]: fallbackAt(r, level, globalDraft).value };
}

// ── levels: what a file holds, what it follows ──────────────────────────────

/** The files below a level, nearest first: what the CLI reads when this level holds no key. */
const BELOW: Record<SwitchLevel, SwitchLevel[]> = { "repo-local": ["repo-shared", "global"], "repo-shared": ["global"], global: [] };
export type Value = SkillState | boolean;
export interface Fallback { value: Value; from: SwitchLevel | "default"; unsaved: boolean }

/**
 * What a level follows while it holds no key of its own. An unsaved All-repos choice counts as if
 * saved (`globalDraft`), so a repo row shows what it WILL follow, and says it is unsaved.
 */
export function fallbackAt(r: Row, level: SwitchLevel, globalDraft: Draft = {}): Fallback {
  const k = keyOf(r);
  for (const lv of BELOW[level]) {
    const d = lv === "global" ? globalDraft[k] : undefined;
    if (d === "inherit") continue;
    if (d !== undefined) return { value: d, from: lv, unsaved: true };
    const v = setAt(r, lv);
    if (v !== undefined && v !== "inherit") return { value: v, from: lv, unsaved: false };
  }
  // A plugin no file names is what the CLI resolved; one some file names is on by default once installed.
  const value: Value = r.kind === "skill" ? "on" : r.from === "default" ? r.enabled : true;
  return { value, from: "default", unsaved: false };
}

export interface RowView {
  /** What the selector shows at this level. */
  value: Value;
  /** This level holds (or, after saving, will hold) its own key. */
  own: boolean;
  /** What it follows without a key here. */
  follows: Fallback;
  /** At All repos only: a repo file of THIS repo sets its own value, so the All-repos value does not reach it. */
  overriddenHere?: { value: Value; level: SwitchLevel };
}

export function rowView(r: Row, level: SwitchLevel, draft: Draft, globalDraft: Draft = {}): RowView {
  const d = draft[keyOf(r)];
  const held = setAt(r, level);
  const follows = fallbackAt(r, level, globalDraft);
  const own = d !== undefined ? d !== "inherit" : held !== undefined && held !== "inherit";
  const value = d !== undefined && d !== "inherit" ? d : d === "inherit" ? follows.value : (held !== undefined && held !== "inherit" ? held : follows.value);
  const out: RowView = { value, own, follows };
  if (level === "global") {
    for (const lv of ["repo-local", "repo-shared"] as const) {
      const v = setAt(r, lv);
      if (v !== undefined && v !== "inherit") { out.overriddenHere = { value: v, level: lv }; break; }
    }
  }
  return out;
}

const valueWord = (v: Value): string => (typeof v === "boolean" ? (v ? "on" : "off") : STATE_TAG[v] ?? v);
const WHERE: Record<SwitchLevel | "default", string> = { global: "All repos", "repo-shared": "the shared repo file", "repo-local": "this repo", default: "the default" };

/**
 * The one line under a repo row: where its value comes from. Null when it follows a level that holds
 * nothing either (the plain default): the row then says nothing, so only rows with a story speak.
 */
export function sourceWords(v: RowView): string | null {
  const f = v.follows;
  const at = f.from === "default" ? "All repos" : wordOf(WHERE, f.from, "another settings file");
  const said = `${at}${f.unsaved ? " (unsaved)" : ""}: ${valueWord(f.value)}${f.from === "default" ? " (not set there)" : ""}`;
  if (!v.own) return f.from === "default" ? null : `follows ${said}`;
  return v.value === f.value ? `kept for this repo · ${said}` : `set for this repo · overrides ${said}`;
}

/** The line under an All-repos row whose value this repo does not take. */
export function overriddenWords(v: RowView): string | null {
  const o = v.overriddenHere;
  if (!o) return null;
  return `This repo sets its own: ${valueWord(o.value)}${o.level === "repo-shared" ? " (shared repo file)" : ""}. All repos does not reach it here.`;
}

/** The unsaved All-repos draft a repo level follows: the live draft on All repos, else the one set aside. */
export function globalDraftOf(parked: Parked, repoId: string | null, level: SwitchLevel, draft: Draft): Draft {
  return level === "global" ? draft : parked[parkKey(repoId, "global")] ?? {};
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
export const parkKeyOf = parkKey;

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

/** What a "follow" button removes: only offered when this level holds (or will hold) a key for the row. */
export const canInherit = (r: Row, level: SwitchLevel, draft: Draft): boolean =>
  draft[keyOf(r)] !== undefined ? draft[keyOf(r)] !== "inherit" : setAt(r, level) !== undefined;

export const isState = (v: unknown): v is SkillState => (SKILL_STATES as readonly unknown[]).includes(v);

// ── suggestions (Recommend) ─────────────────────────────────────────────────
// A suggestion is only a sentence until a person taps Apply; ticking is the person's choice.

export const suggestKey = (s: { kind: string; id: string }): string => keyOf(s);

const LEVER_RANK: Record<SkillState, number> = { on: 0, "name-only": 1, "user-invocable-only": 2, off: 3 };
const asState = (v: Value): SkillState => (typeof v === "boolean" ? (v ? "on" : "off") : v);
/** The All-repos value a row holds now (the global key, else what a repo follows without one). */
export const allNow = (r: Row): SkillState => asState(setAt(r, "global") as Value | undefined ?? fallbackAt(r, "global").value);
/** This repo's own value (local file wins), ABSENT when it follows All repos. */
export function ownNow(r: Row): SkillState | undefined {
  const v = (setAt(r, "repo-local") ?? setAt(r, "repo-shared")) as Value | "inherit" | undefined;
  return v === undefined || v === "inherit" ? undefined : asState(v);
}
export const hereNow = (r: Row): SkillState => (r.kind === "skill" ? r.effective : r.enabled ? "on" : "off");
const wantOf = (kind: Row["kind"], v: SkillState): Want => (kind === "plugin" ? v !== "off" : v);

/** The ticked suggestions as the two writes they stand for: All repos first, then this repo's file. */
export function suggestionChanges(list: readonly SkillSuggestion[], unticked: readonly string[]): { all: SkillChange[]; here: SkillChange[] } {
  const ticked = tickedSuggestions(list, unticked);
  return {
    all: ticked.filter((s) => s.toAll).map((s) => ({ kind: s.kind, id: s.id, to: wantOf(s.kind, s.toAll!) })),
    here: ticked.filter((s) => s.to).map((s) => ({ kind: s.kind, id: s.id, to: wantOf(s.kind, s.to!) })),
  };
}
export const changeCount = (c: { all: SkillChange[]; here: SkillChange[] }): number => c.all.length + c.here.length;

/**
 * The suggestions that are still true of these rows, each lever on its own. A Save or re-read can
 * make one untrue after the answer: All repos is never raised back (off -> names), a repo value
 * already held is no change. A suggestion with no lever left is not offered.
 */
export function reconcileSuggestions(list: readonly SkillSuggestion[], rows: readonly Row[]): SkillSuggestion[] {
  const by = new Map(rows.map((r) => [keyOf(r), r]));
  const out: SkillSuggestion[] = [];
  for (const s of list) {
    const r = by.get(suggestKey(s));
    if (!r) continue;
    const toAll = s.toAll && LEVER_RANK[allNow(r)] < LEVER_RANK[s.toAll] ? s.toAll : undefined;
    const own = ownNow(r);
    // A lowering of this repo only while it is still above the target; a keep only while All repos is lowered.
    const to = !s.to ? undefined
      : toAll && s.to === hereNow(r) && own === undefined ? s.to
      : own !== s.to && LEVER_RANK[hereNow(r)] < LEVER_RANK[s.to] ? s.to : undefined;
    if (!toAll && !to) continue;
    const { to: _t, toAll: _a, ...rest } = s;
    out.push({ ...rest, ...(toAll ? { toAll } : {}), ...(to ? { to } : {}) });
  }
  return out;
}

const word = (v: SkillState): string => STATE_TAG[v] ?? v;
/**
 * The two lever lines of a suggestion: what All repos goes from and to, and what this repo ends up
 * with (its own change, a keep against the All-repos change, or following it).
 */
export function suggestionLevers(s: SkillSuggestion, rows: readonly Row[]): { all: string | null; here: string } {
  const r = rows.find((x) => x.kind === s.kind && x.id === s.id);
  const now = r ? hereNow(r) : "on";
  const own = r ? ownNow(r) : undefined;
  const all = s.toAll ? `All repos: ${word(r ? allNow(r) : "on")} → ${word(s.toAll)}` : null;
  let here: string;
  if (s.to) here = s.to === now ? `This repo: stays ${word(now)} (kept for this repo)` : `This repo: ${word(now)} → ${word(s.to)}`;
  else if (own !== undefined) here = `This repo: keeps its own value, ${word(own)}`;
  else here = s.toAll === now ? `This repo: ${word(now)}, follows All repos` : `This repo: follows All repos, ${word(now)} → ${word(s.toAll!)}`;
  return { all, here };
}

/** What the target words of a list mean, once per state anything moves to ("on" needs no gloss), in rank order. */
export function suggestionMeanings(list: readonly SkillSuggestion[]): string[] {
  const used = new Set(list.flatMap((s) => [s.toAll, s.to]).filter((v): v is SkillState => !!v && v !== "on"));
  return SKILL_STATES.filter((v) => used.has(v)).map((v) => `${word(v)}: ${wordOf(STATE_TITLES, v, "a state this screen does not know")}.`);
}

/** The ticked suggestions: the one cut both the Apply count and its writes come from. */
export const tickedSuggestions = (list: readonly SkillSuggestion[], unticked: readonly string[]): SkillSuggestion[] =>
  list.filter((s) => !unticked.includes(suggestKey(s)));

/** The counts the suggestion rests on: this repo, then every repo on this desktop. */
export function suggestionUses(s: SkillSuggestion): string | null {
  const here = s.uses30 === undefined || s.usesAll === undefined ? null : `this repo ${s.uses30} in 30 days, ${s.usesAll} ever`;
  const all = s.everywhere30 === undefined || s.everywhereAll === undefined ? null : `all repos ${s.everywhere30} in 30 days, ${s.everywhereAll} ever`;
  return [here, all].filter(Boolean).join(" · ") || null;
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

/** Which files an Apply writes: only those a ticked lever touches. */
export function applyFilesWords(c: { all: SkillChange[]; here: SkillChange[] }, globalPath: string | null, repoPath: string | null): string | null {
  const parts: string[] = [];
  if (c.all.length && globalPath) parts.push(`${globalPath} for all repos (${c.all.length})`);
  if (c.here.length && repoPath) parts.push(`${repoPath} for this repo (${c.here.length})`);
  return parts.length ? `Writes ${parts.join(" and ")}.` : null;
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

/** The two-way choice for which repo file a save writes, and what each one means. */
export const REPO_FILE_WORDS = { local: "just me, this desktop", shared: "everyone with the repo" } as const;
export function repoFileHelp(shared: boolean): string {
  return shared
    ? ".claude/settings.json: committed, so every clone gets it once pushed."
    : ".claude/settings.local.json: gitignored, stays on this desktop.";
}

export const RECOMMEND_COST = "Asks a model on this desktop to look at your skills and plugins, for this repo and for all repos at once: this spends one model call.";
export const SUGGEST_ONLY_LIST = "Nothing was changed by this list. Each row sets All repos and this repo together, from uses here and in every repo on this desktop; untick what you want to keep as it is, then apply.";
