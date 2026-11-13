/**
 * Skills Recommend (P5, docs/analysis/skills-switch/PLAN.md): ONE cheap unattended call that
 * suggests which skills and plugins to switch off for one repo. Spender rules (host-spenders):
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
const TO_SET = new Set(["name-only", "user-invocable-only", "off"]);

export const SKILLS_SYSTEM_DEFAULT =
  "You help a person trim the skills and plugins their coding agent lists on every turn. You get rows " +
  "with weight and use counts for ONE repo. Suggest only items that cost context and that this repo " +
  "does not use: weigh chars, uses in the last 30 days, uses all time, and referencedBy. Never suggest an " +
  "item with a non-empty referencedBy. Prefer `name-only` for something occasionally useful, `off` for " +
  "something unused or irrelevant to this repo, `user-invocable-only` for something the person types " +
  "but the model should not pick. For a plugin only `off`. Counts are for this repo only: say so in the " +
  "reason, never claim a skill is useless in general. At most 30 suggestions, reasons under 140 " +
  "characters, plain words. Output one JSON object and nothing else. Shape: " +
  '{"suggestions":[{"kind":"skill|plugin","id":"...","to":"name-only|user-invocable-only|off","reason":"..."}],"note":"optional one sentence"}';

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
  id: string; kind: "skill" | "plugin"; source?: string; state: string; chars?: number; tok?: number;
  uses30?: number; usesAll?: number; typed30?: number; typedAll?: number; referencedBy: string[]; desc?: string;
}

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
      id: s.id, kind: "skill", source: s.source, state: s.effective, chars: s.listingChars,
      tok: s.listingChars === undefined ? undefined : Math.round(s.listingChars / 4),
      uses30: s.uses?.d30, usesAll: s.uses?.all, typed30: s.uses?.typed30, typedAll: s.uses?.typedAll,
      referencedBy: (refs[s.id] ?? []).map((f) => basename(f)), desc: descOf(files[s.id]),
    });
  }
  for (const p of plugins) {
    if (p.from === "locked") continue;
    const mine = skills.filter((s) => s.plugin === p.id);
    const sum = (f: (s: SkillRow) => number | undefined): number | undefined =>
      mine.some((s) => s.uses) ? mine.reduce((a, s) => a + (f(s) ?? 0), 0) : undefined;
    rows.push({
      id: p.id, kind: "plugin", state: p.enabled ? "on" : "off", chars: p.listingChars,
      tok: p.listingChars === undefined ? undefined : Math.round(p.listingChars / 4),
      uses30: sum((s) => s.uses?.d30), usesAll: sum((s) => s.uses?.all),
      typed30: sum((s) => s.uses?.typed30), typedAll: sum((s) => s.uses?.typedAll),
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
    const s = raw as { kind?: unknown; id?: unknown; to?: unknown; reason?: unknown };
    const key = `${String(s?.kind)}:${String(s?.id)}`;
    const row = byKey.get(key);
    const given = inRow.get(key);
    const to = String(s?.to);
    if (out.length >= MAX_SUGGESTIONS || !row || !given || seen.has(key) || !TO_SET.has(to) || typeof s.reason !== "string") { dropped++; continue; }
    if (given.referencedBy.length) { dropped++; continue; }
    if (row.kind === "plugin") {
      if (to !== "off" || !row.enabled) { dropped++; continue; }
    } else if (!row.switchable || RANK[row.effective] >= RANK[to as SkillState]) { dropped++; continue; }
    seen.add(key);
    const change = { kind: row.kind, id: row.id, to: row.kind === "plugin" ? false : (to as SkillState) } as const;
    const sv = savingsOf([row], [change]);
    out.push({
      kind: row.kind, id: row.id, to: to as SkillSuggestion["to"], reason: s.reason.trim().slice(0, MAX_REASON),
      ...(sv.unmeasured ? {} : { savedChars: sv.chars }),
      ...(given.uses30 !== undefined ? { uses30: given.uses30 } : {}),
      ...(given.usesAll !== undefined ? { usesAll: given.usesAll } : {}),
    });
  }
  const note = typeof j.note === "string" && j.note.trim() ? j.note.trim().slice(0, 300) : undefined;
  return { suggestions: out, ...(note ? { note } : {}), dropped };
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
