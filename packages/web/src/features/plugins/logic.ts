/**
 * The plugins feature's pure half — no React, no DOM — so `logic.test.mjs`
 * runs it under `node --test`. What a plugin DECLARED (`PluginManifest`) plus
 * what the host SAYS about it (`PluginView`, `SessionInfo.plugin*`) turned into
 * the rows the phone draws. The phone never runs plugin code: every control
 * here is the app's own, drawn from a declaration.
 */
import { BRAND, cleanPluginValue, pluginMaturity, updatesDue } from "@waterplane/shared";
import { agoText } from "../../format.ts";
import type {
  CatalogEntry, InstalledPlugin, SelfUpdateInfo, UpdateDue, UpdatesRestart, UpdatesStatus, UpdatesTarget,
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

/**
 * What the Settings search finds ONE plugin's section by: its name, id,
 * description, the `use <name>` switch, its field labels and choice labels,
 * and its action labels. The section hides by these under a query
 * (`useNestedShown`), so they are the same words the row is found by.
 */
export function pluginWords(p: PluginView): string {
  const m = p.manifest;
  return [m.name, m.id, m.description ?? "", `use ${m.name}`,
    ...(m.settings ?? []).flatMap((f) => [f.label, ...(f.kind === "choice" ? f.options.map((o) => o.label) : [])]),
    ...(m.actions ?? []).map((a) => a.label)].filter(Boolean).join(" ");
}

/**
 * What the Settings search finds the `plugins` row by, beyond its catalogued
 * words: every installed plugin's `pluginWords` — "sensors" must land on the
 * Mac sensors section.
 */
export function pluginSearchWords(list: readonly PluginView[] | null): string {
  return (list ?? []).map(pluginWords).join(" ");
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

// ── updates: rows, the count, confirms, results (merged from the updates area) ──
//
// **A count on a control is a filter** (CLAUDE.md): the number on the door, the banner and the
// filtered list all come from shared `updatesDue()`. `cutRows` is the list's one use of it, so the
// count and the cut cannot disagree.

/** The org the manager lists. Everything else is "not from waterplane-dev". */
export const ORG = BRAND.githubOrg;


/** Where an installed plugin came from, in words. No catalogue entry means the manager did not install it. */
export function sourceWords(inst: InstalledPlugin | null | undefined, entry: CatalogEntry | null | undefined): string {
  if (!inst || inst.source === "local" || !entry) return "managed by you";
  return entry.fromOrg ? `from ${ORG}` : `from ${entry.url}`;
}

/** An untagged repo (its newest is a branch) says so on its row: R-plugins-030. */
export function untaggedWords(latest: { kind: string; ref: string } | null | undefined): string | null {
  return latest && latest.kind === "branch" ? `untagged, tracks ${latest.ref}` : null;
}

/** The catalogue entry a loaded plugin belongs to, by the id the manager recorded. */
export function entryFor(status: UpdatesStatus | null, pluginId: string): CatalogEntry | null {
  return status?.catalog.find((e) => e.installed?.id === pluginId) ?? null;
}

export interface InstalledRow {
  id: string;
  name: string;
  version: string;
  maturity: { level: string; label: string; meaning: string };
  source: string;
  fromOrg: boolean;
  url: string;
  untagged: string | null;
  /** The due update for this plugin; the update button shows only when this is set. */
  due: Extract<UpdateDue, { kind: "plugin" }> | null;
}

export function installedRows(plugins: readonly PluginView[], status: UpdatesStatus | null): InstalledRow[] {
  const due = updatesDue(status);
  return plugins.map((p) => {
    const entry = entryFor(status, p.manifest.id);
    const d = due.find((x): x is Extract<UpdateDue, { kind: "plugin" }> => x.kind === "plugin" && x.id === p.manifest.id) ?? null;
    return {
      id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
      maturity: pluginMaturity(p.manifest), source: sourceWords(entry?.installed, entry), due: d,
      fromOrg: entry?.fromOrg === true, url: entry?.url ?? "", untagged: untaggedWords(entry?.latest),
    };
  });
}

export interface AvailableRow {
  repo: string;
  name: string;
  description: string;
  maturity: { level: string; label: string; meaning: string };
  ref: string | null;
  /** The host's verdict (URL host + org), never the `repo` label. */
  fromOrg: boolean;
  url: string;
  /** "untagged, tracks main" when the newest is a branch. */
  untagged: string | null;
  /** An install button, or the problems in words (never a dimmed button). */
  action: { kind: "install" } | { kind: "problems"; words: string[] };
}

export function availableRows(status: UpdatesStatus | null): AvailableRow[] {
  return (status?.catalog ?? []).filter((e) => !e.installed).map((e) => ({
    repo: e.repo, name: e.name, description: e.description, fromOrg: e.fromOrg === true, url: e.url, untagged: untaggedWords(e.latest), maturity: pluginMaturity({ maturity: e.maturity }),
    ref: e.latest?.ref ?? null,
    action: e.problems.length > 0 || !e.latest
      ? { kind: "problems" as const, words: e.problems.length > 0 ? e.problems : ["Nothing installable was found in it."] }
      : { kind: "install" as const },
  }));
}

// ── the updates view: rows, the count, the cut ────────────────────────────────

export type UpdateRow = { key: "self" } | { key: string; entry: CatalogEntry };

/** Every row the view can show: waterplane itself, then each catalogue entry (key = its repo). */
export function allRows(status: UpdatesStatus | null): UpdateRow[] {
  if (!status) return [];
  return [{ key: "self" }, ...status.catalog.map((entry) => ({ key: entry.repo, entry }))];
}

export function dueKeys(status: UpdatesStatus | null): Set<string> {
  return new Set(updatesDue(status).map((d) => (d.kind === "self" ? "self" : d.repo)));
}

/** THE count: the number on the door and the banner's trigger. */
export function dueCount(status: UpdatesStatus | null): number {
  return updatesDue(status).length;
}

/** The view's rows. `onlyDue` is the cut a tap on the count opens; its length IS `dueCount`. */
export function cutRows(status: UpdatesStatus | null, onlyDue: boolean): { shown: UpdateRow[]; total: number } {
  const rows = allRows(status);
  if (!onlyDue) return { shown: rows, total: rows.length };
  const keys = dueKeys(status);
  return { shown: rows.filter((r) => keys.has(r.key)), total: rows.length };
}

/** "n of N" for the filtered view. */
export function cutWords(shown: number, total: number): string {
  return `Showing the ${shown} with an update: ${shown} of ${total}`;
}

export function checkedWords(checkedAt: number | undefined, now: number): string {
  return checkedAt === undefined ? "not checked yet" : `checked ${agoText(Math.max(0, now - checkedAt))}`;
}

/** Why "check now" would answer from the cache: "next check possible in 4 min"; null when a check is allowed now. */
export function nextCheckWords(nextCheckAt: number | undefined, now: number): string | null {
  if (nextCheckAt === undefined || nextCheckAt <= now) return null;
  const min = Math.ceil((nextCheckAt - now) / 60_000);
  return min <= 1 ? "next check possible in under a minute" : `next check possible in ${min} min`;
}

// ── waterplane's own row ─────────────────────────────────────────────────────

export interface SelfView {
  headline: string;
  notes: string | null;
  /** Update button: the verifying updater can run AND a newer version exists. */
  showUpdate: boolean;
  showRollback: boolean;
  /** When there is no button: the command to copy and why. */
  command: string | null;
  why: string | null;
}

export function selfView(self: SelfUpdateInfo, status: UpdatesStatus | null): SelfView {
  const due = updatesDue(status).some((d) => d.kind === "self");
  return {
    headline: self.latest && due ? `${self.current} → ${self.latest}` : `${self.current} · up to date`,
    notes: self.notes ? self.notes : null,
    showUpdate: self.canApply && due,
    showRollback: self.canApply && !!self.rollbackTo,
    command: !self.canApply && due ? self.command ?? null : null,
    why: !self.canApply && due ? self.why ?? null : null,
  };
}

// ── confirms ─────────────────────────────────────────────────────────────────

const FULL_ACCESS = "It runs with full access to this desktop.";

/** "from waterplane-dev", or the URL it really is from (never the label) plus a plain "Not from". */
function origin(o: { fromOrg?: boolean; url?: string }): { from: string; not: string } {
  return o.fromOrg === true ? { from: ORG, not: "" } : { from: o.url ?? "outside " + ORG, not: ` Not from ${ORG}.` };
}

export function installConfirm(o: { name: string; ref: string | null; desktop: string; fromOrg?: boolean; url?: string }): string {
  const w = origin(o);
  return `Install ${[o.name, o.ref].filter(Boolean).join(" ")} from ${w.from} on ${o.desktop}?${w.not} ${FULL_ACCESS}`;
}

export function updatePluginConfirm(o: { name: string; from: string | undefined; to: string; desktop: string; fromOrg?: boolean; url?: string }): string {
  const w = origin(o);
  return `Update ${o.name}${o.from ? ` from ${o.from}` : ""} to ${o.to} from ${w.from} on ${o.desktop}?${w.not} ${FULL_ACCESS}`;
}

export function urlConfirm(o: { url: string; desktop: string }): string {
  return `Install the plugin at ${o.url} on ${o.desktop}? Not from ${ORG}. ${FULL_ACCESS}`;
}

export function selfConfirm(o: { desktop: string; current: string; to: string }): string {
  return `Update ${o.desktop} from ${o.current} to ${o.to}? The desktop restarts; sessions keep running.`;
}

export function rollbackConfirm(o: { desktop: string; current: string; to: string }): string {
  return `Roll ${o.desktop} back from ${o.current} to ${o.to}? The desktop restarts; sessions keep running.`;
}

/** What "Add by URL" accepts: an https GitHub-style repo address, nothing else. The host re-checks. */
export function parseUrlInput(raw: string): { ok: true; url: string } | { ok: false; why: string } {
  const s = raw.trim();
  if (!s) return { ok: false, why: "Type the plugin's repository address first." };
  if (!/^https:\/\/[^\s/]+\/\S+$/.test(s)) return { ok: false, why: "That is not an https:// repository address." };
  return { ok: true, url: s };
}

// ── results ──────────────────────────────────────────────────────────────────

/** The sentence a pending apply carries to its `updates.result`: what it was for. */
export function isSelfTarget(t: UpdatesTarget): boolean {
  return t.kind === "self" || t.kind === "self-rollback";
}

/**
 * What a result adds under its verbatim message (host `UpdatesRestart`):
 *  - `restarting`: the daemon is restarting itself now, the link will drop;
 *  - `offer`: a service supervises it, so the `{kind:"restart"}` target works: a button, never a claim;
 *  - `manual`: the person restarts the desktop (the host would refuse the restart target);
 *  - `none`: nothing to say.
 * The "new UI next" line is only for a SELF apply that really swaps the version (`versionChanged`).
 */
export function resultView(r: { ok: boolean; restart: UpdatesRestart }, target: UpdatesTarget | null, versionChanged = false):
  { note: string | null; restartButton: boolean } {
  const notes: string[] = [];
  if (r.restart === "restarting") notes.push("restarting the desktop…");
  if (r.restart === "manual" || r.restart === "offer") notes.push("restart the desktop to load it");
  if (r.ok && versionChanged && !!target && isSelfTarget(target)) notes.push("the phone picks up the new UI next");
  return { note: notes.length ? notes.join(" · ") : null, restartButton: r.restart === "offer" };
}

/** A self apply that answered ok and is restarting the daemon swapped the version; "already newest" does not. */
export function selfSwapped(r: { ok: boolean; restart: UpdatesRestart }): boolean {
  return r.ok && r.restart === "restarting";
}

/** A receipt older than this on a phone that has never seen one is history, not news. */
export const FRESH_RECEIPT_MS = 10 * 60_000;

/**
 * A receipt (`self.lastResult` or `status.lastApply`) the phone has not said yet, keyed on its `at`.
 * With no seen value (a fresh phone) only a recent one counts: an old one is treated as already seen.
 */
export function receiptDue(last: { at: number } | undefined | null, seenAt: number | null, now: number = Date.now()): boolean {
  if (!last) return false;
  if (seenAt === null) return now - last.at <= FRESH_RECEIPT_MS;
  return last.at !== seenAt;
}

export function receiptWords(last: { ok: boolean; message: string }, versionChanged = false): string {
  return last.ok
    ? `${last.message}${versionChanged ? " — the phone picks up the new UI next" : ""}`
    : `Update failed: ${last.message}`;
}

// ── the banner ───────────────────────────────────────────────────────────────

/** A waterplane update is due and not waved away. `dismissed` is the version the person dismissed. */
export function bannerView(status: UpdatesStatus | null, dismissed: string): { show: boolean; text: string; sig: string } {
  const d = updatesDue(status).find((x): x is Extract<UpdateDue, { kind: "self" }> => x.kind === "self");
  if (!d) return { show: false, text: "", sig: "" };
  return { show: dismissed !== d.latest, text: `${BRAND.displayName} ${d.current} → ${d.latest} available`, sig: d.latest };
}

// ── a pending apply ──────────────────────────────────────────────────────────

/** A self update drops the socket and may never answer: past this a pending apply stops claiming to run. */
export const PENDING_MS = 3 * 60_000;

export function applyRunning(a: { pending: boolean; at?: number } | undefined, now: number): boolean {
  return !!a && a.pending && now - (a.at ?? 0) < PENDING_MS;
}
