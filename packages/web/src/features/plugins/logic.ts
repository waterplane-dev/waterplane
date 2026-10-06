/**
 * The plugins feature's pure half — no React, no DOM — so `logic.test.mjs`
 * runs it under `node --test`. What a plugin DECLARED (`PluginManifest`) plus
 * what the host SAYS about it (`PluginView`, `SessionInfo.plugin*`) turned into
 * the rows the phone draws. The phone never runs plugin code: every control
 * here is the app's own, drawn from a declaration.
 */
import { cleanPluginValue } from "@waterplane/shared";
import type {
  DecisionLogEntry, PluginActionDef, PluginBadge, PluginField, PluginToggleDef, PluginValue, PluginView, SessionInfo,
} from "@waterplane/shared";

// ── Settings ──────────────────────────────────────────────────────────────────

/** The one sentence under a plugin's name: what state it is in, and why. The
 *  error is the host's own words, verbatim — never paraphrased into "failed". */
export function pluginStateLine(p: PluginView): { tone: "ok" | "bad" | "dim"; text: string } {
  if (p.state === "error") return { tone: "bad", text: `not loaded: ${p.error?.trim() || "the desktop gave no reason"}` };
  if (p.state === "off") return { tone: "dim", text: "off — not activated; nothing of it runs on the desktop" };
  return { tone: "ok", text: "active" };
}

/** Declared env names with set/unset, in the manifest's order. Never a value:
 *  the host only ever says whether one is set. */
export function envRows(p: PluginView): { name: string; set: boolean }[] {
  const names = p.manifest.env ?? Object.keys(p.env ?? {});
  return names.map((name) => ({ name, set: p.env?.[name] === true }));
}

/**
 * What a typed field's raw text means. A number that is not a number, or is
 * outside the declared range, is REFUSED with the reason in words — never
 * clamped into a value the person did not type.
 */
export function parseFieldInput(f: PluginField, raw: string): { ok: true; value: PluginValue } | { ok: false; why: string } {
  if (f.kind === "number") {
    const t = raw.trim();
    const n = t === "" ? NaN : Number(t);
    if (!Number.isFinite(n)) return { ok: false, why: `${f.label}: "${raw}" is not a number` };
    if (n < f.min || n > f.max) return { ok: false, why: `${f.label}: ${n} is outside ${f.min}–${f.max}` };
    return { ok: true, value: n };
  }
  const v = f.kind === "switch" ? raw === "true" : raw;
  const clean = cleanPluginValue(f, v);
  return clean === undefined ? { ok: false, why: `${f.label}: that value is not one it accepts` } : { ok: true, value: clean };
}

/** The `plugin.set` payload for one change: only the changed key, or null when
 *  it equals what the host already has (a re-tap of the lit chip sends nothing). */
export function changedValues(p: PluginView, key: string, value: PluginValue): Record<string, PluginValue> | null {
  return p.values[key] === value ? null : { [key]: value };
}

/** A field's current value, the manifest default when the host sent none. */
export function fieldValue(p: PluginView, f: PluginField): PluginValue {
  return p.values[f.key] ?? f.default;
}

/** The actions a plugin's Settings section draws. */
export function globalActions(p: PluginView): PluginActionDef[] {
  return (p.manifest.actions ?? []).filter((a) => a.scope === "global");
}

// ── A session ─────────────────────────────────────────────────────────────────

/** One toggle as a session has it: the value in force, and whether that is
 *  the person's choice or the manifest default. */
export interface ToggleState { def: PluginToggleDef; on: boolean; overridden: boolean }

/** What one active plugin draws in a session's menu. */
export interface SessionPluginControls {
  id: string;
  name: string;
  toggles: ToggleState[];
  /** The core-owned "let <name> answer" switch; null when the manifest did not
   *  declare `answers`, so there is no switch to draw. */
  mayAnswer: boolean | null;
  actions: PluginActionDef[];
}

/** Every ACTIVE plugin with something to draw for this session, in the host's
 *  order. A plugin that is off or failed has no controls on a session: it is
 *  not running, and its Settings section is where that is said. A plugin that
 *  adds backends (`manifest.backends`) draws only on a session running one of
 *  them — Copilot's answer switch on a claude session controls nothing.
 *  An absent `backend` is claude (`SessionInfo.backend`). */
export function sessionControls(plugins: readonly PluginView[] | null, s: Pick<SessionInfo, "pluginToggles" | "pluginAnswer" | "backend">): SessionPluginControls[] {
  const out: SessionPluginControls[] = [];
  const backend = s.backend ?? "claude";
  for (const p of plugins ?? []) {
    if (p.state !== "active") continue;
    const m = p.manifest;
    if (m.backends?.length && !m.backends.includes(backend)) continue;
    const set = s.pluginToggles?.[m.id] ?? {};
    const toggles = (m.toggles ?? []).map((def) => {
      const overridden = typeof set[def.id] === "boolean";
      return { def, on: overridden ? set[def.id] : def.default, overridden };
    });
    const actions = (m.actions ?? []).filter((a) => a.scope === "session");
    const mayAnswer = m.answers ? s.pluginAnswer?.[m.id] === true : null;
    if (!toggles.length && !actions.length && mayAnswer === null) continue;
    out.push({ id: m.id, name: m.name, toggles, mayAnswer, actions });
  }
  return out;
}

/** One plugin's standing rules on a session, as the host holds them (`SessionInfo.pluginRules`). */
export interface SessionRuleGroup { id: string; name: string; lines: string[] }

/** One rule as a line: what it allows, and how often it has answered with nobody tapping. */
export function ruleLine(r: { label: string; uses: number }): string {
  const what = r.label.trim() || "a request";
  const n = Number.isInteger(r.uses) && r.uses > 0 ? r.uses : 0;
  return `${what} — ${n ? `answered ${n} time${n === 1 ? "" : "s"} without asking` : "not used yet"}`;
}

/** Every plugin with a standing rule on this session, sorted by id so the menu does not
 *  reshuffle. Read from host state only — a plugin's badge is its own account, this is the gate's. */
export function sessionRuleGroups(s: Pick<SessionInfo, "pluginRules">, plugins: readonly PluginView[] | null): SessionRuleGroup[] {
  return Object.entries(s.pluginRules ?? {})
    .filter(([, rs]) => Array.isArray(rs) && rs.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, rs]) => ({ id, name: pluginName(plugins, id), lines: rs.map(ruleLine) }));
}

/** The value a toggle tap sends: flip it — and a flip that lands back on the
 *  manifest default is sent as `null` ("back to default"), so the session
 *  follows a later change of default instead of pinning today's. */
export function nextToggleValue(t: ToggleState): boolean | null {
  const next = !t.on;
  return next === t.def.default ? null : next;
}

/** The badges plugins put on a session row, labelled with the plugin's name
 *  when the list knows it; sorted by plugin id so a row does not reshuffle. */
export function sessionBadges(s: Pick<SessionInfo, "pluginBadges">, plugins: readonly PluginView[] | null): { id: string; name: string; badge: PluginBadge }[] {
  const entries = Object.entries(s.pluginBadges ?? {}).filter(([, b]) => b && typeof b.text === "string" && b.text.trim());
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, badge]) => ({ id, name: pluginName(plugins, id), badge }));
}

/** A plugin's display name, else its id (a row about a plugin that is no longer
 *  installed still says whose it was). */
export function pluginName(plugins: readonly PluginView[] | null, id: string): string {
  return plugins?.find((p) => p.manifest.id === id)?.manifest.name || id;
}

/** The key an action's result is filed under — one per button, so the answer
 *  shows beside the button that asked. */
export function actionKey(pluginId: string, action: string, sessionId?: string): string {
  return `${pluginId}\u0000${action}\u0000${sessionId ?? ""}`;
}

// ── The decision log ──────────────────────────────────────────────────────────

/** Who a decision-log row is from: `limit`, or `plugin:<id>`. */
export function decisionSource(e: Pick<DecisionLogEntry, "source" | "plugin">): string {
  return e.source === "limit" ? "limit" : `plugin:${e.plugin ?? "?"}`;
}

/** The label of a source key, as the filter chips and rows say it. */
export function sourceLabel(key: string, plugins: readonly PluginView[] | null): string {
  if (key === "limit") return "usage limit";
  return pluginName(plugins, key.replace(/^plugin:/, ""));
}

/** The sources present in a list, with how many rows each has — the filter
 *  chips' numbers, from the same cut the list is drawn with. */
export function decisionSources(entries: readonly DecisionLogEntry[]): { key: string; n: number }[] {
  const m = new Map<string, number>();
  for (const e of entries) m.set(decisionSource(e), (m.get(decisionSource(e)) ?? 0) + 1);
  return [...m].map(([key, n]) => ({ key, n })).sort((a, b) => (a.key === "limit" ? -1 : b.key === "limit" ? 1 : a.key.localeCompare(b.key)));
}

export interface DecisionCut {
  sessionId: string | null;
  /** A `decisionSource` key, or null for every source. */
  source: string | null;
  showArchived: boolean;
}

/**
 * The rows the sheet draws, newest first, and what the cut is hiding — so the
 * sheet can say "n of N" beside the clear button instead of a list that looks
 * shorter than it is for no stated reason.
 */
export function cutDecisions(entries: readonly DecisionLogEntry[], cut: DecisionCut): {
  inScope: DecisionLogEntry[]; shown: DecisionLogEntry[]; archived: number;
} {
  const inScope = entries.filter((e) => !cut.sessionId || e.sessionId === cut.sessionId);
  const bySource = inScope.filter((e) => !cut.source || decisionSource(e) === cut.source);
  const shown = bySource.filter((e) => cut.showArchived || !e.archived).slice().sort((a, b) => b.ts - a.ts);
  return { inScope, shown, archived: bySource.filter((e) => e.archived).length };
}

/** Terminal text as stored (ANSI, carriage returns, box drawing) → readable. */
export function cleanTerm(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
