/**
 * Skills Recommend (P5, docs/analysis/skills-switch/PLAN.md): ONE cheap unattended call that
 * suggests which skills and plugins to switch off, for this repo and for all repos at once. Spender rules (host-spenders):
 * the single sidecar seam (`runSkillsTask`, claude flags none dropped, `--thinking disabled`,
 * `--no-session-persistence`), the halt gate, and NOTHING APPLIES ITSELF - the answer is a list a
 * person ticks. The model's text is DATA: this file validates every suggestion against the
 * inventory and fills savings and counts itself.
 */
import type { PluginRow, SkillInventoryDoc, SkillRow, SkillState, SkillSuggestion, SkillRecommendResponse } from "@waterplane/shared";
import { savingsOf } from "@waterplane/shared";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { env } from "../env.js";
import { haltRefusal } from "../halt.js";
import { promptText } from "../prompts.js";
import { runSkillsTask, sidecarPlan, type NameRequest, type NameRun } from "../sidecar.js";
import { repoReferences } from "./skillrefs.js";

const MODEL = env("SKILLS_MODEL") || env("SUMMARY_MODEL") || "haiku";
const TIMEOUT_MS = Number(env("SKILLS_TIMEOUT_MS") || 60_000);
const INPUT_CAP = 24_000;
export const MAX_SUGGESTIONS = 30;
const MAX_REASON = 140;
const RANK: Record<SkillState, number> = { on: 0, "name-only": 1, "user-invocable-only": 2, off: 3 };

export const SKILLS_SYSTEM_DEFAULT =
  "You help a person trim the skills and plugins their coding agent lists on every turn. Every item has " +
  "two levers: `allRepos` (the value every repo on this desktop follows) and `thisRepo` (this repo's own " +
  "value; leave it out and this repo follows allRepos). Each row gives: weight (chars, tok), the state in " +
  "this repo (`here`), this repo's own value if it sets one (`hereOwn`), the All-repos value (`all`), uses " +
  "in this repo (uses30, usesAll, typed30, typedAll), uses over every repo on this desktop (every30, " +
  "everyAll; absent = not counted, then never set allRepos), and referencedBy (files of THIS repo that name " +
  "it). States: on (name and description listed, the model may use it), name-only (only the name listed, " +
  "still usable), user-invocable-only (hidden from the model, runs when the person types /name), off (gone). " +
  "For a plugin only on or off. Rules: suggest only items that cost context. Lower allRepos when an item is " +
  "little used across all repos; when you do and this repo uses it or referencedBy is non-empty, set " +
  "thisRepo to the state it has here now so this repo keeps it. Lower only thisRepo when it is used " +
  "elsewhere but not here. Never lower an item in this repo when referencedBy is non-empty. Never raise " +
  "allRepos. Prefer name-only for something occasionally useful, off for something unused or unrelated, " +
  "user-invocable-only for something the person types but the model should not pick. Every suggestion " +
  "carries a reason: one plain sentence under 140 characters naming the counts it rests on and what the " +
  "change keeps. At most 30 suggestions. Output one JSON object and nothing else. Shape: " +
  '{"suggestions":[{"kind":"skill|plugin","id":"...","allRepos":"optional state","thisRepo":"optional state","reason":"..."}],"note":"optional one sentence"}';

export interface RecommendDeps {
  run?: (req: NameRequest) => Promise<NameRun>;
  /** Overrides the sidecar plan lookup (tests). */
  refused?: () => string | null;
}

function descOf(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
    const d = m && /^description:(.*)$/m.exec(m[1]!);
    const t = d?.[1]?.trim().replace(/^["'>|-]/, "").trim();
    return t ? t.slice(0, 120) : undefined;
  } catch { return undefined; }
}

interface InRow {
  id: string; kind: "skill" | "plugin"; source?: string; here: string; hereOwn?: string; all: string; chars?: number; tok?: number;
  uses30?: number; usesAll?: number; typed30?: number; typedAll?: number; every30?: number; everyAll?: number;
  referencedBy: string[]; desc?: string;
}

const onOff = (b: boolean): SkillState => (b ? "on" : "off");
/** What a row holds in this repo's own files (local wins), ABSENT when it follows All repos. */
function ownHere(r: SkillRow | PluginRow): SkillState | undefined {
  const v = r.set["repo-local"] ?? r.set["repo-shared"];
  return v === undefined ? undefined : typeof v === "boolean" ? onOff(v) : v;
}
/** The All-repos value: the global file's key, else what a repo follows with no file naming it. */
function allValue(r: SkillRow | PluginRow): SkillState {
  const v = r.set.global;
  if (v !== undefined) return typeof v === "boolean" ? onOff(v) : v;
  return r.kind === "skill" ? "on" : onOff(r.from === "default" ? r.enabled : true);
}
const hereValue = (r: SkillRow | PluginRow): SkillState => (r.kind === "skill" ? r.effective : onOff(r.enabled));

/** Build the model's input rows. Exported for tests. */
export function recommendRows(doc: SkillInventoryDoc, files: Record<string, string>, wt: string): InRow[] {
  const skills = doc.rows.filter((r): r is SkillRow => r.kind === "skill");
  const plugins = doc.rows.filter((r): r is PluginRow => r.kind === "plugin");
  const names = [...new Set([...skills.filter((s) => s.source !== "plugin").map((s) => s.id), ...plugins.map((p) => p.name)])];
  const own: Record<string, string> = {};
  for (const s of skills) if (files[s.id]) own[s.id] = files[s.id]!;
  const refs = repoReferences(wt, names, own);
  const rows: InRow[] = [];
  for (const s of skills) {
    if (s.source === "plugin" || !s.switchable || s.from === "locked") continue;
    rows.push({
      id: s.id, kind: "skill", source: s.source, here: s.effective, hereOwn: ownHere(s), all: allValue(s), chars: s.listingChars,
      tok: s.listingChars === undefined ? undefined : Math.round(s.listingChars / 4),
      uses30: s.uses?.d30, usesAll: s.uses?.all, typed30: s.uses?.typed30, typedAll: s.uses?.typedAll,
      every30: s.usesEverywhere?.d30, everyAll: s.usesEverywhere?.all,
      referencedBy: (refs[s.id] ?? []).map((f) => basename(f)), desc: descOf(files[s.id]),
    });
  }
  for (const p of plugins) {
    if (p.from === "locked") continue;
    const mine = skills.filter((s) => s.plugin === p.id);
    const sum = (f: (s: SkillRow) => number | undefined): number | undefined =>
      mine.some((s) => s.uses) ? mine.reduce((a, s) => a + (f(s) ?? 0), 0) : undefined;
    const every = (f: (s: SkillRow) => number | undefined): number | undefined =>
      mine.some((s) => s.usesEverywhere) ? mine.reduce((a, s) => a + (f(s) ?? 0), 0) : undefined;
    rows.push({
      id: p.id, kind: "plugin", here: hereValue(p), hereOwn: ownHere(p), all: allValue(p), chars: p.listingChars,
      tok: p.listingChars === undefined ? undefined : Math.round(p.listingChars / 4),
      uses30: sum((s) => s.uses?.d30), usesAll: sum((s) => s.uses?.all),
      typed30: sum((s) => s.uses?.typed30), typedAll: sum((s) => s.uses?.typedAll),
      every30: every((s) => s.usesEverywhere?.d30), everyAll: every((s) => s.usesEverywhere?.all),
      referencedBy: (refs[p.name] ?? []).map((f) => basename(f)),
    });
  }
  return rows;
}

function parseJson(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\n```$/.exec(t);
  try { return JSON.parse(fenced ? fenced[1]! : t); } catch { return null; }
}

/** Validate the model's text against the inventory. Exported for tests. */
export function validateSuggestions(text: string, doc: SkillInventoryDoc, rows: InRow[]): { suggestions: SkillSuggestion[]; note?: string; dropped: number } | null {
  const j = parseJson(text) as { suggestions?: unknown; note?: unknown } | null;
  if (!j || typeof j !== "object" || !Array.isArray(j.suggestions)) return null;
  const byKey = new Map(doc.rows.map((r) => [`${r.kind}:${r.id}`, r]));
  const inRow = new Map(rows.map((r) => [`${r.kind}:${r.id}`, r]));
  const seen = new Set<string>();
  const out: SkillSuggestion[] = [];
  let dropped = 0;
  for (const raw of j.suggestions) {
    const s = raw as { kind?: unknown; id?: unknown; allRepos?: unknown; thisRepo?: unknown; to?: unknown; reason?: unknown };
    const key = `${String(s?.kind)}:${String(s?.id)}`;
    const row = byKey.get(key);
    const given = inRow.get(key);
    const reason = typeof s?.reason === "string" ? s.reason.trim() : "";
    if (out.length >= MAX_SUGGESTIONS || !row || !given || seen.has(key) || !reason) { dropped++; continue; }
    const ok = new Set<string>(row.kind === "plugin" ? ["on", "off"] : Object.keys(RANK));
    // `to` is the shape an older prompt override still answers in: this repo only.
    const rawHere = s.thisRepo ?? s.to;
    if ((s.allRepos !== undefined && !ok.has(String(s.allRepos))) || (rawHere !== undefined && !ok.has(String(rawHere)))) { dropped++; continue; }
    if (row.kind === "skill" && !row.switchable) { dropped++; continue; }
    const fixed = settleLevers(row, given, s.allRepos as SkillState | undefined, rawHere as SkillState | undefined);
    if (!fixed) { dropped++; continue; }
    seen.add(key);
    const hereNow = hereValue(row);
    const sv = fixed.result !== hereNow
      ? savingsOf([row], [{ kind: row.kind, id: row.id, to: row.kind === "plugin" ? fixed.result !== "off" : fixed.result }])
      : null;
    out.push({
      kind: row.kind, id: row.id, ...(fixed.to ? { to: fixed.to } : {}), ...(fixed.toAll ? { toAll: fixed.toAll } : {}),
      reason: reason.slice(0, MAX_REASON),
      ...(sv && !sv.unmeasured ? { savedChars: sv.chars } : {}),
      ...(given.uses30 !== undefined ? { uses30: given.uses30 } : {}),
      ...(given.usesAll !== undefined ? { usesAll: given.usesAll } : {}),
      ...(given.every30 !== undefined ? { everywhere30: given.every30 } : {}),
      ...(given.everyAll !== undefined ? { everywhereAll: given.everyAll } : {}),
    });
  }
  const note = typeof j.note === "string" && j.note.trim() ? j.note.trim().slice(0, 300) : undefined;
  return { suggestions: out, ...(note ? { note } : {}), dropped };
}

/**
 * The two levers made safe and minimal, or null when nothing is left to change. All repos is never
 * raised and never touched without all-repos counts; this repo is never lowered below what it holds
 * when a file of it names the item (a lowered All repos then KEEPS it here); a lever that changes
 * nothing is left out. Exported for tests.
 */
export function settleLevers(row: SkillRow | PluginRow, given: InRow, all?: SkillState, here?: SkillState): { toAll?: SkillState; to?: SkillState; result: SkillState } | null {
  const curAll = allValue(row);
  const own = ownHere(row);
  const hereNow = hereValue(row);
  const rank = (v: SkillState) => RANK[v];
  let toAll = all;
  if (toAll !== undefined && (given.everyAll === undefined || rank(toAll) <= rank(curAll))) toAll = undefined;
  let to = here;
  // This repo may go up only to keep what it has against a lowered All repos.
  if (to !== undefined && rank(to) < rank(hereNow) && !(toAll !== undefined && own === undefined && to === hereNow)) to = undefined;
  const follow = (): SkillState => own ?? toAll ?? curAll;
  let result = to ?? follow();
  if (given.referencedBy.length && rank(result) > rank(hereNow)) { to = hereNow; result = hereNow; }
  // A key equal to what this repo holds or would follow anyway is no change.
  if (to !== undefined && (own !== undefined ? to === own : to === (toAll ?? curAll))) to = undefined;
  if (toAll === undefined && to === undefined) return null;
  // A pin with nothing lowered is no suggestion.
  if (toAll === undefined && to !== undefined && rank(to) <= rank(hereNow)) return null;
  return { ...(toAll ? { toAll } : {}), ...(to ? { to } : {}), result: to ?? follow() };
}

const none = (error: string, extra: Partial<SkillRecommendResponse> = {}): SkillRecommendResponse =>
  ({ ok: false, suggestions: [], dropped: 0, error, ...extra });

/** `doc` is the repo inventory with usage filled in by the route; `files` maps skill id -> SKILL.md. */
export async function recommendSkills(
  wt: string, doc: SkillInventoryDoc, files: Record<string, string>, deps: RecommendDeps = {},
): Promise<SkillRecommendResponse> {
  const halted = haltRefusal();
  if (halted) return none(halted);
  if (doc.usage.state === "absent") return none(`Cannot recommend: there are no use counts to go on. ${doc.usage.why ?? "The usage scan found nothing."}`);
  if (doc.usage.state !== "ready" || doc.usage.refreshing) return none("Counting uses is still running. Try again in a moment.");
  const ar = doc.usage.allRepos;
  if (ar?.state === "counting") return none(`Counting uses across all repos is still running${ar.total ? ` (${ar.done ?? 0} of ${ar.total} logs)` : ""}. Try again in a moment.`);
  const plan = deps.refused ? deps.refused() : (() => { const p = sidecarPlan("skills"); return p.engine === "refused" ? p.reason : null; })();
  if (plan) return none(plan);

  let rows = recommendRows(doc, files, wt);
  if (!rows.length) return { ok: true, suggestions: [], dropped: 0, note: "Nothing here can be switched." };
  const wrap = (r: InRow[]): string => JSON.stringify({
    repo: basename(wt), window: { d30: "last 30 days", all: "all time" }, rows: r,
  });
  // Heaviest first, then cut to the input cap: the rows that cost most are the ones worth a call.
  rows = [...rows].sort((a, b) => (b.chars ?? 0) - (a.chars ?? 0));
  while (rows.length > 1 && wrap(rows).length > INPUT_CAP) rows.pop();
  const run = await (deps.run ?? runSkillsTask)({
    cwd: wt, prompt: wrap(rows), system: promptText("skills-recommend", SKILLS_SYSTEM_DEFAULT),
    model: MODEL, timeoutMs: TIMEOUT_MS, persist: false,
  });
  const u = run.usage;
  const spend = { model: MODEL, costUsd: run.usd, inputTokens: u ? u.inTok + u.cacheRead + u.cacheWrite : undefined, outputTokens: u?.outTok };
  if (run.limited) return none(run.detail || "The account is out of quota. Nothing was suggested.", { limited: true, spend });
  if (run.signedOut) return none(run.detail || "Claude is signed out on this desktop.", { spend });
  if (run.failed) return none(run.detail || "No suggestions came back.", { spend });
  const v = validateSuggestions(run.text, doc, rows);
  if (!v) return none("The answer was not in a shape this screen can use. Nothing was changed.", { spend });
  return { ok: true, ...v, spend };
}
