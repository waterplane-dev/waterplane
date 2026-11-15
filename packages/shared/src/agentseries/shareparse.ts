/**
 * Reading a setup block someone pasted (R-metrics-073), and the side by side. The parser is strict:
 * a size cap before anything is parsed, then every field rebuilt from the ones it NAMES (an extra
 * field is dropped and listed, never kept), and any field out of shape refuses the whole block with
 * one sentence — a half-read block would be a figure nobody sent.
 */
import { START_GROUPS, START_PARTS, type StartGroup } from "../wire/agentreadings.js";
import {
  SETUP_SHARE_KIND, SETUP_SHARE_SCHEMA, SHARE_CLI_RE, SHARE_DAY_RE, SHARE_MODEL_RE, SHARE_UNLISTED,
  cleanShareName, cleanShareProbe, cleanShareRepo, shareGroupOf,
  type SetupShareBlock, type SetupShareGroup,
} from "./share.js";

/** The longest text the parser reads; a real block is about 1.5k. */
export const SETUP_SHARE_MAX_CHARS = 8000;
const PART_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MAX_PARTS = 24;
const TOP = ["kind", "schema", "from", "backend", "models", "cli", "repo", "days", "startTok", "groups", "probe"] as const;

export type SetupShareParse = { ok: true; block: SetupShareBlock; dropped: string[] } | { ok: false; why: string };

const fin = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const extrasOf = (o: unknown, allowed: readonly string[], at: string): string[] =>
  o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${at}.${k}`) : [];
const has = (o: Record<string, number> | undefined, k: string): number | undefined =>
  o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
const no = (why: string): SetupShareParse => ({ ok: false, why });

function strList(raw: unknown, re: RegExp, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out: string[] = [];
  for (const x of raw) { if (typeof x !== "string" || !re.test(x) || out.includes(x)) return null; out.push(x); }
  return out;
}

export function parseSetupShare(text: unknown): SetupShareParse {
  if (typeof text !== "string" || !text.trim()) return no("Nothing to read: paste the block, or pick its file.");
  if (text.length > SETUP_SHARE_MAX_CHARS) return no(`This is ${text.length} characters; a setup block is at most ${SETUP_SHARE_MAX_CHARS}, so it is not one.`);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return no("This is not a setup block: it does not read as JSON. Paste the whole block, braces included."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return no("This is not a setup block: it is not one JSON object.");
  const r = raw as Record<string, unknown>;
  if (r.kind !== SETUP_SHARE_KIND) return no(`This is not a setup block: its "kind" is not "${SETUP_SHARE_KIND}".`);
  if (typeof r.schema === "number" && r.schema > SETUP_SHARE_SCHEMA) return no(`This block was made by a newer version (format ${r.schema}); this phone reads format ${SETUP_SHARE_SCHEMA}. Update the app, then import it again.`);
  if (r.schema !== SETUP_SHARE_SCHEMA) return no(`This block's format is not one this phone reads (it reads format ${SETUP_SHARE_SCHEMA}).`);
  const from = cleanShareName(r.from);
  if (!from) return no("The block's name is missing or not a plain name, so it cannot say whose desktop it came from.");
  if (typeof r.backend !== "string" || !SHARE_MODEL_RE.test(r.backend)) return no("The block's backend is missing or not a plain name.");
  const models = strList(r.models, SHARE_MODEL_RE, 4);
  if (!models) return no("The block's model list is not a short list of model ids.");
  const cli = strList(r.cli, SHARE_CLI_RE, 4);
  if (!cli) return no("The block's CLI versions are not a short list of version numbers.");
  let repo: SetupShareBlock["repo"];
  if (r.repo !== undefined) { const c = cleanShareRepo(r.repo); if (!c) return no("The block's repo is not a name with a 16-digit hash."); repo = c; }
  const d = r.days as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object" || typeof d.from !== "string" || typeof d.to !== "string" || !SHARE_DAY_RE.test(d.from) || !SHARE_DAY_RE.test(d.to) || d.from > d.to) {
    return no("The block's date range is not two days, oldest first.");
  }
  if (!fin(r.startTok, 0, 1e7)) return no("The block's start tokens are not a plausible figure.");
  if (!Array.isArray(r.groups) || r.groups.length > START_GROUPS.length) return no("The block's groups are not the repo's / yours / the CLI's / not split.");
  const groups: SetupShareGroup[] = [];
  const inner: string[] = [
    ...extrasOf(r.repo, ["name", "key"], "repo"), ...extrasOf(r.days, ["from", "to"], "days"),
    ...extrasOf(r.probe, ["day", "kind", "correct", "tokPerQuestion", "repeats", "model", "questions", "draw"], "probe"),
  ];
  for (const g0 of r.groups) {
    for (const k of extrasOf(g0, ["group", "chars", "parts"], "groups[]")) if (!inner.includes(k)) inner.push(k);
    const g = g0 as Record<string, unknown>;
    if (!g || typeof g !== "object" || !START_GROUPS.some((x) => x.id === g.group) || groups.some((x) => x.group === g.group)) {
      return no("A group in the block is not one of the repo's / yours / the CLI's / not split, or is there twice.");
    }
    if (!fin(g.chars, 0, 1e7)) return no("A group's size in the block is not a plausible figure.");
    const p = g.parts as Record<string, unknown> | undefined;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length > MAX_PARTS) return no("A group's parts in the block are not a short list of sizes.");
    const parts: Record<string, number> = {};
    for (const [k, v] of Object.entries(p)) {
      // An open key, but a plain word: a key shaped like a tool, plugin or path name is refused, not shown.
      if (!PART_KEY_RE.test(k)) return no("A part in the block is named like a tool, plugin or file rather than a part, so it is not shown.");
      // A part this version names belongs to ITS group; one filed elsewhere is a block this phone would misread.
      const known = START_PARTS.some((x) => x.id === k) || k === SHARE_UNLISTED;
      if (known && shareGroupOf(k) !== g.group) return no(`The block files "${k}" under a different group than this phone does.`);
      if (!fin(v, 0, 1e7)) return no("A part's size in the block is not a plausible figure.");
      parts[k] = v;
    }
    groups.push({ group: g.group as StartGroup, chars: g.chars, parts });
  }
  // `cost` (a P5 block's setup cost figure) is not named: it is a behaviour reading (cost ÷ start =
  // requests per session), so a block that carries it has it dropped and counted like any extra field.
  let probe: SetupShareBlock["probe"];
  if (r.probe !== undefined) { const c = cleanShareProbe(r.probe); if (!c) return no("The block's probe result is not one this phone reads."); probe = c; }
  const block: SetupShareBlock = {
    kind: SETUP_SHARE_KIND, schema: SETUP_SHARE_SCHEMA, from, backend: r.backend, models, cli,
    ...(repo ? { repo } : {}), days: { from: d.from, to: d.to }, startTok: r.startTok, groups,
    ...(probe ? { probe } : {}),
  };
  return { ok: true, block, dropped: [...Object.keys(r).filter((k) => !(TOP as readonly string[]).includes(k)), ...inner] };
}

// ── Side by side ────────────────────────────────────────────────────────────

/** How the repo's half of two blocks relates: one predicate for the caption and its flag. */
export type ShareRepoHalf = "identical" | "differs" | "otherRepo" | "unknownRepo";

export interface ShareCompareRow {
  key: string;
  label: string;
  mine?: number;
  theirs?: number;
}

export interface ShareCompareGroup {
  group: StartGroup;
  label: string;
  note: string;
  mine?: number;
  theirs?: number;
  parts: ShareCompareRow[];
}

export interface ShareCompare {
  groups: ShareCompareGroup[];
  repoHalf: ShareRepoHalf;
}

/** The label a part key reads as on this phone; a key it cannot name says so rather than vanishing. */
export function sharePartLabel(key: string): string {
  if (key === SHARE_UNLISTED) return "parts this version does not name";
  return START_PARTS.find((p) => p.id === key)?.label ?? `${key} (a part this version does not name)`;
}

/** Equal within 1% (or both under 50 chars): rounding of a median, not a different file. */
const same = (a: number | undefined, b: number | undefined): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= Math.max(50, 0.01 * Math.max(a, b));

export function setupShareCompare(mine: SetupShareBlock, theirs: SetupShareBlock): ShareCompare {
  const order = [...START_PARTS.map((p) => p.id), SHARE_UNLISTED];
  const groups: ShareCompareGroup[] = [];
  for (const g of START_GROUPS) {
    const a = mine.groups.find((x) => x.group === g.id);
    const b = theirs.groups.find((x) => x.group === g.id);
    if (!a && !b) continue;
    const keys = new Set([...Object.keys(a?.parts ?? {}), ...Object.keys(b?.parts ?? {})]);
    const sorted = [...keys].sort((x, y) => {
      const ix = order.indexOf(x), iy = order.indexOf(y);
      return (ix < 0 ? 1e3 : ix) - (iy < 0 ? 1e3 : iy) || x.localeCompare(y);
    });
    groups.push({
      group: g.id, label: g.label, note: g.note,
      ...(a ? { mine: a.chars } : {}), ...(b ? { theirs: b.chars } : {}),
      parts: sorted.map((k) => ({ key: k, label: sharePartLabel(k), ...(has(a?.parts, k) !== undefined ? { mine: has(a?.parts, k) } : {}), ...(has(b?.parts, k) !== undefined ? { theirs: has(b?.parts, k) } : {}) })),
    });
  }
  let repoHalf: ShareRepoHalf;
  if (!mine.repo || !theirs.repo) repoHalf = "unknownRepo";
  else if (mine.repo.key !== theirs.repo.key) repoHalf = "otherRepo";
  else {
    const rg = groups.find((g) => g.group === "repo");
    repoHalf = !rg || (same(rg.mine, rg.theirs) && rg.parts.every((p) => same(p.mine, p.theirs))) ? "identical" : "differs";
  }
  return { groups, repoHalf };
}
